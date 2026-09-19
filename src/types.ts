// pi's wire shapes are taken from pi itself, not re-described here.
//
// `import type` is erased at compile time, so @earendil-works/pi-* stay
// devDependencies and nothing is added to the runtime — test/no-runtime-deps
// asserts that the built output never mentions them. The benefit is that the
// shapes cannot drift: if pi changes a field or adds a stop reason, this file
// stops compiling instead of the server silently mis-reading a stream.
//
// Everything arriving from the pi process is still untrusted JSON, so these
// types describe what pi *promises* to send, and parse.ts verifies each value
// before it is used as one of them.

import type { ThinkingLevel as PiThinkingLevel } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, StopReason, TextContent, ToolCall, Usage } from "@earendil-works/pi-ai";
import type { JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";

/** The event stream of `pi -p --mode json`. */
export type PiEvent = JsonAgentSessionEvent;
/** One event, narrowed by its `type` tag. */
export type PiEventOf<T extends PiEvent["type"]> = Extract<PiEvent, { type: T }>;

/** The only message role this server reads. */
export type PiAssistantMessage = AssistantMessage;
export type PiContentBlock = AssistantMessage["content"][number];
export type PiTextBlock = TextContent;
export type PiToolCallBlock = ToolCall;
export type PiUsage = Usage;
export type PiStopReason = StopReason;

// --- stop reason classification -------------------------------------------

// pi's vocabulary is "pending" | "stop" | "length" | "toolUse" | "error" |
// "aborted" | "deferred". `satisfies` makes the compiler reject a reason pi does
// not have; test/pi-contract.test-d.ts covers the other direction, that the four
// buckets below remain exhaustive over pi's union.

/** Not a finished answer: more of the turn is still coming. */
export const STOP_STEP = ["toolUse", "pending"] as const satisfies readonly PiStopReason[];
/** A finished answer. `length` means the model hit its output limit. */
export const STOP_OK = ["stop", "length"] as const satisfies readonly PiStopReason[];
/** The turn failed. */
export const STOP_BAD = ["error", "aborted"] as const satisfies readonly PiStopReason[];
/** Parked for later completion — neither an answer nor a failure. */
export const STOP_DEFERRED = "deferred" satisfies PiStopReason;

export type StopStep = (typeof STOP_STEP)[number];
export type StopOk = (typeof STOP_OK)[number];
export type StopBad = (typeof STOP_BAD)[number];
export type StopDeferred = typeof STOP_DEFERRED;
export type KnownStopReason = StopStep | StopOk | StopBad | StopDeferred;

const STOP_STEP_SET: ReadonlySet<string> = new Set(STOP_STEP);
const STOP_OK_SET: ReadonlySet<string> = new Set(STOP_OK);
const STOP_BAD_SET: ReadonlySet<string> = new Set(STOP_BAD);

/** True when the message is a step of the turn rather than its answer. */
export function isStopStep(reason: string | null | undefined): reason is StopStep {
	return reason !== null && reason !== undefined && STOP_STEP_SET.has(reason);
}

export function isStopOk(reason: string | null | undefined): reason is StopOk {
	return reason !== null && reason !== undefined && STOP_OK_SET.has(reason);
}

export function isStopBad(reason: string | null | undefined): reason is StopBad {
	return reason !== null && reason !== undefined && STOP_BAD_SET.has(reason);
}

// --- MCP / JSON-RPC -------------------------------------------------------

export type JsonRpcId = string | number | null;

export interface JsonRpcMessage {
	jsonrpc?: unknown;
	id?: JsonRpcId;
	method?: unknown;
	params?: Record<string, unknown>;
}

export interface ToolTextContent {
	type: "text";
	text: string;
}

export interface ToolResult {
	content: ToolTextContent[];
	isError?: boolean;
}

export type ProgressStatus = "queued" | "running" | "tool" | "settling" | "stopping" | "finished" | "failed";

export interface ProgressUpdate {
	status: ProgressStatus;
	session: string;
	elapsedMs: number;
	message?: string;
	text?: string;
}

/**
 * The four MCP tool hints. Directories (OpenAI's among them) reject a tool that
 * leaves any of them out or sends a non-boolean, and hosts warn with them before
 * invoking — so they are required here, not left to each tool to remember.
 */
export interface ToolAnnotations {
	/** The tool observes without modifying anything. */
	readOnlyHint: boolean;
	/** Where readOnly is false: the tool can destroy work, not merely add to it. */
	destructiveHint: boolean;
	/** Repeating the call with the same arguments leaves no additional effect. */
	idempotentHint: boolean;
	/** The tool reaches beyond what the caller can see or control. */
	openWorldHint: boolean;
}

export interface ToolDefinition {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
	annotations: ToolAnnotations;
}

/** Cooperative cancellation: one token per in-flight request. */
export interface CancelToken {
	readonly cancelled: boolean;
	subscribe(fn: () => void): () => void;
	cancel(): void;
}

export interface CallContext {
	token: CancelToken;
	progress?: (update: ProgressUpdate) => void;
}

// --- run configuration ----------------------------------------------------

// pi owns this vocabulary too. Note there are two ThinkingLevel types upstream:
// pi-ai's model-side one has no "off", while the agent-side one — what the CLI's
// `--thinking` flag accepts — does. This is the agent-side list, checked against
// it by `satisfies` here and for exhaustiveness in the contract test.
export const THINKING_LEVELS = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const satisfies readonly PiThinkingLevel[];
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
	return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

/** What a pi run is allowed to override, once validated. */
export interface RunOverrides {
	model?: string;
	thinking?: ThinkingLevel;
	tools?: string;
	no_tools?: boolean;
	system_prompt_append?: string;
}

export interface SessionRecord {
	cwd: string;
	lastAccessed: number;
	model?: string;
	thinking?: ThinkingLevel;
}
