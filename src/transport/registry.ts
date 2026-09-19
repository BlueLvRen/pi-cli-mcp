// Sessions that are running right now under the rpc transport, and therefore
// reachable: pi's rpc mode reads commands from stdin while it works.
//
// This is a directory, not a policy. Nothing here decides to send anything.

import type { PiHandle } from "../pi-process.ts";
import type { ProgressStatus } from "../types.ts";

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

const live = new Map<string, LiveRun>();

export function registerRun(run: Omit<LiveRun, "sent">): () => void {
	const entry: LiveRun = { ...run, lastProgress: run.lastProgress, sent: [] };
	live.set(run.sessionId, entry);
	return () => {
		if (live.get(run.sessionId) === entry) live.delete(run.sessionId);
	};
}

export function getRun(sessionId: string): LiveRun | undefined {
	return live.get(sessionId);
}

export function listRuns(): LiveRun[] {
	return [...live.values()].sort((a, b) => a.startedAt - b.startedAt);
}

export function updateRun(sessionId: string, update: { status?: ProgressStatus; message?: string; at?: number }): void {
	const run = live.get(sessionId);
	if (run === undefined) return;
	if (update.status !== undefined) run.status = update.status;
	if (update.message !== undefined) run.lastProgress = update.message;
	run.lastEventAt = update.at ?? Date.now();
}
