// Spawning pi, and the lifecycle guarantees around it: timeouts, cancellation,
// and never leaving a process behind.

import { spawn } from "node:child_process";
import {
	ABORT_GRACE_MS,
	KILL_GRACE_MS,
	MAX_CAPTURE,
	MAX_CONCURRENT,
	MAX_LINE,
	PI_BIN,
	PI_WRAP,
	TIMEOUT_MS,
} from "./config.ts";
import type { CancelToken } from "./types.ts";

export interface RunResult {
	code: number;
	stdout: string;
	stderr: string;
	timedOut?: boolean;
	cancelled?: boolean;
	/**
	 * How an interrupted run actually ended: `abort` means the transport closed
	 * the turn in-protocol and pi exited on its own, `signal` means it had to be
	 * killed. Only set when the run was interrupted.
	 */
	endedBy?: "abort" | "signal";
}

/** Writing side of a running pi process, for transports that talk back. */
export interface PiHandle {
	/** Send one JSONL command on stdin. No-op once the process is gone. */
	send(command: unknown): void;
	/** Close stdin, which is how pi's rpc mode is asked to shut down. */
	endInput(): void;
}

export interface RunOptions {
	/** Called for each parsed JSON line of pi's stdout stream. */
	onEvent?: (event: unknown) => void;
	token?: CancelToken | undefined;
	/** Overrides the default wall clock for this run. */
	timeoutMs?: number | undefined;
	/**
	 * Open stdin as a pipe and hand the caller a writer. Print mode leaves stdin
	 * closed; rpc mode needs it to send commands.
	 */
	onStart?: (handle: PiHandle) => void;
	stdin?: "ignore" | "pipe";
	/**
	 * Asked first when a run has to end early, before any signal is sent.
	 *
	 * It exists because pi skips `flushRawStdout()` on SIGTERM (see its
	 * rpc-mode.ts), so signalling can cost the tail of the event stream — possibly
	 * the answer pi was in the middle of writing. A transport that can end the
	 * turn in-protocol gets ABORT_GRACE_MS to do so; signals follow either way.
	 */
	gracefulStop?: (reason: "timeout" | "cancelled") => void;
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
				stdio: [options.stdin ?? "ignore", "pipe", "pipe"],
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
		let gracefulTimer: NodeJS.Timeout | undefined;
		let endedBy: "abort" | "signal" | undefined;

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

		const hardStop = (): void => {
			endedBy = "signal";
			signalTree("SIGTERM");
			killTimer ??= setTimeout(() => signalTree("SIGKILL"), KILL_GRACE_MS);
		};

		let stopping = false;
		const stop = (reason: "timeout" | "cancelled"): void => {
			if (stopping) return;
			stopping = true;
			if (reason === "timeout") timedOut = true;
			if (reason === "cancelled") cancelled = true;

			// Ask in-protocol first when the transport can: pi then closes the turn
			// through its normal path and the events — including whatever it was
			// writing — actually arrive. Signals are the fallback, not the opener.
			if (options.gracefulStop) {
				endedBy = "abort";
				options.gracefulStop(reason);
				gracefulTimer = setTimeout(hardStop, ABORT_GRACE_MS);
				return;
			}
			hardStop();
		};

		liveTrees.add(signalTree);
		const timer = setTimeout(() => stop("timeout"), timeoutMs);
		const unsubscribe = token?.subscribe(() => stop("cancelled")) ?? ((): void => {});

		if (options.onStart) {
			options.onStart({
				send: (payload: unknown) => {
					// A closed or dead stdin is not an error here: the run may have
					// settled or been killed between deciding to write and writing.
					if (child.stdin === null || child.stdin.destroyed || child.stdin.writableEnded) return;
					child.stdin.write(`${JSON.stringify(payload)}\n`, (err) => {
						if (err) process.stderr.write(`pi-mcp: could not write to pi stdin: ${err.message}\n`);
					});
				},
				endInput: () => {
					if (child.stdin === null || child.stdin.writableEnded) return;
					child.stdin.end();
				},
			});
		}

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
			if (gracefulTimer) clearTimeout(gracefulTimer);
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
			finish({ code: code ?? -1, stdout, stderr, timedOut, cancelled, ...(endedBy ? { endedBy } : {}) });
		});
	});
}
