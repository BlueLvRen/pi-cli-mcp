// Narrowing for data that crosses a process boundary.
//
// src/types.ts borrows pi's types, which describe what pi promises to send. What
// actually arrives is a parsed JSON value from another process: fields can be
// missing, retyped, or new. Everything here turns `unknown` into a value that is
// safe to read as one of those types — or into null, never into a guess.

import type { PiAssistantMessage, PiContentBlock, PiEvent, PiEventOf, PiToolCallBlock, PiUsage } from "./types.ts";

export function asRecord(value: unknown): Record<string, unknown> | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** A pi event, if the value at least carries a `type` tag. */
export function asPiEvent(value: unknown): (PiEvent & { type: string }) | null {
	const record = asRecord(value);
	if (record === null || typeof record.type !== "string") return null;
	return record as unknown as PiEvent & { type: string };
}

/** Narrow an already-tagged event to one variant. */
export function eventAs<T extends PiEvent["type"]>(event: { type: string }, _type: T): PiEventOf<T> {
	return event as unknown as PiEventOf<T>;
}

export interface ParsedUsage {
	input: number;
	output: number;
	reasoning: number;
	cost: number;
}

export function readUsage(value: unknown): ParsedUsage {
	const usage = asRecord(value) as Partial<PiUsage> | null;
	const cost = asRecord(usage?.cost);
	return {
		input: asFiniteNumber(usage?.input) ?? 0,
		output: asFiniteNumber(usage?.output) ?? 0,
		reasoning: asFiniteNumber(usage?.reasoning) ?? 0,
		cost: asFiniteNumber(cost?.total) ?? 0,
	};
}

export interface ParsedToolCall {
	name: string;
	/** The written path, when this call targets one. */
	path: string | undefined;
}

export interface ParsedAssistantMessage {
	provider: string | undefined;
	model: string | undefined;
	stopReason: string | undefined;
	/**
	 * Why the turn failed. pi's contract is explicit: "Error termination must
	 * produce an AssistantMessage with stopReason 'error' or 'aborted' and
	 * errorMessage" (packages/ai/src/types.ts). Without reading it, a failed turn
	 * reports only that no answer arrived — true, and useless.
	 */
	errorMessage: string | undefined;
	/** Redacted provider/runtime diagnostics, when pi attached any. */
	diagnostics: string[];
	usage: ParsedUsage;
	/** Text blocks of this message, joined; empty when it carried none. */
	text: string;
	toolCalls: ParsedToolCall[];
}

/**
 * Read an assistant message. Returns null for every other role — user,
 * tool-result, and any custom message an extension defines — since none of them
 * can be the answer.
 */
export function readAssistantMessage(value: unknown): ParsedAssistantMessage | null {
	const message = asRecord(value) as Partial<PiAssistantMessage> | null;
	if (message === null || message.role !== "assistant") return null;

	const texts: string[] = [];
	const toolCalls: ParsedToolCall[] = [];
	const blocks = Array.isArray(message.content) ? (message.content as PiContentBlock[]) : [];

	for (const raw of blocks) {
		const block = asRecord(raw);
		if (block === null || typeof block.type !== "string") continue;

		if (block.type === "text") {
			const text = asString(block.text)?.trim();
			if (text) texts.push(text);
			continue;
		}
		if (block.type === "toolCall") {
			const call = block as unknown as Partial<PiToolCallBlock>;
			const name = asString(call.name);
			if (!name) continue;
			const args = asRecord(call.arguments);
			toolCalls.push({ name, path: asString(args?.path) ?? asString(args?.file_path) });
		}
	}

	const diagnostics: string[] = [];
	if (Array.isArray(message.diagnostics)) {
		for (const raw of message.diagnostics) {
			const entry = asRecord(raw);
			if (entry === null) continue;
			const type = asString(entry.type);
			const error = asRecord(entry.error);
			const detail = asString(error?.message) ?? asString(error?.type);
			const line = [type, detail].filter(Boolean).join(": ");
			if (line) diagnostics.push(line);
		}
	}

	return {
		provider: asString(message.provider),
		model: asString(message.model),
		stopReason: asString(message.stopReason),
		errorMessage: asString(message.errorMessage),
		diagnostics,
		usage: readUsage(message.usage),
		text: texts.join("\n\n"),
		toolCalls,
	};
}
