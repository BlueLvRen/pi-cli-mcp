// Two ways to drive pi, behind one interface.
//
// `print` runs `pi -p --mode json`: one process per turn, pi exits when it is
// done. Simple, and the default.
//
// `rpc` runs `pi --mode rpc`: the process stays up and takes JSONL commands on
// stdin. That is what makes a running turn reachable — a message can be sent
// into it while it works, which print mode cannot do at all.
//
// This adapter never decides to send anything on its own. It exposes pi's
// commands and the caller chooses if and when to use them.
//
// Both transports emit the same event stream, so everything downstream (the
// accumulator, answer selection, the stats line, failure reporting) is shared.

import type { RunResult } from "../pi-process.ts";
import type { CallContext, RunOverrides } from "../types.ts";

export type TransportName = "print" | "rpc";

export interface RunPlan {
	cwd: string;
	/** pi's `--session-id`: the conversation this turn belongs to. */
	sessionId: string;
	prompt: string;
	overrides: RunOverrides;
	/**
	 * Hard wall clock: pi is killed at this point. Undefined means no deadline
	 * for this run.
	 */
	timeoutMs: number | undefined;
}

export interface Transport {
	readonly name: TransportName;
	/** True when a message can be sent into a turn that is already running. */
	readonly acceptsMidRunMessages: boolean;
	run(plan: RunPlan, ctx: CallContext, onEvent: (event: unknown) => void): Promise<RunResult>;
}
