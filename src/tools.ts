// Tool schemas and their implementations.

import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import type { Accumulator } from "./answer.ts";
import {
	accumulate,
	answerProblem,
	clip,
	newAccumulator,
	renderFailure,
	selectAnswer,
	summarize,
	tailStderr,
} from "./answer.ts";
import { DEFAULT_MODEL, DEFAULT_THINKING, MAX_PROMPT, MAX_TIMEOUT_MS, TIMEOUT_MS } from "./config.ts";
import type { RunResult } from "./pi-process.ts";
import { runPi, withSlot } from "./pi-process.ts";
import { getSession, listSessions, rememberSession, withSessionLock } from "./sessions.ts";
import type { RunPlan, Transport } from "./transport/index.ts";
import { getRun, listRuns, resolveTransport, TRANSPORT_NAMES } from "./transport/index.ts";
import type { CallContext, RunOverrides, ThinkingLevel, ToolDefinition, ToolResult } from "./types.ts";
import { isThinkingLevel, THINKING_LEVELS } from "./types.ts";

// --- schemas --------------------------------------------------------------

const SHARED_PROPS = {
	model: {
		type: "string",
		description:
			"Model pattern or id, e.g. 'bifrost/minimax/MiniMax-M3', 'sonnet', 'provider/id:thinking'. " +
			"Defaults to your pi settings.",
	},
	thinking: {
		type: "string",
		enum: THINKING_LEVELS,
		description: "Thinking level. Defaults to your pi settings.",
	},
	transport: {
		type: "string",
		enum: TRANSPORT_NAMES,
		description:
			"How to drive pi. 'print' (default) runs one process per turn. 'rpc' keeps pi up and lets " +
			"pi_send deliver a message into the turn while it runs.",
	},
	timeout_ms: {
		type: "integer",
		minimum: 1000,
		description:
			"Wall clock for this run before pi is killed. Set it from the task, not from habit: a run " +
			"killed at the deadline still returns its session id and what pi did, so a long task can be " +
			"continued with pi_reply rather than restarted.",
	},
} as const;

export const TOOLS: ToolDefinition[] = [
	{
		name: "pi",
		description:
			"Delegate a task to the local pi agent — a separate CLI coding agent with its own " +
			"read/bash/edit/write tools and its own context window. Runs non-interactively and returns " +
			"pi's final answer prefixed with [session: <id>] for follow-ups via pi_reply.\n" +
			"Good for: a second opinion from a different model, work you want kept out of this context, " +
			"or parallel investigation.\n" +
			"Caution: pi has no permission system. With its default tools it can edit files and run " +
			"shell commands as your user inside `cwd`. Pass `tools` or `no_tools` to restrict it.",
		inputSchema: {
			type: "object",
			properties: {
				prompt: {
					type: "string",
					description:
						"The task for pi. Must be self-contained — pi cannot see this conversation. State the " +
						"files, the goal, and the expected output format.",
				},
				cwd: {
					type: "string",
					description:
						"Absolute working directory. Defaults to this server's cwd. pi reads AGENTS.md / " +
						"CLAUDE.md from here.",
				},
				...SHARED_PROPS,
				tools: {
					type: "string",
					description:
						"Comma-separated allowlist of pi tool names, e.g. 'read,grep,ls' for a read-only run. " +
						"Omit to keep pi's default set (includes bash/edit/write).",
				},
				no_tools: {
					type: "boolean",
					description: "Disable all pi tools — pure reasoning over the prompt text.",
				},
				system_prompt_append: {
					type: "string",
					description: "Extra text appended to pi's system prompt for this run.",
				},
			},
			required: ["prompt"],
			additionalProperties: false,
		},
	},
	{
		name: "pi_reply",
		description:
			"Continue an existing pi session. Pass the id returned as [session: <id>]. pi still has the " +
			"prior turns, so the follow-up can be short. Sessions live in pi's own session files and " +
			"survive restarts of this server.",
		inputSchema: {
			type: "object",
			properties: {
				session: { type: "string", description: "Session id from a previous pi call." },
				prompt: { type: "string", description: "Follow-up message." },
				cwd: {
					type: "string",
					description: "Override the working directory. Defaults to where the session started.",
				},
				...SHARED_PROPS,
			},
			required: ["session", "prompt"],
			additionalProperties: false,
		},
	},
	{
		name: "pi_models",
		description:
			"List the models pi can actually reach, as a table of provider, model id, context window, " +
			"max output, thinking and image support. Read from the live catalog, so it reflects what is " +
			"configured right now rather than any documented list. Use it to pick a value for the " +
			"`model` argument of `pi`.",
		inputSchema: {
			type: "object",
			properties: {
				search: {
					type: "string",
					description: "Optional fuzzy filter, e.g. 'glm', 'deepseek', 'minimax'.",
				},
			},
			additionalProperties: false,
		},
	},
	{
		name: "pi_send",
		description:
			"Send a message into a pi turn that is running right now. Only possible for runs started " +
			"with transport 'rpc' — in 'print' mode pi reads nothing while it works.\n" +
			"`steer` interrupts the current turn with the message; `follow_up` queues it for after the " +
			"turn finishes; `abort` stops the turn. These are pi's own rpc commands, passed through " +
			"unchanged — this server never sends anything on its own initiative.\n" +
			"Use `pi_running` to see which sessions can be reached.",
		inputSchema: {
			type: "object",
			properties: {
				session: {
					type: "string",
					description: "Session id of the running turn, as returned by `pi` or `pi_reply`.",
				},
				message: {
					type: "string",
					description: "Text to send. Required for 'steer' and 'follow_up', ignored by 'abort'.",
				},
				command: {
					type: "string",
					enum: ["steer", "follow_up", "abort"],
					description: "Which pi rpc command to send. Defaults to 'steer'.",
				},
			},
			required: ["session"],
			additionalProperties: false,
		},
	},
	{
		name: "pi_running",
		description:
			"List pi turns that are executing right now, with their session id, working directory, how " +
			"long they have been going, and any messages already sent into them. Only rpc-transport runs " +
			"appear, because only those can be reached mid-run.",
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
	},
	{
		name: "pi_sessions",
		description:
			"List pi sessions started through this server, newest first, with their working directory. " +
			"Use it to find an id for pi_reply when it has scrolled out of context.",
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
	},
];

// --- helpers --------------------------------------------------------------

export function toolResult(text: string, isError = false): ToolResult {
	return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

function resolveCwd(requested: unknown): string {
	if (requested === undefined || requested === null || requested === "") return process.cwd();
	if (typeof requested !== "string") throw new Error("cwd must be a string");
	if (!requested.startsWith("/")) throw new Error(`cwd must be an absolute path: ${requested}`);
	if (!existsSync(requested) || !statSync(requested).isDirectory()) {
		throw new Error(`cwd does not exist or is not a directory: ${requested}`);
	}
	return requested;
}

function readTimeout(value: unknown): number | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value) || value < 1000) {
		throw new Error("timeout_ms must be a number of milliseconds, at least 1000");
	}
	if (value > MAX_TIMEOUT_MS) {
		throw new Error(`timeout_ms ${value} exceeds the server ceiling of ${MAX_TIMEOUT_MS} ms`);
	}
	return value;
}

function readOverrides(input: Record<string, unknown>): RunOverrides {
	const overrides: RunOverrides = {};
	const model = input.model ?? DEFAULT_MODEL;
	if (model !== undefined && model !== null) {
		if (typeof model !== "string") throw new Error("model must be a string");
		overrides.model = model;
	}
	const thinking = input.thinking ?? DEFAULT_THINKING;
	if (thinking !== undefined && thinking !== null) {
		if (!isThinkingLevel(thinking)) {
			throw new Error(`invalid thinking level "${String(thinking)}"; expected one of ${THINKING_LEVELS.join(", ")}`);
		}
		overrides.thinking = thinking;
	}
	if (input.no_tools === true) {
		overrides.no_tools = true;
	} else if (input.tools !== undefined && input.tools !== null) {
		if (typeof input.tools !== "string") throw new Error("tools must be a comma-separated string");
		overrides.tools = input.tools;
	}
	if (input.system_prompt_append !== undefined && input.system_prompt_append !== null) {
		if (typeof input.system_prompt_append !== "string") {
			throw new Error("system_prompt_append must be a string");
		}
		overrides.system_prompt_append = input.system_prompt_append;
	}
	return overrides;
}

function readPrompt(value: unknown, tool: string): string {
	if (typeof value !== "string" || value.trim() === "") {
		throw new Error(`${tool}: \`prompt\` is required and must be a non-empty string.`);
	}
	if (value.length > MAX_PROMPT) {
		throw new Error(
			`${tool}: prompt is ${value.length} chars, over the ${MAX_PROMPT} limit. ` +
				"Write it to a file and point pi at the path instead.",
		);
	}
	return value;
}

interface Outcome {
	acc: Accumulator;
	result: RunResult;
	elapsedMs: number;
}

async function invokePi(transport: Transport, plan: RunPlan, ctx: CallContext): Promise<Outcome> {
	const acc = newAccumulator();
	const started = Date.now();
	const result = await transport.run(plan, ctx, (event) => {
		const note = accumulate(acc, event);
		if (note && ctx.progress) ctx.progress(note);
	});
	return { acc, result, elapsedMs: Date.now() - started };
}

function renderSuccess(outcome: Outcome, prefix: string | null): ToolResult {
	const { acc, result, elapsedMs } = outcome;
	const answer = selectAnswer(acc);
	const problem = answerProblem(answer);
	const warnings = tailStderr(result.stderr);
	const parts: string[] = [];
	if (prefix) parts.push(prefix);
	// pi can exit 0 on a turn that did not actually settle cleanly, so the answer
	// is still returned but the call is reported as failed.
	if (problem) parts.push(`[warning: ${problem} — the answer below may be incomplete]`);
	if (warnings) parts.push(`[pi stderr: ${warnings}]`);

	if (answer.text) {
		parts.push(clip(answer.text));
	} else {
		// Never fall back to raw stdout: that is the whole NDJSON transcript,
		// including narration, tool arguments and tool results. Returning it as an
		// answer would break the one contract this server makes. Describe the shape
		// of what arrived instead — enough to debug, with no transcript content.
		const reasons = [...new Set(acc.messages.map((m) => m.stopReason ?? "none"))].join(", ");
		parts.push(
			"pi returned no usable answer text: its event stream did not match the " +
				"expected `--mode json` contract.\n" +
				`assistant messages seen: ${acc.messages.length}` +
				(acc.messages.length ? ` (stopReason: ${reasons})` : "") +
				`, tool calls: ${acc.toolCalls.length}, raw stdout: ${result.stdout.length} chars`,
		);
	}

	parts.push(`---\n${summarize(acc, elapsedMs)}`);
	return toolResult(parts.join("\n\n"), Boolean(problem));
}

// --- tools ----------------------------------------------------------------

export async function callPi(input: Record<string, unknown>, ctx: CallContext): Promise<ToolResult> {
	let prompt: string;
	let cwd: string;
	let overrides: RunOverrides;
	let timeoutMs: number | undefined;
	let transport: Transport;
	try {
		prompt = readPrompt(input.prompt, "pi");
		cwd = resolveCwd(input.cwd);
		overrides = readOverrides(input);
		timeoutMs = readTimeout(input.timeout_ms);
		transport = resolveTransport(input.transport);
	} catch (err) {
		return toolResult(`pi: ${(err as Error).message}`.replace("pi: pi:", "pi:"), true);
	}

	const sessionId = randomUUID();
	// Recorded before the run, not after: a run that times out or is cancelled is
	// still a real session on disk, and pi_reply needs to know its directory to
	// resume it. Remembering only on success is how a killed task becomes
	// unreachable.
	rememberSession(sessionId, cwd, { model: overrides.model, thinking: overrides.thinking });

	const plan: RunPlan = { cwd, sessionId, prompt, overrides, timeoutMs: timeoutMs ?? TIMEOUT_MS };
	const outcome = await withSlot(() => invokePi(transport, plan, ctx));

	// A turn ended by abort exits cleanly, so the exit code alone would report a
	// timed-out or cancelled run as a normal answer. The flags are what say the
	// run was ended from outside rather than finished.
	if (outcome.result.code !== 0 || outcome.result.timedOut || outcome.result.cancelled) {
		return toolResult(
			renderFailure(outcome.acc, outcome.result, outcome.elapsedMs, {
				id: sessionId,
				tool: "pi",
				timeoutMs: timeoutMs ?? TIMEOUT_MS,
			}),
			true,
		);
	}

	return renderSuccess(outcome, `[session: ${sessionId}]`);
}

export async function callPiReply(input: Record<string, unknown>, ctx: CallContext): Promise<ToolResult> {
	const session = input.session;
	if (typeof session !== "string" || session.trim() === "") {
		return toolResult("pi_reply: `session` is required.", true);
	}

	const known = getSession(session);
	let prompt: string;
	let cwd: string;
	let overrides: RunOverrides;
	let timeoutMs: number | undefined;
	let transport: Transport;
	try {
		prompt = readPrompt(input.prompt, "pi_reply");
		cwd = resolveCwd(input.cwd ?? known?.cwd);
		overrides = readOverrides({
			...input,
			model: input.model ?? known?.model,
			thinking: input.thinking ?? known?.thinking,
		});
		timeoutMs = readTimeout(input.timeout_ms);
		transport = resolveTransport(input.transport);
	} catch (err) {
		return toolResult(`pi_reply: ${(err as Error).message}`.replace("pi_reply: pi_reply:", "pi_reply:"), true);
	}

	const plan: RunPlan = { cwd, sessionId: session, prompt, overrides, timeoutMs: timeoutMs ?? TIMEOUT_MS };
	const outcome = await withSessionLock(session, () => withSlot(() => invokePi(transport, plan, ctx)));

	// A turn ended by abort exits cleanly, so the exit code alone would report a
	// timed-out or cancelled run as a normal answer. The flags are what say the
	// run was ended from outside rather than finished.
	if (outcome.result.code !== 0 || outcome.result.timedOut || outcome.result.cancelled) {
		// Keep the session current even on failure: the conversation on disk grew,
		// and the next attempt should resume in the same place.
		rememberSession(session, cwd, {});
		return toolResult(
			renderFailure(outcome.acc, outcome.result, outcome.elapsedMs, {
				id: session,
				tool: "pi_reply",
				timeoutMs: timeoutMs ?? TIMEOUT_MS,
			}),
			true,
		);
	}

	// pi creates a session when the id is unknown, so warn instead of silently
	// starting a fresh conversation the caller believes is a continuation.
	const isNew = /No project session found with id/i.test(outcome.result.stderr);
	const remembered: { model?: string; thinking?: ThinkingLevel } = {};
	if (input.model !== undefined && overrides.model !== undefined) remembered.model = overrides.model;
	if (input.thinking !== undefined && overrides.thinking !== undefined) remembered.thinking = overrides.thinking;
	rememberSession(session, cwd, remembered);

	const prefix = isNew
		? `[warning: no existing session ${session} in ${cwd} — pi started a new one, so there is no prior context]`
		: null;
	return renderSuccess(outcome, prefix);
}

/** Utility flag, not an agent run: no session, no json stream, no accumulator. */
export async function callPiModels(input: Record<string, unknown>, ctx: CallContext): Promise<ToolResult> {
	const search = input.search;
	if (search !== undefined && typeof search !== "string") {
		return toolResult("pi_models: `search` must be a string.", true);
	}
	const args = ["--list-models", ...(search ? [search] : [])];
	const result = await withSlot(() => runPi(args, process.cwd(), { token: ctx.token }));
	if (result.cancelled) return toolResult("pi_models was cancelled.", true);
	if (result.code !== 0) {
		return toolResult(`pi --list-models exited with code ${result.code}.\n\n${tailStderr(result.stderr)}`, true);
	}
	const table = result.stdout.trim();
	if (!table) {
		return toolResult(search ? `No pi models match "${search}".` : "pi reported no available models.", true);
	}
	return toolResult(table);
}

/**
 * Pass one of pi's rpc commands into a running turn. The decision to send, what
 * to send, and when, all belong to the caller; this only carries the message.
 */
export function callPiSend(input: Record<string, unknown>): ToolResult {
	const session = input.session;
	if (typeof session !== "string" || session.trim() === "") {
		return toolResult("pi_send: `session` is required.", true);
	}

	const command = input.command ?? "steer";
	if (command !== "steer" && command !== "follow_up" && command !== "abort") {
		return toolResult(`pi_send: \`command\` must be steer, follow_up, or abort (got ${String(command)}).`, true);
	}

	const message = input.message;
	if (command !== "abort" && (typeof message !== "string" || message.trim() === "")) {
		return toolResult(`pi_send: \`message\` is required for ${command}.`, true);
	}
	if (message !== undefined && typeof message !== "string") {
		return toolResult("pi_send: `message` must be a string.", true);
	}

	const run = getRun(session);
	if (run === undefined) {
		const alive = listRuns();
		const hint =
			alive.length === 0
				? "No pi turn is running under the rpc transport right now."
				: `Running sessions: ${alive.map((r) => r.sessionId).join(", ")}.`;
		return toolResult(
			`pi_send: session ${session} is not currently running, so there is nothing to send to. ${hint}\n` +
				"A finished session is continued with pi_reply instead. Only runs started with " +
				"transport 'rpc' can be reached mid-run.",
			true,
		);
	}

	run.handle.send(command === "abort" ? { type: "abort" } : { type: command, message });
	run.sent.push({ at: Date.now(), type: String(command) });

	const elapsed = ((Date.now() - run.startedAt) / 1000).toFixed(1);
	return toolResult(
		`Sent ${command} to session ${session} (running for ${elapsed}s).\n` +
			"pi decides when to act on it; the result appears in the answer of the call that is still " +
			"waiting on this turn.",
	);
}

export function callPiRunning(): ToolResult {
	const runs = listRuns();
	if (runs.length === 0) {
		return toolResult(
			"No pi turn is running under the rpc transport. Runs started with transport 'print' do not " +
				"appear here — pi reads nothing while it works in that mode.",
		);
	}
	const rows = runs.map((run) => {
		const elapsed = ((Date.now() - run.startedAt) / 1000).toFixed(1);
		const sent = run.sent.length > 0 ? ` sent: ${run.sent.map((s) => s.type).join(",")}` : "";
		return `${run.sessionId}  ${elapsed}s  ${run.cwd}${sent}`;
	});
	return toolResult(`${rows.length} running:\n\n${rows.join("\n")}`);
}

export function callPiSessions(): ToolResult {
	const rows = listSessions().map(([id, entry]) => {
		const when = entry.lastAccessed ? new Date(entry.lastAccessed).toISOString() : "unknown";
		return `${id}  ${when}  ${entry.cwd}`;
	});
	if (rows.length === 0) {
		return toolResult("No pi sessions recorded yet. Start one with the `pi` tool.");
	}
	return toolResult(`${rows.length} session(s), newest first:\n\n${rows.join("\n")}`);
}
