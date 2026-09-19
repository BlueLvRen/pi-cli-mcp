// A minimal MCP client that drives the real server over stdio, plus the fake pi
// binary the tests point it at.

import { type ChildProcessWithoutNullStreams, execFileSync, spawn } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const SERVER = join(here, "..", "..", "src", "index.ts");
export const FAKE_PI = join(here, "..", "fixtures", "fake-pi.mjs");

/**
 * Node 22 needs a flag to run TypeScript; from 23 onwards type stripping is on
 * by default and the flag is deprecated. CI runs a newer Node than this
 * workstation, so the flag is added only where it is actually required.
 */
const NODE_TS_FLAGS = Number(process.versions.node.split(".")[0] ?? 0) >= 23 ? [] : ["--experimental-strip-types"];

export interface JsonRpcResponse {
	id?: unknown;
	result?: any;
	error?: { code: number; message: string };
	method?: string;
	params?: any;
}

export interface PendingCall {
	id: number;
	promise: Promise<JsonRpcResponse>;
}

/**
 * The server is TypeScript, so tests run it through Node's own TS support. That
 * keeps the tests honest — they exercise src/, not a stale build.
 */
export class Client {
	readonly child: ChildProcessWithoutNullStreams;
	readonly notifications: JsonRpcResponse[] = [];
	private readonly pending = new Map<number, (msg: JsonRpcResponse) => void>();
	private buffer = "";
	private nextId = 1;

	constructor(env: Record<string, string> = {}, cwd: string = process.cwd()) {
		this.child = spawn(process.execPath, [...NODE_TS_FLAGS, SERVER], {
			cwd,
			env: { ...process.env, ...env },
			stdio: ["pipe", "pipe", "pipe"],
		}) as ChildProcessWithoutNullStreams;
		this.child.stdout.setEncoding("utf8");
		this.child.stdout.on("data", (chunk: string) => this.ingest(chunk));
	}

	private ingest(chunk: string): void {
		this.buffer += chunk;
		let newline = this.buffer.indexOf("\n");
		while (newline !== -1) {
			const line = this.buffer.slice(0, newline).trim();
			this.buffer = this.buffer.slice(newline + 1);
			newline = this.buffer.indexOf("\n");
			if (!line) continue;
			const msg = JSON.parse(line) as JsonRpcResponse;
			const resolver = typeof msg.id === "number" ? this.pending.get(msg.id) : undefined;
			if (resolver) {
				this.pending.delete(msg.id as number);
				resolver(msg);
			} else {
				// Notifications, plus protocol errors that carry id: null.
				this.notifications.push(msg);
			}
		}
	}

	send(msg: unknown): void {
		this.child.stdin.write(`${JSON.stringify(msg)}\n`);
	}

	raw(line: string): void {
		this.child.stdin.write(line);
	}

	request(method: string, params?: unknown): PendingCall {
		const id = this.nextId++;
		const promise = new Promise<JsonRpcResponse>((resolve) => this.pending.set(id, resolve));
		this.send({ jsonrpc: "2.0", id, method, params });
		return { id, promise };
	}

	async call(method: string, params?: unknown): Promise<JsonRpcResponse> {
		return this.request(method, params).promise;
	}

	/** Send a hand-built message and await the response for its id. */
	async call2(msg: { id: number } & Record<string, unknown>): Promise<JsonRpcResponse> {
		const promise = new Promise<JsonRpcResponse>((resolve) => this.pending.set(msg.id, resolve));
		this.send(msg);
		return promise;
	}

	async handshake(): Promise<JsonRpcResponse> {
		const init = await this.call("initialize", {
			protocolVersion: "2025-06-18",
			capabilities: {},
			clientInfo: { name: "test", version: "1" },
		});
		this.send({ jsonrpc: "2.0", method: "notifications/initialized" });
		return init;
	}

	async tool(name: string, args: unknown = {}, meta?: unknown): Promise<{ text: string; isError: boolean }> {
		const params: Record<string, unknown> = { name, arguments: args };
		if (meta !== undefined) params._meta = meta;
		const res = await this.call("tools/call", params);
		return { text: res.result?.content?.[0]?.text ?? "", isError: res.result?.isError === true };
	}

	progressNotes(): string[] {
		return this.notifications
			.filter((n) => n.method === "notifications/progress")
			.map((n) => String(n.params?.message ?? ""));
	}

	progressEvents(): JsonRpcResponse[] {
		return this.notifications.filter((n) => n.method === "notifications/progress");
	}

	close(): void {
		this.child.stdin.end();
		if (process.platform === "win32" && this.child.pid !== undefined) {
			try {
				execFileSync("taskkill", ["/PID", String(this.child.pid), "/T", "/F"], { stdio: "ignore" });
			} catch {
				// The server may already have exited after stdin EOF.
			}
			return;
		}
		this.child.kill();
	}
}

/** A shell shim, because the server spawns its pi binary as a plain command. */
export function makeFakeBin(dir: string): string {
	if (process.platform === "win32") {
		const bin = join(dir, "pi.cmd");
		writeFileSync(bin, `@echo off\r\n"${process.execPath}" "${FAKE_PI}" %*\r\n`);
		return bin;
	}
	const bin = join(dir, "pi");
	writeFileSync(bin, `#!/bin/sh\nexec ${process.execPath} ${FAKE_PI} "$@"\n`);
	chmodSync(bin, 0o755);
	return bin;
}

export interface Workspace {
	dir: string;
	bin: string;
	env: Record<string, string>;
	stateFile: string;
	cleanup: () => void;
}

export function makeWorkspace(): Workspace {
	const dir = mkdtempSync(join(tmpdir(), "pi-cli-mcp-test-"));
	const bin = makeFakeBin(dir);
	const stateFile = join(dir, "sessions.json");
	return {
		dir,
		bin,
		stateFile,
		env: { PI_MCP_BIN: bin, PI_MCP_STATE: stateFile },
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	};
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Wait for a condition instead of guessing how long it takes. Test files run in
 * parallel, so a fixed sleep that is comfortable alone is a coin flip under load.
 */
export async function waitFor(
	label: string,
	predicate: () => boolean,
	{ timeoutMs = 10_000, everyMs = 50 }: { timeoutMs?: number; everyMs?: number } = {},
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await sleep(everyMs);
	}
	throw new Error(`timed out after ${timeoutMs}ms waiting for: ${label}`);
}

export function sessionIdOf(text: string): string {
	const match = text.match(/\[session: ([0-9a-f-]{36})\]/);
	if (!match?.[1]) throw new Error(`no session id in: ${text.slice(0, 120)}`);
	return match[1];
}
