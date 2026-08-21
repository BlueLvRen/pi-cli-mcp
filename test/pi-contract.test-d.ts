// Compile-time contract test against the installed pi.
//
// This server reads pi's `--mode json` stream and classifies `stopReason` values.
// Both are pi's data, not ours, so the risk is silent drift: pi adds a stop
// reason or renames an event, our runtime quietly files it under "unknown", and
// a delegated answer comes back wrong or a good answer is reported as failed.
//
// These assertions fail `npm run check:types` the moment the installed
// @earendil-works/pi-* types stop matching our assumptions. They cost nothing at
// runtime: the pi packages are devDependencies and src/ never imports them.

import type { ThinkingLevel as PiThinkingLevel } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, StopReason, Usage } from "@earendil-works/pi-ai";
import type { JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { expectTypeOf, it } from "vitest";
import type {
	KnownStopReason,
	PiAssistantMessage,
	PiEvent,
	PiUsage,
	STOP_BAD,
	STOP_DEFERRED,
	STOP_OK,
	STOP_STEP,
	ThinkingLevel,
} from "../src/types.ts";

/** Non-distributive assignability, so unions are compared as a whole. */
type AssignableTo<A, B> = [A] extends [B] ? true : false;

/** The event names our accumulator switches on. */
type BranchedEventName =
	| "message_end"
	| "turn_start"
	| "tool_execution_start"
	| "tool_execution_end"
	| "auto_retry_start"
	| "compaction_start";

it("covers every stopReason pi can emit", () => {
	// Nothing pi emits may fall outside our vocabulary...
	expectTypeOf<Exclude<StopReason, KnownStopReason>>().toEqualTypeOf<never>();
	// ...and we must not invent reasons pi does not have, which would mean the
	// classification is partly dead code hiding a real gap.
	expectTypeOf<Exclude<KnownStopReason, StopReason>>().toEqualTypeOf<never>();
});

it("partitions stopReason exhaustively and without overlap", () => {
	type Step = (typeof STOP_STEP)[number];
	type Ok = (typeof STOP_OK)[number];
	type Bad = (typeof STOP_BAD)[number];
	type Deferred = typeof STOP_DEFERRED;

	// Union of the four buckets == pi's full vocabulary.
	expectTypeOf<Exclude<StopReason, Step | Ok | Bad | Deferred>>().toEqualTypeOf<never>();

	// The buckets are disjoint: a reason cannot be both a step and an answer.
	expectTypeOf<Extract<Step, Ok | Bad | Deferred>>().toEqualTypeOf<never>();
	expectTypeOf<Extract<Ok, Bad | Deferred>>().toEqualTypeOf<never>();
	expectTypeOf<Extract<Bad, Deferred>>().toEqualTypeOf<never>();
});

it("accepts every event pi's json mode emits", () => {
	// PiEvent is deliberately wider than pi's union (it tolerates unknown event
	// types and the `session` header, which is not part of AgentSessionEvent),
	// but everything pi does send must be assignable to it.
	expectTypeOf<AssignableTo<JsonAgentSessionEvent, PiEvent>>().toEqualTypeOf<true>();
});

it("reads the same assistant message type pi defines", () => {
	// src/types.ts aliases pi's own type rather than re-describing it, so this is
	// an identity check that the alias still points at the right thing.
	expectTypeOf<PiAssistantMessage>().toEqualTypeOf<AssistantMessage>();

	// And message_end must still be the event that delivers it.
	type PiMessageEnd = Extract<JsonAgentSessionEvent, { type: "message_end" }>;
	expectTypeOf<AssignableTo<AssistantMessage, PiMessageEnd["message"]>>().toEqualTypeOf<true>();
});

it("accepts exactly the thinking levels pi's --thinking accepts", () => {
	// Two ThinkingLevel types exist upstream; the agent-side one (with "off") is
	// the CLI flag's vocabulary. Both directions, so we neither miss a level nor
	// offer one pi would reject.
	expectTypeOf<Exclude<PiThinkingLevel, ThinkingLevel>>().toEqualTypeOf<never>();
	expectTypeOf<Exclude<ThinkingLevel, PiThinkingLevel>>().toEqualTypeOf<never>();
});

it("reads the assistant fields it reports in the stats line", () => {
	expectTypeOf<AssignableTo<AssistantMessage["provider"], string>>().toEqualTypeOf<true>();
	expectTypeOf<AssignableTo<AssistantMessage["model"], string>>().toEqualTypeOf<true>();
	expectTypeOf<AssignableTo<AssistantMessage["stopReason"], StopReason>>().toEqualTypeOf<true>();
});

it("reads usage fields that pi actually reports", () => {
	// Each field we sum must exist in pi's Usage with a compatible type. Optional
	// on our side is fine; a type mismatch or a removed field is not.
	expectTypeOf<AssignableTo<Usage["input"], NonNullable<PiUsage["input"]>>>().toEqualTypeOf<true>();
	expectTypeOf<AssignableTo<Usage["output"], NonNullable<PiUsage["output"]>>>().toEqualTypeOf<true>();
	expectTypeOf<AssignableTo<Usage["totalTokens"], NonNullable<PiUsage["totalTokens"]>>>().toEqualTypeOf<true>();
	expectTypeOf<
		AssignableTo<NonNullable<Usage["reasoning"]>, NonNullable<PiUsage["reasoning"]>>
	>().toEqualTypeOf<true>();
	expectTypeOf<
		AssignableTo<Usage["cost"]["total"], NonNullable<NonNullable<PiUsage["cost"]>["total"]>>
	>().toEqualTypeOf<true>();
});

it("branches only on event names pi actually emits", () => {
	// A renamed event would leave our switch compiling but never matching. This
	// is how `auto_compaction_start` — a name from an unrelated older fork — was
	// caught as dead code.
	expectTypeOf<Exclude<BranchedEventName, JsonAgentSessionEvent["type"]>>().toEqualTypeOf<never>();
});

it("reads the tool name field pi actually sends", () => {
	type ToolStart = Extract<JsonAgentSessionEvent, { type: "tool_execution_start" }>;
	type ToolEnd = Extract<JsonAgentSessionEvent, { type: "tool_execution_end" }>;
	// We label progress with `toolName`; assert it exists and is a string.
	expectTypeOf<AssignableTo<ToolStart["toolName"], string>>().toEqualTypeOf<true>();
	expectTypeOf<AssignableTo<ToolEnd["toolName"], string>>().toEqualTypeOf<true>();
});

it("reads the retry fields we surface as progress", () => {
	type Retry = Extract<JsonAgentSessionEvent, { type: "auto_retry_start" }>;
	expectTypeOf<AssignableTo<Retry["attempt"], number>>().toEqualTypeOf<true>();
});
