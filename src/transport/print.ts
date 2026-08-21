// `pi -p --mode json`: one process per turn, pi exits when the turn is done.

import type { RunResult } from "../pi-process.ts";
import { runPi } from "../pi-process.ts";
import type { CallContext } from "../types.ts";
import { overrideArgs, promptArgs } from "./args.ts";
import type { RunPlan, Transport } from "./types.ts";

export const printTransport: Transport = {
	name: "print",
	acceptsMidRunMessages: false,

	async run(plan: RunPlan, ctx: CallContext, onEvent: (event: unknown) => void): Promise<RunResult> {
		const { args: tail, cleanup } = promptArgs(plan.prompt);
		const args = ["-p", "--mode", "json", "--session-id", plan.sessionId, ...overrideArgs(plan.overrides), ...tail];
		try {
			return await runPi(args, plan.cwd, {
				token: ctx.token,
				timeoutMs: plan.timeoutMs,
				onEvent,
			});
		} finally {
			cleanup();
		}
	},
};
