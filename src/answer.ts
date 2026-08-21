// Turning pi's event stream into the one thing the caller wants — the answer —
// plus aggregate stats. Nothing else from the transcript leaves this module.

import { MAX_OUTPUT, STDERR_LIMIT, TIMEOUT_MS } from "./config.ts";
import { asPiEvent, eventAs, readAssistantMessage } from "./parse.ts";
import type { RunResult } from "./pi-process.ts";
import { isStopBad, isStopOk, isStopStep, STOP_DEFERRED } from "./types.ts";

/** Tools whose target path is a side effect worth surfacing in the summary. */
const WRITE_TOOLS: ReadonlySet<string> = new Set(["write", "edit", "multi_edit", "multiedit", "apply_patch", "create"]);

interface SeenMessage {
	text: string;
	stopReason: string | undefined;
}

export interface Accumulator {
	messages: SeenMessage[];
	toolCalls: string[];
	openToolCalls: number;
	writtenFiles: string[];
	turns: number;
	usage: { input: number; output: number; reasoning: number; cost: number };
	model: string | null;
	provider: string | null;
	retries: number;
	lastStopReason: string | undefined;
}

export function newAccumulator(): Accumulator {
	return {
		// One entry per assistant message. "The answer" is defined by stopReason
		// (see selectAnswer), not by position or by the last text block.
		messages: [],
		toolCalls: [],
		openToolCalls: 0,
		writtenFiles: [],
		turns: 0,
		usage: { input: 0, output: 0, reasoning: 0, cost: 0 },
		model: null,
		provider: null,
		retries: 0,
		lastStopReason: undefined,
	};
}

/**
 * Fold one event into the accumulator. Returns a short progress note when the
 * event is worth reporting to the client, otherwise null.
 */
export function accumulate(acc: Accumulator, raw: unknown): string | null {
	const event = asPiEvent(raw);
	if (event === null) return null;

	switch (event.type) {
		case "turn_start":
			acc.turns += 1;
			return `turn ${acc.turns}`;

		case "tool_execution_start":
			return `running ${eventAs(event, "tool_execution_start").toolName}`;

		case "tool_execution_end":
			if (acc.openToolCalls > 0) acc.openToolCalls -= 1;
			return null;

		case "auto_retry_start": {
			acc.retries += 1;
			return `retrying (${eventAs(event, "auto_retry_start").attempt})`;
		}

		case "compaction_start":
			return "compacting context";

		case "message_end": {
			const message = readAssistantMessage(eventAs(event, "message_end").message);
			if (message === null) return null;

			acc.model ??= message.model ?? null;
			acc.provider ??= message.provider ?? null;
			// Summed across turns: every turn is a separate billed request, so this
			// is spend, not context size.
			acc.usage.input += message.usage.input;
			acc.usage.output += message.usage.output;
			acc.usage.reasoning += message.usage.reasoning;
			acc.usage.cost += message.usage.cost;
			if (message.stopReason !== undefined) acc.lastStopReason = message.stopReason;

			for (const call of message.toolCalls) {
				acc.toolCalls.push(call.name);
				acc.openToolCalls += 1;
				if (call.path !== undefined && WRITE_TOOLS.has(call.name) && !acc.writtenFiles.includes(call.path)) {
					acc.writtenFiles.push(call.path);
				}
			}

			acc.messages.push({ text: message.text, stopReason: message.stopReason });
			return null;
		}

		default:
			return null;
	}
}

// --- selecting the answer -------------------------------------------------

export type AnswerSource = "settled" | "cut-off" | "none";

export interface SelectedAnswer {
	text: string | null;
	stopReason: string | undefined;
	source: AnswerSource;
}

/**
 * "The answer" is the last assistant message that settled — the last one whose
 * stopReason is not a step (`toolUse`, `pending`). Selection looks at every
 * message, empty ones included: if the settled message carries no text, that is
 * a broken run, not a licence to return an earlier preamble as the answer.
 *
 * The returned stopReason belongs to the message being returned, so validation
 * cannot be fooled by a later event.
 */
export function selectAnswer(acc: Accumulator): SelectedAnswer {
	for (let i = acc.messages.length - 1; i >= 0; i -= 1) {
		const message = acc.messages[i];
		if (message === undefined || isStopStep(message.stopReason)) continue;
		if (message.text) return { text: message.text, stopReason: message.stopReason, source: "settled" };
		// A settled but empty message: report it rather than reaching further back.
		return { text: null, stopReason: message.stopReason, source: "none" };
	}
	const lastWithText = [...acc.messages].reverse().find((m) => m.text);
	if (lastWithText !== undefined) {
		return { text: lastWithText.text, stopReason: lastWithText.stopReason, source: "cut-off" };
	}
	return { text: null, stopReason: acc.lastStopReason, source: "none" };
}

/**
 * Fail-closed: anything other than a known-good terminal reason is a problem,
 * including a missing stopReason on the message being returned.
 */
export function answerProblem(answer: SelectedAnswer): string | null {
	if (answer.source === "none") {
		return answer.stopReason !== undefined
			? `pi settled with stopReason=${answer.stopReason} but produced no answer text`
			: "pi produced no assistant text";
	}
	if (answer.source === "cut-off") {
		return "pi never settled a message — returning the last text it produced";
	}
	const reason = answer.stopReason;
	if (reason === undefined) return "pi settled without reporting a stopReason";
	if (isStopOk(reason)) return null;
	if (isStopBad(reason)) return `pi stopped with stopReason=${reason}`;
	if (reason === STOP_DEFERRED) return "pi deferred the turn instead of answering";
	return `pi returned an unrecognized stopReason=${reason}`;
}

// --- rendering ------------------------------------------------------------

export function clip(text: string): string {
	if (!Number.isFinite(MAX_OUTPUT) || text.length <= MAX_OUTPUT) return text;
	return `${text.slice(0, MAX_OUTPUT)}\n\n[pi-mcp: truncated at ${MAX_OUTPUT} of ${text.length} chars]`;
}

/** pi announces a fresh session id on stderr; that is expected, not a warning. */
const NOISE = [/^Warning: No project session found with id .*creating a new session/i];

function usefulStderr(stderr: string): string {
	return stderr
		.split("\n")
		.filter((line) => line.trim() && !NOISE.some((re) => re.test(line.trim())))
		.join("\n")
		.trim();
}

/**
 * stderr is diagnostics, not the deliverable — keep only the tail, where the
 * actual error lives, and keep it small so it cannot dominate the response.
 */
export function tailStderr(stderr: string): string {
	const text = usefulStderr(stderr);
	if (text.length <= STDERR_LIMIT) return text;
	return `[…earlier stderr omitted]\n${text.slice(-STDERR_LIMIT)}`;
}

function compactTokens(n: number): string {
	if (n < 1000) return String(n);
	return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
}

/** One or two short lines: aggregate counts only, plus explicit file side effects. */
export function summarize(acc: Accumulator, elapsedMs: number): string {
	const bits: string[] = [];
	const model = acc.provider && acc.model ? `${acc.provider}/${acc.model}` : acc.model;
	if (model) bits.push(model);
	if (acc.turns) bits.push(`${acc.turns} turn${acc.turns === 1 ? "" : "s"}`);

	if (acc.toolCalls.length) {
		const counts = new Map<string, number>();
		for (const name of acc.toolCalls) counts.set(name, (counts.get(name) ?? 0) + 1);
		const ranked = [...counts].sort((a, b) => b[1] - a[1]);
		const shown = ranked.slice(0, 8).map(([n, c]) => (c > 1 ? `${n}×${c}` : n));
		if (ranked.length > 8) shown.push(`+${ranked.length - 8} more`);
		bits.push(`${acc.toolCalls.length} tool call${acc.toolCalls.length === 1 ? "" : "s"}: ${shown.join(", ")}`);
	} else {
		bits.push("no tool calls");
	}

	if (acc.usage.input || acc.usage.output) {
		const tokens = `${compactTokens(acc.usage.input)} in / ${compactTokens(acc.usage.output)} out`;
		bits.push(acc.usage.reasoning ? `${tokens} (${compactTokens(acc.usage.reasoning)} think)` : tokens);
	}
	if (acc.usage.cost > 0) bits.push(`$${acc.usage.cost.toFixed(4)}`);
	if (acc.retries) bits.push(`${acc.retries} retr${acc.retries === 1 ? "y" : "ies"}`);
	if (acc.lastStopReason === "length") bits.push("hit model output limit");
	if (acc.openToolCalls > 0) bits.push(`${acc.openToolCalls} tool call(s) never finished`);
	bits.push(`${(elapsedMs / 1000).toFixed(1)}s`);

	const lines = [`pi: ${bits.join(" · ")}`];
	if (acc.writtenFiles.length) {
		const shown = acc.writtenFiles.slice(0, 12).join(", ");
		const rest = acc.writtenFiles.length - 12;
		lines.push(`pi wrote: ${shown}${rest > 0 ? ` (+${rest} more)` : ""}`);
	}
	return lines.join("\n");
}

export function describeFailure(result: RunResult, acc: Accumulator | null): string {
	const head = result.cancelled
		? "pi was cancelled and the process was killed."
		: result.timedOut
			? `pi timed out after ${TIMEOUT_MS} ms and was killed.`
			: `pi exited with code ${result.code}.`;
	const answer = acc ? selectAnswer(acc).text : null;
	const partial = answer ? `\n\npartial answer:\n${clip(answer)}` : "";
	const err = tailStderr(result.stderr);
	return `${head}${partial}${err ? `\n\nstderr:\n${err}` : ""}`;
}
