// Sessions that are running right now under the rpc transport, and therefore
// reachable: pi's rpc mode reads commands from stdin while it works.
//
// This is a directory, not a policy. Nothing here decides to send anything.

import { MAX_SESSIONS } from "../config.ts";
import type { PiHandle } from "../pi-process.ts";
import type { ProgressStatus, ToolResult } from "../types.ts";

export interface LiveRun {
	sessionId: string;
	cwd: string;
	startedAt: number;
	handle: PiHandle;
	status: ProgressStatus;
	lastProgress: string | undefined;
	lastEventAt: number;
	/** Commands the caller sent into this run, for the record. */
	sent: { at: number; type: string }[];
}

/** A non-blocking run remains addressable after its process settles. */
export interface BackgroundRun {
	sessionId: string;
	cwd: string;
	startedAt: number;
	handle: PiHandle | undefined;
	status: ProgressStatus;
	lastProgress: string | undefined;
	lastEventAt: number;
	sent: { at: number; type: string }[];
	result: ToolResult | undefined;
	complete: Promise<ToolResult>;
}

const live = new Map<string, LiveRun>();
const background = new Map<string, BackgroundRun & { resolve: (result: ToolResult) => void }>();

export function registerRun(run: Omit<LiveRun, "sent">): () => void {
	const entry: LiveRun = { ...run, lastProgress: run.lastProgress, sent: [] };
	live.set(run.sessionId, entry);
	const detached = background.get(run.sessionId);
	if (detached !== undefined) detached.handle = run.handle;
	return () => {
		if (live.get(run.sessionId) === entry) live.delete(run.sessionId);
		const detached = background.get(run.sessionId);
		if (detached?.handle === entry.handle) detached.handle = undefined;
	};
}

export function getRun(sessionId: string): LiveRun | undefined {
	return live.get(sessionId);
}

export function listRuns(): LiveRun[] {
	return [...live.values()].sort((a, b) => a.startedAt - b.startedAt);
}

export function registerBackgroundRun(
	run: Omit<BackgroundRun, "complete" | "result" | "resolve" | "sent">,
): BackgroundRun {
	let resolve!: (result: ToolResult) => void;
	const complete = new Promise<ToolResult>((resolveResult) => {
		resolve = resolveResult;
	});
	const entry = { ...run, result: undefined, complete, resolve, sent: [] } as BackgroundRun & {
		resolve: (result: ToolResult) => void;
	};
	background.set(run.sessionId, entry);
	return entry;
}

export function getBackgroundRun(sessionId: string): BackgroundRun | undefined {
	return background.get(sessionId);
}

export function listBackgroundRuns(): BackgroundRun[] {
	return [...background.values()].filter((run) => run.result === undefined).sort((a, b) => a.startedAt - b.startedAt);
}

export function completeBackgroundRun(sessionId: string, result: ToolResult): void {
	const run = background.get(sessionId);
	if (run === undefined || run.result !== undefined) return;
	run.result = result;
	run.handle = undefined;
	run.lastEventAt = Date.now();
	run.resolve(result);
	pruneBackgroundResults();
}

export function forgetBackgroundRun(sessionId: string): void {
	background.delete(sessionId);
}

function pruneBackgroundResults(): void {
	const completed = [...background.entries()]
		.filter(([, run]) => run.result !== undefined)
		.sort(([, a], [, b]) => a.lastEventAt - b.lastEventAt);
	for (const [sessionId] of completed.slice(0, Math.max(0, completed.length - MAX_SESSIONS))) {
		background.delete(sessionId);
	}
}

export function updateRun(sessionId: string, update: { status?: ProgressStatus; message?: string; at?: number }): void {
	const run = live.get(sessionId);
	const detached = background.get(sessionId);
	if (run !== undefined) {
		if (update.status !== undefined) run.status = update.status;
		if (update.message !== undefined) run.lastProgress = update.message;
		run.lastEventAt = update.at ?? Date.now();
	}
	if (detached !== undefined && detached.result === undefined) {
		if (update.status !== undefined) detached.status = update.status;
		if (update.message !== undefined) detached.lastProgress = update.message;
		detached.lastEventAt = update.at ?? Date.now();
	}
}
