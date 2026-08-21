#!/usr/bin/env node
// Minimal stdio MCP server that exposes the locally installed `pi` CLI
// (@earendil-works/pi-coding-agent) as a delegatable sub-agent.
//
// No runtime dependencies: newline-delimited JSON-RPC 2.0 is spoken directly, so
// there is no SDK to keep in sync. pi's own types are used at compile time only
// (see src/types.ts), which keeps the wire contract honest without shipping them.

import { FALLBACK_PROTOCOL, KILL_GRACE_MS, MAX_FRAME, PROTOCOL_VERSIONS, SERVER_INFO } from "./config.ts";
import { killAllTrees, makeCancelToken, treeCount } from "./pi-process.ts";
import { loadSessions } from "./sessions.ts";
import {
	callPi,
	callPiModels,
	callPiReply,
	callPiRunning,
	callPiSend,
	callPiSessions,
	TOOLS,
	toolResult,
} from "./tools.ts";
import type { CallContext, CancelToken, JsonRpcId, JsonRpcMessage, ToolResult } from "./types.ts";

function send(message: unknown): void {
	process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id: JsonRpcId, result: unknown): void {
	send({ jsonrpc: "2.0", id, result });
}

function replyError(id: JsonRpcId, code: number, message: string): void {
	send({ jsonrpc: "2.0", id, error: { code, message } });
}

/**
 * requestId -> cancel token. Registered before the request queues for a slot or
 * a session lock, so a cancellation that arrives while waiting is not lost.
 */
const inFlight = new Map<string, CancelToken>();

/**
 * JSON-RPC ids 1 and "1" are distinct ids; keying by String(id) alone would let
 * them overwrite each other's cancel token.
 */
function requestKey(id: unknown): string {
	return `${typeof id}:${String(id)}`;
}

function makeContext(token: CancelToken, meta: Record<string, unknown> | undefined): CallContext {
	const progressToken = meta?.progressToken;
	let counter = 0;
	if (progressToken === undefined || progressToken === null) return { token };
	return {
		token,
		progress: (message: string) => {
			counter += 1;
			send({
				jsonrpc: "2.0",
				method: "notifications/progress",
				params: { progressToken, progress: counter, message },
			});
		},
	};
}

async function dispatchTool(
	name: unknown,
	args: Record<string, unknown>,
	ctx: CallContext,
): Promise<ToolResult | null> {
	if (name === "pi") return callPi(args, ctx);
	if (name === "pi_reply") return callPiReply(args, ctx);
	if (name === "pi_models") return callPiModels(args, ctx);
	if (name === "pi_send") return callPiSend(args);
	if (name === "pi_running") return callPiRunning();
	if (name === "pi_sessions") return callPiSessions();
	return null;
}

function asRecordParam(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
	return value as Record<string, unknown>;
}

/**
 * A crash in the adapter, not in pi — say so plainly and give a trace that is
 * actually readable: the error class, the message, the frames from our own code,
 * and the cause chain. A one-line `err.stack` dump buries the useful frames
 * under node internals, and swallowing `cause` hides the real failure.
 */
function describeInternalError(err: unknown, tool: string): string {
	const lines = [`pi-mcp internal error while handling \`${tool}\` — this is a bug in the adapter, not in pi.`];

	let current: unknown = err;
	let depth = 0;
	while (current !== null && current !== undefined && depth < 5) {
		const error = current instanceof Error ? current : undefined;
		const label = depth === 0 ? "error" : "caused by";
		if (error === undefined) {
			lines.push(`\n${label}: ${typeof current === "string" ? current : JSON.stringify(current)}`);
			break;
		}

		lines.push(`\n${label}: ${error.name}: ${error.message}`);
		const frames = (error.stack ?? "")
			.split("\n")
			.slice(1)
			.map((line) => line.trim())
			// Our own frames first: node internals and dependency frames say nothing
			// about a defect that lives in this file.
			.filter((line) => line.includes("/pi-cli-mcp/") || line.includes("src/"))
			.slice(0, 8);
		if (frames.length > 0) lines.push(frames.map((f) => `  ${f}`).join("\n"));

		current = error.cause;
		depth += 1;
	}

	return lines.join("\n");
}

async function handle(msg: JsonRpcMessage): Promise<void> {
	// A notification is a request without an `id` member. `id: null` is a
	// (discouraged) real id, not the absence of one.
	const hasId = Object.hasOwn(msg, "id");
	const id = msg.id ?? null;
	const method = msg.method;
	const params = asRecordParam(msg.params);

	if (msg.jsonrpc !== "2.0" || typeof method !== "string") {
		if (hasId) replyError(id, -32600, "Invalid Request");
		return;
	}
	if (hasId && msg.id !== null && typeof msg.id !== "string" && typeof msg.id !== "number") {
		replyError(null, -32600, "Invalid Request: id must be a string, number, or null");
		return;
	}

	switch (method) {
		case "initialize": {
			if (!hasId) return;
			const requested = params.protocolVersion;
			const protocolVersion =
				typeof requested === "string" && (PROTOCOL_VERSIONS as readonly string[]).includes(requested)
					? requested
					: FALLBACK_PROTOCOL;
			reply(id, { protocolVersion, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
			return;
		}

		case "notifications/initialized":
		case "initialized":
			return;

		case "notifications/cancelled": {
			inFlight.get(requestKey(params.requestId))?.cancel();
			return;
		}

		case "ping":
			if (hasId) reply(id, {});
			return;

		case "tools/list":
			if (hasId) reply(id, { tools: TOOLS });
			return;

		case "tools/call": {
			if (!hasId) return;
			const token = makeCancelToken();
			const key = requestKey(msg.id);
			inFlight.set(key, token);
			try {
				const ctx = makeContext(token, asRecordParam(params._meta));
				const result = await dispatchTool(params.name, asRecordParam(params.arguments), ctx);
				if (result === null) replyError(id, -32602, `Unknown tool: ${String(params.name)}`);
				else reply(id, result);
			} catch (err) {
				reply(id, toolResult(describeInternalError(err, String(params.name)), true));
			} finally {
				inFlight.delete(key);
			}
			return;
		}

		default:
			if (hasId) replyError(id, -32601, `Method not found: ${method}`);
	}
}

// --- shutdown -------------------------------------------------------------

// Shutdown must take the detached process groups with it. They are in their own
// groups precisely so we can kill their whole trees — which also means nothing
// else will ever clean them up if this process just exits.
let shuttingDown = false;

function shutdown(reason: string, code = 0): void {
	if (shuttingDown) return;
	shuttingDown = true;
	const trees = treeCount();
	if (trees > 0) {
		process.stderr.write(`pi-mcp: ${reason} — terminating ${trees} running pi process(es)\n`);
		for (const token of inFlight.values()) token.cancel();
		killAllTrees("SIGTERM");
		// Give SIGTERM a moment, then make sure nothing is left behind.
		setTimeout(() => {
			killAllTrees("SIGKILL");
			process.exit(code);
		}, KILL_GRACE_MS).unref();
		return;
	}
	process.exit(code);
}

for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
	process.on(signal, () => shutdown(`received ${signal}`, 0));
}
// A dead stdout means the client is gone; keeping pi alive would strand it.
process.stdout.on("error", (err: NodeJS.ErrnoException) => {
	if (err?.code === "EPIPE") shutdown("stdout closed", 0);
});

// --- stdin loop -----------------------------------------------------------

loadSessions();

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
	buffer += chunk;
	let newline = buffer.indexOf("\n");
	while (newline !== -1) {
		const line = buffer.slice(0, newline).trim();
		buffer = buffer.slice(newline + 1);
		newline = buffer.indexOf("\n");
		if (!line) continue;

		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
			continue;
		}
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			// Valid JSON, but not a Request Object. Batches are not supported.
			send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } });
			continue;
		}

		const msg = parsed as JsonRpcMessage;
		handle(msg).catch((err: unknown) => {
			if (Object.hasOwn(msg, "id")) {
				replyError(msg.id ?? null, -32603, `Internal error: ${(err as Error).message ?? String(err)}`);
			}
		});
	}
	// Refuse an unbounded frame rather than growing until the process dies and
	// every pending response is lost with it.
	if (buffer.length > MAX_FRAME) {
		buffer = "";
		send({
			jsonrpc: "2.0",
			id: null,
			error: { code: -32600, message: `Invalid Request: frame exceeded ${MAX_FRAME} chars` },
		});
	}
});
process.stdin.on("end", () => shutdown("stdin closed", 0));
