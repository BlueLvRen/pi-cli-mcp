import { homedir } from "node:os";
import { join } from "node:path";

function numEnv(name: string, fallback: number, min: number): number {
	const raw = process.env[name];
	if (raw === undefined || raw === "") return fallback;
	const value = Number(raw);
	if (!Number.isFinite(value) || value < min) {
		process.stderr.write(`pi-mcp: ignoring invalid ${name}=${raw}, using ${fallback}\n`);
		return fallback;
	}
	return value;
}

export const PI_BIN = process.env.PI_MCP_BIN ?? "pi";

/**
 * Optional command prefix, e.g. PI_MCP_WRAP="sandbox-exec -f /path/profile.sb".
 * Lets you jail pi without this server knowing anything about the sandbox.
 */
export const PI_WRAP = (process.env.PI_MCP_WRAP ?? "").trim();

/**
 * Default wall clock for one run. A caller can raise or lower it per call with
 * `timeout_ms`, because the right limit is a property of the task, not of the
 * server: a task killed at an arbitrary global deadline loses its result even
 * though the work was done.
 */
export const TIMEOUT_MS = numEnv("PI_MCP_TIMEOUT_MS", 1_800_000, 1_000);
/** Hard ceiling on what a per-call `timeout_ms` may ask for. 24h by default. */
export const MAX_TIMEOUT_MS = numEnv("PI_MCP_MAX_TIMEOUT_MS", 86_400_000, 1_000);
export const KILL_GRACE_MS = numEnv("PI_MCP_KILL_GRACE_MS", 5_000, 0);

/**
 * How long a transport that can end a turn in-protocol gets to do so before
 * signals are sent. Only the rpc transport can: it sends pi's own `abort`.
 * Counted on top of the run's deadline, so a timeout can overrun by this much.
 */
export const ABORT_GRACE_MS = numEnv("PI_MCP_ABORT_GRACE_MS", 5_000, 0);

/**
 * The answer is what the caller asked for, so it is NOT truncated by default: if
 * pi produced it, it goes to the caller in full. Set PI_MCP_MAX_OUTPUT to opt
 * into a cap. MAX_CAPTURE below is the only backstop, and it bounds the read
 * buffer so a runaway stream cannot exhaust memory — a process guard, not an
 * editorial limit on the answer.
 */
export const MAX_OUTPUT = process.env.PI_MCP_MAX_OUTPUT
	? numEnv("PI_MCP_MAX_OUTPUT", Number.POSITIVE_INFINITY, 1_000)
	: Number.POSITIVE_INFINITY;

/** stderr is diagnostics, not the deliverable: keep only a small tail. */
export const STDERR_LIMIT = numEnv("PI_MCP_STDERR_LIMIT", 1_500, 200);

/**
 * Forward stderr verbatim, including lines that parse as protocol events.
 * The strict reading of the protocol is that events belong on stdout, so such a
 * line is a channel violation; dropping it is a guard on top, and this switch
 * turns the guard off.
 */
export const KEEP_STDERR_EVENTS = process.env.PI_MCP_STDERR_KEEP_EVENTS === "1";

export const MAX_CAPTURE = numEnv("PI_MCP_MAX_CAPTURE", 16_000_000, 100_000);

/**
 * Bounds on a single unterminated line: one from pi's event stream, one from the
 * client's JSON-RPC stream. Without them a stream that never sends a newline
 * grows until the process dies, taking every pending response with it.
 */
export const MAX_LINE = numEnv("PI_MCP_MAX_LINE", 8_000_000, 100_000);
export const MAX_FRAME = numEnv("PI_MCP_MAX_FRAME", 8_000_000, 100_000);

export const MAX_SESSIONS = numEnv("PI_MCP_MAX_SESSIONS", 200, 1);
export const MAX_CONCURRENT = numEnv("PI_MCP_MAX_CONCURRENT", 4, 1);

export const STATE_FILE = process.env.PI_MCP_STATE ?? join(homedir(), ".local", "state", "pi-mcp", "sessions.json");

export const DEFAULT_MODEL = process.env.PI_MCP_MODEL ?? null;
export const DEFAULT_THINKING = process.env.PI_MCP_THINKING ?? null;

/**
 * Which way to drive pi when a call does not say: `print` (`pi -p --mode json`,
 * one process per turn) or `rpc` (`pi --mode rpc`, process stays up and accepts
 * commands on stdin, so a running turn can be sent a message).
 */
export const DEFAULT_TRANSPORT = process.env.PI_MCP_TRANSPORT === "rpc" ? "rpc" : "print";

/** argv has an OS size limit; longer prompts go through a temp file instead. */
export const MAX_PROMPT = 2_000_000;
export const ARGV_PROMPT_LIMIT = 100_000;

export const SERVER_INFO = { name: "pi", version: "0.4.0" } as const;
export const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;
export const FALLBACK_PROTOCOL = "2025-06-18";
