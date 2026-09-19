// Tool schemas and their implementations.

import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { Accumulator } from "./answer.ts";
import {
	accumulate,
	answerProblem,
	clip,
	newAccumulator,
	renderFailure,
	selectAnswer,
	summarize,
	tailStderr,
} from "./answer.ts";
import { DEFAULT_MODEL, DEFAULT_THINKING, MAX_PROMPT, MAX_TIMEOUT_MS, TIMEOUT_MS } from "./config.ts";
import { ImageInputError, ImageTransportError, readImages } from "./images.ts";
import { asPiEvent, readTextDelta } from "./parse.ts";
import type { RunResult } from "./pi-process.ts";
import { makeCancelToken, runPi, withSlot } from "./pi-process.ts";
import { getSession, listSessions, rememberSession, withSessionLock } from "./sessions.ts";
import type { BackgroundRun, RunPlan, Transport } from "./transport/index.ts";
import {
	completeBackgroundRun,
	forgetBackgroundRun,
	getBackgroundRun,
	getRun,
	listBackgroundRuns,
	listRuns,
	registerBackgroundRun,
	resolveTransport,
	TRANSPORT_NAMES,
} from "./transport/index.ts";
import { updateRun } from "./transport/registry.ts";
import type {
	CallContext,
	CancelToken,
	ProgressStatus,
	ProgressUpdate,
	RunOverrides,
	ThinkingLevel,
	ToolDefinition,
	ToolErrorCode,
	ToolErrorDetails,
	ToolResult,
} from "./types.ts";
import { isThinkingLevel, THINKING_LEVELS } from "./types.ts";

// --- schemas --------------------------------------------------------------

const SHARED_PROPS = {
	model: {
		type: "string",
		description:
			"Model pattern or id, e.g. 'sonnet', 'bifrost/minimax/MiniMax-M3', 'provider/id:thinking'. " +
			"Defaults to pi's own settings; pi_models lists valid values.",
	},
	thinking: {
		type: "string",
		enum: THINKING_LEVELS,
		description:
			"Thinking level. No-op on models without thinking support (check pi_models). Defaults to pi's " +
			"own settings.",
	},
	transport: {
		type: "string",
		enum: TRANSPORT_NAMES,
		description:
			"Usually omit. The default 'rpc' keeps pi up, so a running turn can be steered or aborted with " +
			"pi_send. 'print' runs one process per turn that cannot be reached while it works.",
	},
	timeout_ms: {
		type: "integer",
		minimum: 1000,
		description:
			"Usually omit — the server default is generous. Override only when the task's real size " +
			"demands it. A run killed at the deadline is not lost: it still returns its session id and is " +
			"resumable with pi_reply.",
	},
	stream: {
		type: "boolean",
		description:
			"Opt in to model text deltas in progress notifications. Requires a progressToken; without one, " +
			"the normal stage notifications still remain unavailable to the caller.",
	},
	images: {
		type: "array",
		items: {
			type: "object",
			properties: {
				data: {
					type: "string",
					description: "Raw base64 or a data:image/...;base64,... URI. Do not pass a path or remote URL.",
				},
				mimeType: {
					type: "string",
					enum: ["image/jpeg", "image/png", "image/gif", "image/webp"],
					description: "Image MIME type; must match the actual bytes.",
				},
			},
			required: ["data", "mimeType"],
			additionalProperties: false,
		},
		maxItems: 600,
		description:
			"Optional inline images for vision-capable models. Accepts raw base64 or a data URI. " +
			"Supported formats: JPEG, PNG, GIF and WebP; each image is limited to 32 MiB and the request " +
			"to 64 MiB. Paths and remote URLs are not accepted.",
	},
} as const;

// The three annotation shapes the seven tools fall into. pi, pi_start and pi_reply edit files and
// run shell commands through pi and never repeat identically (each call is a new task or
// turn); pi_send reaches the same way, and its abort discards a running turn. pi_models
// reads pi's live model catalog, which reflects provider state this server does not
// control. pi_running and pi_sessions read only this server's own records.
const MUTATING = {
	readOnlyHint: false,
	destructiveHint: true,
	idempotentHint: false,
	openWorldHint: true,
} as const;
const LIVE_LISTING = {
	readOnlyHint: true,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: true,
} as const;
const LOCAL_LISTING = {
	readOnlyHint: true,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: false,
} as const;

export const TOOLS: ToolDefinition[] = [
	{
		name: "pi",
		description:
			"Start a NEW task in the local pi agent — a separate CLI coding agent with its own " +
			"read/bash/edit/write tools and its own context window. Blocks until pi settles, then returns " +
			"only its final answer plus stats, prefixed [session: <id>]; continue that session later with " +
			"pi_reply.\n" +
			"Good for: a second opinion from a different model, work kept out of this context, or parallel " +
			"investigation.\n" +
			"Caution: pi has no permission system. With its default tools it edits files and runs shell " +
			"commands as your user inside `cwd`. For analysis-only work pass `tools` or `no_tools`.",
		inputSchema: {
			type: "object",
			properties: {
				prompt: {
					type: "string",
					description:
						"The complete task. pi cannot see this conversation, so include everything it needs: " +
						"file paths, goal, constraints, expected output format.",
				},
				cwd: {
					type: "string",
					description:
						"Usually omit to use this server's cwd. If set, must be an absolute path (relative is " +
						"rejected). pi works and edits here, and reads AGENTS.md / CLAUDE.md from here.",
				},
				...SHARED_PROPS,
				tools: {
					type: "string",
					description:
						"Usually omit to keep pi's default set (includes bash/edit/write). Set a comma-separated " +
						"allowlist of pi tool names only to restrict, e.g. 'read,grep,ls' for a read-only run.",
				},
				no_tools: {
					type: "boolean",
					description: "Disable all pi tools: pure reasoning over the prompt, no file or shell access.",
				},
				system_prompt_append: {
					type: "string",
					description: "Extra text appended to pi's system prompt for this run.",
				},
			},
			required: ["prompt"],
			additionalProperties: false,
		},
		annotations: MUTATING,
	},
	{
		name: "pi_start",
		description:
			"Start a NEW pi task in the background and return immediately with its session id. Uses the rpc " +
			"transport so pi_running can report progress and pi_send can steer or abort it. Retrieve the " +
			"final result with pi_reply({ session }) once it settles, or continue/recover it with a prompt.",
		inputSchema: {
			type: "object",
			properties: {
				prompt: {
					type: "string",
					description:
						"The complete task. pi cannot see this conversation, so include everything it needs: " +
						"file paths, goal, constraints, expected output format.",
				},
				cwd: {
					type: "string",
					description:
						"Usually omit to use this server's cwd. If set, must be an absolute path (relative is " +
						"rejected). pi works and edits here, and reads AGENTS.md / CLAUDE.md from here.",
				},
				...SHARED_PROPS,
				tools: {
					type: "string",
					description:
						"Usually omit to keep pi's default set (includes bash/edit/write). Set a comma-separated " +
						"allowlist of pi tool names only to restrict, e.g. 'read,grep,ls' for a read-only run.",
				},
				no_tools: {
					type: "boolean",
					description: "Disable all pi tools: pure reasoning over the prompt, no file or shell access.",
				},
				system_prompt_append: {
					type: "string",
					description: "Extra text appended to pi's system prompt for this run.",
				},
			},
			required: ["prompt"],
			additionalProperties: false,
		},
		annotations: MUTATING,
	},
	{
		name: "pi_reply",
		description:
			"Send a new turn to an existing pi session that is not executing right now — including one " +
			"that timed out or was cancelled: the session survives, so resume it here instead of " +
			"restarting with `pi`. pi still has its prior turns (but never this conversation), so the " +
			"follow-up can be short. For a background run from `pi_start`, omit `prompt` to wait for or " +
			"retrieve its final result. Survives restarts of this server when a prompt is supplied. For a " +
			"turn still running under 'rpc', use pi_send instead.",
		inputSchema: {
			type: "object",
			properties: {
				session: {
					type: "string",
					description: "Session id from a [session: <id>] prefix, or from pi_sessions.",
				},
				prompt: { type: "string", description: "Follow-up message for this session." },
				cwd: {
					type: "string",
					description: "Absolute path override. Defaults to the directory where the session started.",
				},
				...SHARED_PROPS,
			},
			required: ["session"],
			additionalProperties: false,
		},
		annotations: MUTATING,
	},
	{
		name: "pi_models",
		description:
			"List the models pi can actually reach right now — provider, model id, context window, max " +
			"output, thinking and image support — read from the live catalog. Use it to pick `model` and " +
			"`thinking` values for `pi` / `pi_reply`. Starts no session, runs no task.",
		inputSchema: {
			type: "object",
			properties: {
				search: {
					type: "string",
					description: "Optional fuzzy filter, e.g. 'glm', 'deepseek', 'minimax'.",
				},
			},
			additionalProperties: false,
		},
		annotations: LIVE_LISTING,
	},
	{
		name: "pi_send",
		description:
			"Deliver a message into a pi turn that is executing right now. Works only on runs started " +
			"with transport 'rpc' — 'print' runs cannot be reached, and a session that already finished " +
			"takes pi_reply, not pi_send. Returns immediately; pi's reaction appears in the answer of the " +
			"pi/pi_reply call still waiting on that turn. `pi_running` lists reachable sessions.",
		inputSchema: {
			type: "object",
			properties: {
				session: {
					type: "string",
					description: "Session id of the running turn (see pi_running).",
				},
				message: {
					type: "string",
					description: "Text to deliver. Required for 'steer' and 'follow_up', ignored by 'abort'.",
				},
				command: {
					type: "string",
					enum: ["steer", "follow_up", "abort"],
					description:
						"'steer' (default) interrupts the current turn with the message; 'follow_up' queues it " +
						"for after the turn finishes; 'abort' stops the turn. Passed to pi unchanged.",
				},
			},
			required: ["session"],
			additionalProperties: false,
		},
		annotations: MUTATING,
	},
	{
		name: "pi_running",
		description:
			"List pi turns executing or queued under the rpc transport — including non-blocking `pi_start` " +
			"runs — with session id, working directory, elapsed time, latest safe progress, and whether " +
			"pi_send can reach them. 'print' runs are unreachable mid-run. For past sessions use pi_sessions.",
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
		annotations: LOCAL_LISTING,
	},
	{
		name: "pi_sessions",
		description:
			"List all pi sessions started through this server, newest first, with their working " +
			"directory — running or finished, including runs that timed out. Use it to recover an id for " +
			"pi_reply. For turns still executing (pi_send targets), use pi_running.",
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
		annotations: LOCAL_LISTING,
	},
];

// --- helpers --------------------------------------------------------------

export function toolResult(text: string, isError = false): ToolResult {
	return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

function imageErrorResult(code: ToolErrorCode, message: string, retryable: boolean, imageIndex?: number): ToolResult {
	const error: ToolErrorDetails = { code, message, retryable, ...(imageIndex === undefined ? {} : { imageIndex }) };
	return {
		content: [{ type: "text", text: `[image_error: ${code}] ${message}` }],
		isError: true,
		structuredContent: { error },
	};
}

function imageInputFailure(err: unknown): ToolResult | undefined {
	if (err instanceof ImageInputError) return imageErrorResult(err.code, err.message, err.retryable, err.imageIndex);
	if (err instanceof ImageTransportError) return imageErrorResult(err.code, err.message, err.retryable);
	return undefined;
}

function classifyImageOutcome(acc: Accumulator, hasImages: boolean, fallback: string): ToolErrorDetails | undefined {
	if (!hasImages) return undefined;
	const answer = selectAnswer(acc);
	const reason = `${answer.errorMessage ?? ""} ${answer.diagnostics?.join(" ") ?? ""} ${fallback}`.toLowerCase();
	if (!answerProblem(answer) && !fallback) return undefined;
	if (/(does not support|not support|unsupported|vision|image input|multimodal)/.test(reason)) {
		return {
			code: "unsupported_model",
			message:
				"The selected pi model/provider rejected image input. Choose a model whose pi_models entry has images=yes, then retry.",
			retryable: false,
		};
	}
	return {
		code: "image_provider_error",
		message: answer.errorMessage
			? `The image request was rejected by the pi provider: ${answer.errorMessage}`
			: "The pi provider did not complete a request containing images; retry or choose another vision-capable model.",
		retryable: true,
	};
}

function attachImageOutcomeError(result: ToolResult, acc: Accumulator, hasImages: boolean, fallback = ""): ToolResult {
	const details = classifyImageOutcome(acc, hasImages, fallback);
	if (!details) return result;
	return {
		...result,
		content: [
			{
				type: "text",
				text: `[image_error: ${details.code}] ${details.message}\n\n${result.content[0]?.text ?? ""}`,
			},
		],
		isError: true,
		structuredContent: { error: details },
	};
}

/**
 * The live catalog is the only capability signal pi exposes before a request.
 * Use it when the caller selected a concrete model, but never turn an absent or
 * unparseable row into a false negative: aliases and provider defaults belong to
 * pi, which remains the final authority.
 */
async function preflightImageCapability(
	model: string | undefined,
	images: ReturnType<typeof readImages>,
	ctx: CallContext,
): Promise<ToolResult | undefined> {
	if (images.length === 0 || model === undefined || model.trim() === "") return undefined;
	const requested = model.split(":", 1)[0];
	const result = await withSlot(() => runPi(["--list-models"], process.cwd(), { token: ctx.token }));
	if (result.cancelled || result.code !== 0) return undefined;
	const row = result.stdout
		.split("\n")
		.slice(1)
		.map((line) => line.trim().split(/\s+/))
		.find((parts) => parts.length >= 6 && (parts[1] === requested || `${parts[0]}/${parts[1]}` === requested));
	if (row?.at(-1)?.toLowerCase() !== "no") return undefined;
	return imageErrorResult(
		"unsupported_model",
		`The selected model ${JSON.stringify(model)} is marked images=no by pi_models. Choose a model whose pi_models entry has images=yes, then retry.`,
		false,
	);
}

function resolveCwd(requested: unknown): string {
	if (requested === undefined || requested === null || requested === "") return process.cwd();
	if (typeof requested !== "string") throw new Error("cwd must be a string");
	if (!isAbsolute(requested)) throw new Error(`cwd must be an absolute path: ${requested}`);
	if (!existsSync(requested) || !statSync(requested).isDirectory()) {
		throw new Error(`cwd does not exist or is not a directory: ${requested}`);
	}
	return requested;
}

function readTimeout(value: unknown): number | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value) || value < 1000) {
		throw new Error("timeout_ms must be a number of milliseconds, at least 1000");
	}
	if (value > MAX_TIMEOUT_MS) {
		throw new Error(`timeout_ms ${value} exceeds the server ceiling of ${MAX_TIMEOUT_MS} ms`);
	}
	return value;
}

function readStream(value: unknown, tool: string): boolean {
	if (value === undefined || value === null) return false;
	if (typeof value !== "boolean") throw new Error(`${tool}: stream must be a boolean`);
	return value;
}

function readOverrides(input: Record<string, unknown>): RunOverrides {
	const overrides: RunOverrides = {};
	const model = input.model ?? DEFAULT_MODEL;
	if (model !== undefined && model !== null) {
		if (typeof model !== "string") throw new Error("model must be a string");
		overrides.model = model;
	}
	const thinking = input.thinking ?? DEFAULT_THINKING;
	if (thinking !== undefined && thinking !== null) {
		if (!isThinkingLevel(thinking)) {
			throw new Error(`invalid thinking level "${String(thinking)}"; expected one of ${THINKING_LEVELS.join(", ")}`);
		}
		overrides.thinking = thinking;
	}
	if (input.no_tools === true) {
		overrides.no_tools = true;
	} else if (input.tools !== undefined && input.tools !== null) {
		if (typeof input.tools !== "string") throw new Error("tools must be a comma-separated string");
		overrides.tools = input.tools;
	}
	if (input.system_prompt_append !== undefined && input.system_prompt_append !== null) {
		if (typeof input.system_prompt_append !== "string") {
			throw new Error("system_prompt_append must be a string");
		}
		overrides.system_prompt_append = input.system_prompt_append;
	}
	return overrides;
}

function readPrompt(value: unknown, tool: string): string {
	if (typeof value !== "string" || value.trim() === "") {
		throw new Error(`${tool}: \`prompt\` is required and must be a non-empty string.`);
	}
	if (value.length > MAX_PROMPT) {
		throw new Error(
			`${tool}: prompt is ${value.length} chars, over the ${MAX_PROMPT} limit. ` +
				"Write it to a file and point pi at the path instead.",
		);
	}
	return value;
}

interface Outcome {
	acc: Accumulator;
	result: RunResult;
	elapsedMs: number;
}

function reportProgress(
	ctx: CallContext,
	session: string,
	startedAt: number,
	status: ProgressStatus,
	message?: string,
	text?: string,
): void {
	const update: ProgressUpdate = {
		status,
		session,
		elapsedMs: Date.now() - startedAt,
		...(message === undefined ? {} : { message }),
		...(text === undefined ? {} : { text }),
	};
	updateRun(session, { status, ...(message === undefined ? {} : { message }) });
	ctx.progress?.(update);
}

async function invokePi(
	transport: Transport,
	plan: RunPlan,
	ctx: CallContext,
	startedAt: number,
	streamText: boolean,
): Promise<Outcome> {
	const acc = newAccumulator();
	const started = Date.now();
	const result = await transport.run(plan, ctx, (event) => {
		const note = accumulate(acc, event);
		const text = streamText ? readTextDelta(event) : null;
		if (asPiEvent(event)?.type === "agent_settled") {
			reportProgress(ctx, plan.sessionId, startedAt, "settling", "settling final answer");
		} else if (note?.startsWith("running ")) {
			reportProgress(ctx, plan.sessionId, startedAt, "tool", note);
		} else if (note) {
			reportProgress(ctx, plan.sessionId, startedAt, "running", note);
		}
		if (text !== null) reportProgress(ctx, plan.sessionId, startedAt, "running", "text delta", text);
	});
	return { acc, result, elapsedMs: Date.now() - started };
}

function renderSuccess(outcome: Outcome, prefix: string | null, hasImages = false): ToolResult {
	const { acc, result, elapsedMs } = outcome;
	const answer = selectAnswer(acc);
	const problem = answerProblem(answer);
	const warnings = tailStderr(result.stderr);
	const parts: string[] = [];
	if (prefix) parts.push(prefix);
	// pi can exit 0 on a turn that did not actually settle cleanly, so the answer
	// is still returned but the call is reported as failed.
	if (problem) parts.push(`[warning: ${problem} — the answer below may be incomplete]`);
	if (warnings) parts.push(`[pi stderr: ${warnings}]`);

	if (answer.text) {
		parts.push(clip(answer.text));
	} else {
		// Never fall back to raw stdout: that is the whole NDJSON transcript,
		// including narration, tool arguments and tool results. Returning it as an
		// answer would break the one contract this server makes. Describe the shape
		// of what arrived instead — enough to debug, with no transcript content.
		const reasons = [...new Set(acc.messages.map((m) => m.stopReason ?? "none"))].join(", ");
		const diagnostics = answer.diagnostics ?? [];
		const shape =
			`assistant messages seen: ${acc.messages.length}` +
			(acc.messages.length ? ` (stopReason: ${reasons})` : "") +
			`, tool calls: ${acc.toolCalls.length}, raw stdout: ${result.stdout.length} chars`;

		let headline: string;
		if (answer.errorMessage) {
			// pi reported a reason: lead with it, the stream shape is secondary.
			headline = `pi produced no answer text. pi's reason: ${answer.errorMessage}`;
		} else if (acc.messages.length > 0) {
			// The stream was fine and pi settled the turn — the message itself was
			// empty. Blaming the contract here sends the reader after the wrong bug;
			// an empty completion is the model's, and retrying or switching model is
			// what actually helps.
			headline =
				"pi settled the turn with an empty message: the model returned no content. " +
				"The event stream was well-formed, so this is the model, not the protocol — " +
				"retry, or use a different model.";
		} else {
			headline =
				"pi returned no usable answer text: its event stream did not match the " +
				"expected `--mode json` contract.";
		}

		const lines = [headline, shape];
		if (diagnostics.length) lines.push(`pi diagnostics: ${diagnostics.join("; ")}`);
		parts.push(lines.join("\n"));
	}

	parts.push(`---\n${summarize(acc, elapsedMs)}`);
	return attachImageOutcomeError(toolResult(parts.join("\n\n"), Boolean(problem)), acc, hasImages);
}

function renderOutcome(
	outcome: Outcome,
	sessionId: string,
	timeoutMs: number | undefined,
	hasImages: boolean,
): ToolResult {
	if (outcome.result.code !== 0 || outcome.result.timedOut || outcome.result.cancelled) {
		return attachImageOutcomeError(
			toolResult(
				renderFailure(outcome.acc, outcome.result, outcome.elapsedMs, {
					id: sessionId,
					tool: "pi",
					timeoutMs,
				}),
				true,
			),
			outcome.acc,
			hasImages,
			"pi run did not complete",
		);
	}
	return renderSuccess(outcome, `[session: ${sessionId}]`, hasImages);
}

async function waitForBackgroundResult(run: BackgroundRun, token: CancelToken): Promise<ToolResult> {
	if (token.cancelled) return toolResult("pi_reply was cancelled.", true);
	return new Promise<ToolResult>((resolve) => {
		let finished = false;
		let unsubscribe = (): void => {};
		const finish = (result: ToolResult): void => {
			if (finished) return;
			finished = true;
			unsubscribe();
			resolve(result);
		};
		unsubscribe = token.subscribe(() => finish(toolResult("pi_reply was cancelled.", true)));
		void run.complete.then(finish);
	});
}

/**
 * Start an rpc turn without tying its lifetime to the short `pi_start` request.
 * The caller owns all follow-up decisions: this function only launches the run
 * and records its result for a later `pi_reply({session})`.
 */
export async function callPiStart(input: Record<string, unknown>, ctx: CallContext): Promise<ToolResult> {
	let prompt: string;
	let images: ReturnType<typeof readImages>;
	let cwd: string;
	let overrides: RunOverrides;
	let timeoutMs: number | undefined;
	let transport: Transport;
	let streamText: boolean;
	try {
		prompt = readPrompt(input.prompt, "pi_start");
		images = readImages(input.images, "pi_start");
		cwd = resolveCwd(input.cwd);
		overrides = readOverrides(input);
		timeoutMs = readTimeout(input.timeout_ms);
		streamText = readStream(input.stream, "pi_start");
		// A background run must remain reachable. Do not inherit a server-wide
		// print default that would make pi_send/pi_running impossible to use.
		transport = resolveTransport(input.transport ?? "rpc");
		if (!transport.acceptsMidRunMessages) throw new Error("pi_start requires transport 'rpc'");
	} catch (err) {
		const imageFailure = imageInputFailure(err);
		if (imageFailure) return imageFailure;
		return toolResult(`pi_start: ${(err as Error).message}`.replace("pi_start: pi_start:", "pi_start:"), true);
	}
	const capabilityFailure = await preflightImageCapability(overrides.model, images, ctx);
	if (capabilityFailure) return capabilityFailure;

	const sessionId = randomUUID();
	rememberSession(sessionId, cwd, { model: overrides.model, thinking: overrides.thinking });
	const plan: RunPlan = {
		cwd,
		sessionId,
		prompt,
		...(images.length ? { images } : {}),
		overrides,
		timeoutMs: timeoutMs ?? TIMEOUT_MS,
	};
	const startedAt = Date.now();
	registerBackgroundRun({
		sessionId,
		cwd,
		startedAt,
		handle: undefined,
		status: "queued",
		lastProgress: "queued",
		lastEventAt: startedAt,
	});
	const backgroundToken = makeCancelToken();
	const backgroundContext: CallContext = {
		token: backgroundToken,
		...(ctx.progress === undefined ? {} : { progress: ctx.progress }),
	};
	reportProgress(backgroundContext, sessionId, startedAt, "queued", "queued");

	void withSessionLock(sessionId, () =>
		withSlot(async () => {
			reportProgress(backgroundContext, sessionId, startedAt, "running", "pi started");
			return invokePi(transport, plan, backgroundContext, startedAt, streamText);
		}),
	)
		.then((outcome) => {
			const result = renderOutcome(outcome, sessionId, timeoutMs ?? TIMEOUT_MS, images.length > 0);
			reportProgress(
				backgroundContext,
				sessionId,
				startedAt,
				result.isError === true ? "failed" : "finished",
				result.isError === true ? "run failed" : "finished",
			);
			completeBackgroundRun(sessionId, result);
		})
		.catch((err: unknown) => {
			const message = err instanceof Error ? err.message : String(err);
			const result = toolResult(`pi_start background run failed: ${message}`, true);
			reportProgress(backgroundContext, sessionId, startedAt, "failed", "run failed");
			completeBackgroundRun(sessionId, result);
		});

	return toolResult(
		`[session: ${sessionId}]\n[run: ${sessionId}]\n` +
			"Started in the background. Use pi_running to query progress, pi_send to intervene, " +
			"and pi_reply({ session }) to retrieve the final result.",
	);
}

// --- tools ----------------------------------------------------------------

export async function callPi(input: Record<string, unknown>, ctx: CallContext): Promise<ToolResult> {
	let prompt: string;
	let images: ReturnType<typeof readImages>;
	let cwd: string;
	let overrides: RunOverrides;
	let timeoutMs: number | undefined;
	let transport: Transport;
	let streamText: boolean;
	try {
		prompt = readPrompt(input.prompt, "pi");
		images = readImages(input.images, "pi");
		cwd = resolveCwd(input.cwd);
		overrides = readOverrides(input);
		timeoutMs = readTimeout(input.timeout_ms);
		streamText = readStream(input.stream, "pi");
		transport = resolveTransport(input.transport);
		if (images.length > 0 && transport.name === "print") {
			throw new ImageTransportError(
				"Image input requires the rpc transport; print transport has no image-capable prompt channel.",
			);
		}
	} catch (err) {
		const imageFailure = imageInputFailure(err);
		if (imageFailure) return imageFailure;
		return toolResult(`pi: ${(err as Error).message}`.replace("pi: pi:", "pi:"), true);
	}
	const capabilityFailure = await preflightImageCapability(overrides.model, images, ctx);
	if (capabilityFailure) return capabilityFailure;

	const sessionId = randomUUID();
	// Recorded before the run, not after: a run that times out or is cancelled is
	// still a real session on disk, and pi_reply needs to know its directory to
	// resume it. Remembering only on success is how a killed task becomes
	// unreachable.
	rememberSession(sessionId, cwd, { model: overrides.model, thinking: overrides.thinking });

	const plan: RunPlan = {
		cwd,
		sessionId,
		prompt,
		...(images.length ? { images } : {}),
		overrides,
		timeoutMs: timeoutMs ?? TIMEOUT_MS,
	};
	const startedAt = Date.now();
	reportProgress(ctx, sessionId, startedAt, "queued", "queued");
	const outcome = await withSlot(async () => {
		reportProgress(ctx, sessionId, startedAt, "running", "pi started");
		return invokePi(transport, plan, ctx, startedAt, streamText);
	});

	// A turn ended by abort exits cleanly, so the exit code alone would report a
	// timed-out or cancelled run as a normal answer. The flags are what say the
	// run was ended from outside rather than finished.
	if (outcome.result.code !== 0 || outcome.result.timedOut || outcome.result.cancelled) {
		reportProgress(ctx, sessionId, startedAt, "failed", outcome.result.timedOut ? "timed out" : "run failed");
		return attachImageOutcomeError(
			toolResult(
				renderFailure(outcome.acc, outcome.result, outcome.elapsedMs, {
					id: sessionId,
					tool: "pi",
					timeoutMs: timeoutMs ?? TIMEOUT_MS,
				}),
				true,
			),
			outcome.acc,
			images.length > 0,
			"pi run did not complete",
		);
	}

	reportProgress(ctx, sessionId, startedAt, "finished", "finished");
	return renderSuccess(outcome, `[session: ${sessionId}]`, images.length > 0);
}

export async function callPiReply(input: Record<string, unknown>, ctx: CallContext): Promise<ToolResult> {
	const session = input.session;
	if (typeof session !== "string" || session.trim() === "") {
		return toolResult("pi_reply: `session` is required.", true);
	}
	const background = getBackgroundRun(session);
	if (input.prompt === undefined) {
		if (input.images !== undefined) {
			return imageErrorResult(
				"image_input_not_allowed",
				"pi_reply without a prompt only retrieves a background result; provide prompt to start a new image turn.",
				false,
			);
		}
		if (background === undefined) {
			return toolResult(
				"pi_reply: `prompt` is required unless the session was started with `pi_start`; " +
					'use pi_reply({ session, prompt: "..." }) to continue or recover it.',
				true,
			);
		}
		return waitForBackgroundResult(background, ctx.token);
	}

	const known = getSession(session);
	let prompt: string;
	let images: ReturnType<typeof readImages>;
	let cwd: string;
	let overrides: RunOverrides;
	let timeoutMs: number | undefined;
	let transport: Transport;
	let streamText: boolean;
	try {
		prompt = readPrompt(input.prompt, "pi_reply");
		images = readImages(input.images, "pi_reply");
		cwd = resolveCwd(input.cwd ?? known?.cwd);
		overrides = readOverrides({
			...input,
			model: input.model ?? known?.model,
			thinking: input.thinking ?? known?.thinking,
		});
		timeoutMs = readTimeout(input.timeout_ms);
		streamText = readStream(input.stream, "pi_reply");
		transport = resolveTransport(input.transport);
		if (images.length > 0 && transport.name === "print") {
			throw new ImageTransportError(
				"Image input requires the rpc transport; print transport has no image-capable prompt channel.",
			);
		}
	} catch (err) {
		const imageFailure = imageInputFailure(err);
		if (imageFailure) return imageFailure;
		return toolResult(`pi_reply: ${(err as Error).message}`.replace("pi_reply: pi_reply:", "pi_reply:"), true);
	}
	const capabilityFailure = await preflightImageCapability(overrides.model, images, ctx);
	if (capabilityFailure) return capabilityFailure;

	const plan: RunPlan = {
		cwd,
		sessionId: session,
		prompt,
		...(images.length ? { images } : {}),
		overrides,
		timeoutMs: timeoutMs ?? TIMEOUT_MS,
	};
	const startedAt = Date.now();
	reportProgress(ctx, session, startedAt, "queued", "queued");
	const outcome = await withSessionLock(session, () => {
		// A prompt explicitly starts the next turn/recovery leg. Do not let a
		// completed pi_start result shadow that new turn on a later no-prompt call.
		forgetBackgroundRun(session);
		return withSlot(async () => {
			reportProgress(ctx, session, startedAt, "running", "pi started");
			return invokePi(transport, plan, ctx, startedAt, streamText);
		});
	});

	// A turn ended by abort exits cleanly, so the exit code alone would report a
	// timed-out or cancelled run as a normal answer. The flags are what say the
	// run was ended from outside rather than finished.
	if (outcome.result.code !== 0 || outcome.result.timedOut || outcome.result.cancelled) {
		reportProgress(ctx, session, startedAt, "failed", outcome.result.timedOut ? "timed out" : "run failed");
		// Keep the session current even on failure: the conversation on disk grew,
		// and the next attempt should resume in the same place.
		rememberSession(session, cwd, {});
		return attachImageOutcomeError(
			toolResult(
				renderFailure(outcome.acc, outcome.result, outcome.elapsedMs, {
					id: session,
					tool: "pi_reply",
					timeoutMs: timeoutMs ?? TIMEOUT_MS,
				}),
				true,
			),
			outcome.acc,
			images.length > 0,
			"pi run did not complete",
		);
	}

	// pi creates a session when the id is unknown, so warn instead of silently
	// starting a fresh conversation the caller believes is a continuation.
	const isNew = /No project session found with id/i.test(outcome.result.stderr);
	const remembered: { model?: string; thinking?: ThinkingLevel } = {};
	if (input.model !== undefined && overrides.model !== undefined) remembered.model = overrides.model;
	if (input.thinking !== undefined && overrides.thinking !== undefined) remembered.thinking = overrides.thinking;
	rememberSession(session, cwd, remembered);

	const prefix = isNew
		? `[warning: no existing session ${session} in ${cwd} — pi started a new one, so there is no prior context]`
		: null;
	reportProgress(ctx, session, startedAt, "finished", "finished");
	return renderSuccess(outcome, prefix, images.length > 0);
}

/** Utility flag, not an agent run: no session, no json stream, no accumulator. */
export async function callPiModels(input: Record<string, unknown>, ctx: CallContext): Promise<ToolResult> {
	const search = input.search;
	if (search !== undefined && typeof search !== "string") {
		return toolResult("pi_models: `search` must be a string.", true);
	}
	const args = ["--list-models", ...(search ? [search] : [])];
	const result = await withSlot(() => runPi(args, process.cwd(), { token: ctx.token }));
	if (result.cancelled) return toolResult("pi_models was cancelled.", true);
	if (result.code !== 0) {
		return toolResult(`pi --list-models exited with code ${result.code}.\n\n${tailStderr(result.stderr)}`, true);
	}
	const table = result.stdout.trim();
	if (!table) {
		return toolResult(search ? `No pi models match "${search}".` : "pi reported no available models.", true);
	}
	return toolResult(table);
}

/**
 * Pass one of pi's rpc commands into a running turn. The decision to send, what
 * to send, and when, all belong to the caller; this only carries the message.
 */
export function callPiSend(input: Record<string, unknown>): ToolResult {
	const session = input.session;
	if (typeof session !== "string" || session.trim() === "") {
		return toolResult("pi_send: `session` is required.", true);
	}

	const command = input.command ?? "steer";
	if (command !== "steer" && command !== "follow_up" && command !== "abort") {
		return toolResult(`pi_send: \`command\` must be steer, follow_up, or abort (got ${String(command)}).`, true);
	}

	const message = input.message;
	if (command !== "abort" && (typeof message !== "string" || message.trim() === "")) {
		return toolResult(`pi_send: \`message\` is required for ${command}.`, true);
	}
	if (message !== undefined && typeof message !== "string") {
		return toolResult("pi_send: `message` must be a string.", true);
	}

	const run = getRun(session);
	if (run === undefined) {
		const background = getBackgroundRun(session);
		if (background !== undefined && background.result === undefined) {
			return toolResult(
				`pi_send: session ${session} is ${background.status} but is not connected to pi yet. ` +
					"Query pi_running and retry once it reports can_send=true; this server does not queue messages automatically.",
				true,
			);
		}
		const alive = listRuns();
		const hint =
			alive.length === 0
				? "No pi turn is running under the rpc transport right now."
				: `Running sessions: ${alive.map((r) => r.sessionId).join(", ")}.`;
		return toolResult(
			`pi_send: session ${session} is not currently running, so there is nothing to send to. ${hint}\n` +
				"A finished session is continued with pi_reply instead. Only runs started with " +
				"transport 'rpc' can be reached mid-run.",
			true,
		);
	}

	run.handle.send(command === "abort" ? { type: "abort" } : { type: command, message });
	run.sent.push({ at: Date.now(), type: String(command) });
	updateRun(session, {
		status: command === "abort" ? "stopping" : "running",
		message: command === "abort" ? "abort requested" : `${command} sent`,
	});

	const elapsed = ((Date.now() - run.startedAt) / 1000).toFixed(1);
	return toolResult(
		`Sent ${command} to session ${session} (running for ${elapsed}s).\n` +
			"pi decides when to act on it; the result appears in the answer of the call that is still " +
			"waiting on this turn.",
	);
}

export function callPiRunning(): ToolResult {
	const active = listRuns();
	const seen = new Set(active.map((run) => run.sessionId));
	const runs = [...active, ...listBackgroundRuns().filter((run) => !seen.has(run.sessionId))].sort(
		(a, b) => a.startedAt - b.startedAt,
	);
	if (runs.length === 0) {
		return toolResult(
			"No pi turn is running under the rpc transport (none queued either). Runs started with transport " +
				"'print' do not appear here — pi reads nothing while it works in that mode.",
		);
	}
	const rows = runs.map((run) => {
		const elapsed = ((Date.now() - run.startedAt) / 1000).toFixed(1);
		const sent = run.sent.length > 0 ? ` sent: ${run.sent.map((s) => s.type).join(",")}` : "";
		const progress = run.lastProgress ? `  last: ${run.lastProgress}` : "";
		const lastEvent = new Date(run.lastEventAt).toISOString();
		const canSend = run.handle !== undefined;
		return (
			`${run.sessionId}  status=${run.status}  elapsed=${elapsed}s  cwd=${run.cwd}  ` +
			`can_send=${canSend} can_abort=${canSend}  last_event_at=${lastEvent}${progress}${sent}`
		);
	});
	return toolResult(`${rows.length} running:\n\n${rows.join("\n")}`);
}

export function callPiSessions(): ToolResult {
	const rows = listSessions().map(([id, entry]) => {
		const when = entry.lastAccessed ? new Date(entry.lastAccessed).toISOString() : "unknown";
		return `${id}  ${when}  ${entry.cwd}`;
	});
	if (rows.length === 0) {
		return toolResult("No pi sessions recorded yet. Start one with the `pi` tool.");
	}
	return toolResult(`${rows.length} session(s), newest first:\n\n${rows.join("\n")}`);
}
