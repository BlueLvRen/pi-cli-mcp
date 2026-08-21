// Spawning pi, and the lifecycle guarantees around it: timeouts, cancellation,
// and never leaving a process behind.

import { spawn } from "node:child_process";
import { KILL_GRACE_MS, MAX_CAPTURE, MAX_CONCURRENT, MAX_LINE, PI_BIN, PI_WRAP, TIMEOUT_MS } from "./config.ts";
import type { CancelToken } from "./types.ts";

export interface RunResult {
	code: number;
	stdout: string;
	stderr: string;
	timedOut?: boolean;
	cancelled?: boolean;
}

export interface RunOptions {
	/** Called for each parsed JSON line of pi's `--mode json` stream. */
	onEvent?: (event: unknown) => void;
	token?: CancelToken | undefined;
	/** Overrides the default wall clock for this run. */
	timeoutMs?: number | undefined;
}

/**
 * Live children, so shutdown can take their whole process groups with it.
 * Detached children do not die with this process on their own.
 */
const liveTrees = new Set<(signal: NodeJS.Signals) => void>();

export function treeCount(): number {
	return liveTrees.size;
}

export function killAllTrees(signal: NodeJS.Signals): void {
	for (const tree of [...liveTrees]) tree(signal);
}

export function makeCancelToken(): CancelToken {
	const listeners = new Set<() => void>();
	let cancelled = false;
	return {
		get cancelled() {
			return cancelled;
		},
		subscribe(fn: () => void) {
			if (cancelled) {
				fn();
				return () => {};
			}
			listeners.add(fn);
			return () => {
				listeners.delete(fn);
			};
		},
		cancel() {
			if (cancelled) return;
			cancelled = true;
			for (const fn of listeners) {
				try {
					fn();
				} catch (err) {
					process.stderr.write(`pi-mcp: cancel listener failed: ${(err as Error).message}\n`);
				}
			}
			listeners.clear();
		},
	};
}

// --- concurrency ----------------------------------------------------------

let running = 0;
const waiting: (() => void)[] = [];

/** pi runs are heavy and the client may fan out, so cap how many run at once. */
export async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
	if (running >= MAX_CONCURRENT) {
		await new Promise<void>((resolve) => {
			waiting.push(resolve);
		});
	}
	running += 1;
	try {
		return await fn();
	} finally {
		running -= 1;
		waiting.shift()?.();
	}
}

// --- running pi -----------------------------------------------------------

function buildCommand(args: string[]): { command: string; argv: string[] } {
	if (!PI_WRAP) return { command: PI_BIN, argv: args };
	const parts = PI_WRAP.split(/\s+/);
	const [command, ...prefix] = parts;
	return { command: command ?? PI_BIN, argv: [...prefix, PI_BIN, ...args] };
}

function appendCapped(current: string, chunk: string): string {
	if (current.length >= MAX_CAPTURE) return current;
	return current + chunk.slice(0, MAX_CAPTURE - current.length);
}

/**
 * Runs pi, streaming `--mode json` events to onEvent. Resolves with the raw
 * capture plus exit status; never rejects.
 */
export function runPi(args: string[], cwd: string, options: RunOptions = {}): Promise<RunResult> {
	const { onEvent, token } = options;
	const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;

	return new Promise<RunResult>((resolve) => {
		// Cancelled while queued for a slot or a session lock: never start pi.
		if (token?.cancelled) {
			resolve({ code: -1, stdout: "", stderr: "", cancelled: true });
			return;
		}

		const { command, argv } = buildCommand(args);
		let child: ReturnType<typeof spawn>;
		try {
			// `detached` puts pi in its own process group so a timeout or cancel can
			// kill the whole tree. Without it, anything pi spawned (a `sleep`, a test
			// runner, a dev server) survives as an orphan when pi does not forward
			// the signal itself.
			child = spawn(command, argv, {
				cwd,
				stdio: ["ignore", "pipe", "pipe"],
				env: process.env,
				detached: true,
			});
		} catch (err) {
			resolve({ code: -1, stdout: "", stderr: `failed to spawn ${command}: ${(err as Error).message}` });
			return;
		}

		let stdout = "";
		let stderr = "";
		let pending = "";
		let timedOut = false;
		let cancelled = false;
		let killTimer: NodeJS.Timeout | undefined;

		// Signal the whole process group; fall back to the single child if the group
		// is already gone (ESRCH) or the platform refuses the negative pid.
		const signalTree = (signal: NodeJS.Signals): void => {
			try {
				if (child.pid !== undefined) process.kill(-child.pid, signal);
			} catch {
				try {
					child.kill(signal);
				} catch {
					// Already dead — nothing to do.
				}
			}
		};

		const stop = (reason: "timeout" | "cancelled"): void => {
			if (reason === "timeout") timedOut = true;
			if (reason === "cancelled") cancelled = true;
			signalTree("SIGTERM");
			killTimer ??= setTimeout(() => signalTree("SIGKILL"), KILL_GRACE_MS);
		};

		liveTrees.add(signalTree);
		const timer = setTimeout(() => stop("timeout"), timeoutMs);
		const unsubscribe = token?.subscribe(() => stop("cancelled")) ?? ((): void => {});

		const consumeLine = (line: string): void => {
			const trimmed = line.trim();
			if (!trimmed || !onEvent) return;
			try {
				onEvent(JSON.parse(trimmed));
			} catch {
				// Not a JSON event line — the raw capture keeps it for diagnostics.
			}
		};

		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");

		child.stdout?.on("data", (chunk: string) => {
			stdout = appendCapped(stdout, chunk);
			if (!onEvent) return;
			pending += chunk;
			let newline = pending.indexOf("\n");
			while (newline !== -1) {
				consumeLine(pending.slice(0, newline));
				pending = pending.slice(newline + 1);
				newline = pending.indexOf("\n");
			}
			// A single unterminated line must not grow without bound; MAX_CAPTURE
			// guards the transcript copy, not the line being assembled here.
			if (pending.length > MAX_LINE) {
				process.stderr.write(`pi-mcp: dropping an over-long event line (${pending.length} > ${MAX_LINE} chars)\n`);
				pending = "";
			}
		});

		child.stderr?.on("data", (chunk: string) => {
			stderr = appendCapped(stderr, chunk);
		});

		const finish = (result: RunResult): void => {
			clearTimeout(timer);
			if (killTimer) clearTimeout(killTimer);
			liveTrees.delete(signalTree);
			unsubscribe();
			// pi may end its last event at EOF instead of a newline; without this the
			// final answer would be missed and the run would look contract-broken.
			if (pending) {
				consumeLine(pending);
				pending = "";
			}
			resolve(result);
		};

		child.on("error", (err: Error) => {
			finish({ code: -1, stdout, stderr: `${stderr}\n${command}: ${err.message}`.trim() });
		});
		child.on("close", (code: number | null) => {
			finish({ code: code ?? -1, stdout, stderr, timedOut, cancelled });
		});
	});
}
