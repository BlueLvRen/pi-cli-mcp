// `pi --mode rpc`: pi stays up and reads JSONL commands on stdin.
//
// The turn is driven by three protocol facts, all from pi's rpc-types.ts:
//   - `{type:"prompt", message}` starts it;
//   - the event stream is the same one `--mode json` emits;
//   - `agent_settled` marks the end of the turn, and closing stdin shuts pi down.
//
// While the turn runs it is registered as live, so a caller can send a message
// into it. Sending is always the caller's decision — nothing is sent from here.

import type { PiHandle, RunResult } from "../pi-process.ts";
import { runPi } from "../pi-process.ts";
import type { CallContext } from "../types.ts";
import { overrideArgs } from "./args.ts";
import { registerRun, updateRun } from "./registry.ts";
import type { RunPlan, Transport } from "./types.ts";

export const rpcTransport: Transport = {
	name: "rpc",
	acceptsMidRunMessages: true,

	async run(plan: RunPlan, ctx: CallContext, onEvent: (event: unknown) => void): Promise<RunResult> {
		// The prompt travels inside a command, so neither argv size nor a leading
		// dash is a problem here — no temp file needed.
		const args = ["--mode", "rpc", "--session-id", plan.sessionId, ...overrideArgs(plan.overrides)];

		let handle: PiHandle | undefined;
		let unregister = (): void => {};
		let settled = false;

		return runPi(args, plan.cwd, {
			token: ctx.token,
			timeoutMs: plan.timeoutMs,
			stdin: "pipe",
			// A deadline or a cancellation ends the turn with pi's own `abort` first.
			// Signalling straight away costs the tail of the stream: pi deliberately
			// skips its stdout flush on SIGTERM, so the answer it was writing can be
			// lost. After `abort` the turn closes through the normal path and the
			// events arrive; SIGTERM/SIGKILL still follow if it does not.
			gracefulStop: () => {
				updateRun(plan.sessionId, { status: "stopping" });
				handle?.send({ type: "abort" });
			},
			onStart: (piHandle) => {
				handle = piHandle;
				unregister = registerRun({
					sessionId: plan.sessionId,
					cwd: plan.cwd,
					startedAt: Date.now(),
					handle: piHandle,
					status: "running",
					lastProgress: "pi started",
					lastEventAt: Date.now(),
				});
				piHandle.send({
					type: "prompt",
					message: plan.prompt,
					...(plan.images?.length ? { images: plan.images } : {}),
				});
			},
			onEvent: (event) => {
				onEvent(event);
				if (isSettled(event)) updateRun(plan.sessionId, { status: "settling", message: "settling final answer" });
				// `agent_settled` is pi's end-of-turn marker. Closing stdin is how its
				// rpc mode is asked to exit; without it the process would sit idle
				// until the hard deadline.
				if (!settled && isSettled(event)) {
					settled = true;
					unregister();
					handle?.endInput();
				}
			},
		}).finally(() => {
			unregister();
		});
	},
};

function isSettled(event: unknown): boolean {
	if (typeof event !== "object" || event === null) return false;
	return (event as { type?: unknown }).type === "agent_settled";
}
