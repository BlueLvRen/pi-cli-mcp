#!/usr/bin/env node

// A stand-in for the pi binary. Emits a pi-shaped `--mode json` event stream so
// the tests can drive paths a live model cannot produce on demand.
//
// Controlled by env:
//   FAKE_MODE=answer       (default) narration + tool step, then a final answer
//   FAKE_MODE=big          one huge answer, size from FAKE_SIZE
//   FAKE_MODE=hang         never settles, so the test can cancel or time it out
//   FAKE_MODE=slow         settles after FAKE_DELAY_MS
//   FAKE_MODE=empty_final  settles with no text at all
//   FAKE_MODE=no_stop      final message carries no stopReason
//   FAKE_MODE=garbage      non-JSON output, i.e. a broken event contract
//   FAKE_MODE=no_newline   last event is EOF-terminated, not newline-terminated
//   FAKE_MODE=overlap      detects concurrent runs on one session via a lockfile
//   FAKE_STOP=<reason>     stopReason on the final message (default "stop")
//   FAKE_EXIT=<code>       exit code (default 0)
//   FAKE_STARTED_FILE      appended to with one line per invocation
//   FAKE_IMAGE_ECHO=1      report the image count/mime received by rpc
//   FAKE_IMAGE_UNSUPPORTED=1  settle with a vision-capability error
//
// Note: never call process.exit() after writing — stdout to a pipe is async and
// exiting truncates the stream. Set process.exitCode instead.

import { spawn } from "node:child_process";
import { appendFileSync, existsSync, unlinkSync, writeFileSync } from "node:fs";

const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const mode = process.env.FAKE_MODE ?? "answer";
const stop = process.env.FAKE_STOP ?? "stop";
const exitCode = Number(process.env.FAKE_EXIT ?? 0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Set by the scenarios that are supposed to never finish. They return as soon as
 * their timers are armed, so without this flag the rpc path would treat "the
 * scenario function returned" as "the turn is over" and exit — turning a hang
 * into a clean, instant exit.
 */
let holding = false;

if (process.env.FAKE_STARTED_FILE) {
	appendFileSync(process.env.FAKE_STARTED_FILE, `${process.pid}\n`);
}

// `--mode rpc`: pi stays up, reads JSONL commands on stdin, and ends the turn
// with agent_settled. Modelled on pi's own rpc-types.ts.
if (process.argv.includes("rpc")) {
	await runRpc();
} else if (process.argv.includes("--list-models")) {
	const filter = process.argv[process.argv.indexOf("--list-models") + 1];
	const rows = [
		"provider  model                 context  max-out  thinking  images",
		"fake      fake/alpha            1.0M     32.8K    yes       no",
		"fake      fake/beta             200K     32.8K    no        yes",
	];
	const kept =
		filter && !filter.startsWith("-") ? [rows[0], ...rows.slice(1).filter((r) => r.includes(filter))] : rows;
	process.stdout.write(`${kept.join("\n")}\n`);
	process.exitCode = exitCode;
} else {
	await runAgent();
}

async function runAgent() {
	out({ type: "session", id: "fake-session", cwd: process.cwd() });
	out({ type: "agent_start" });
	await runScenario();
}

async function runScenario() {
	// Real pi prints this on stderr when --session-id names a session it does not
	// have; the server turns it into an explicit warning instead of pretending the
	// conversation continued.
	if (process.env.FAKE_UNKNOWN_SESSION === "1") {
		const idx = process.argv.indexOf("--session-id");
		const id = idx === -1 ? "?" : process.argv[idx + 1];
		process.stderr.write(`Warning: No project session found with id '${id}'; creating a new session with that id.\n`);
	}

	if (mode === "garbage") {
		// A stream that is not the documented contract at all.
		process.stdout.write("this is not json\nneither is this\n");
		process.exitCode = exitCode;
		return;
	}

	if (mode === "overlap") {
		// Concurrency detector: if another instance holds the lock, say so loudly.
		const lock = process.env.FAKE_LOCK_FILE;
		const held = lock && existsSync(lock);
		if (lock && !held) writeFileSync(lock, String(process.pid));
		out({ type: "session", id: "fake-session", cwd: process.cwd() });
		out({ type: "turn_start" });
		await sleep(Number(process.env.FAKE_DELAY_MS ?? 300));
		finalMessage(held ? "OVERLAP DETECTED" : "EXCLUSIVE");
		if (lock && !held) unlinkSync(lock);
		process.exitCode = exitCode;
		return;
	}

	if (mode === "hang") {
		holding = true;
		out({ type: "turn_start" });
		// A child of its own, to assert the whole tree dies with the parent.
		spawnMarkedChild();
		setInterval(() => {}, 1000);
		return;
	}

	if (mode === "hang_after_work") {
		// Did real work and said something, then hangs before settling — the shape
		// of a task killed at the deadline with its result unreported.
		out({ type: "turn_start" });
		out({
			type: "message_end",
			message: {
				role: "assistant",
				provider: "fake",
				model: "fake-1",
				stopReason: "toolUse",
				usage: { input: 10, output: 4, cost: { total: 0 } },
				content: [
					{ type: "text", text: "PARTIAL: 43 tests pass, now showing the failure" },
					{ type: "toolCall", id: "c1", name: "write", arguments: { path: "note.md", content: "hi" } },
				],
			},
		});
		out({ type: "tool_execution_start", toolName: "write" });
		out({ type: "tool_execution_end", toolName: "write", isError: false });
		out({ type: "turn_start" });
		holding = true;
		spawnMarkedChild();
		setInterval(() => {}, 1000);
		return;
	}

	if (mode === "noisy_stderr") {
		// A failing run that dumps its session payload to stderr, prompt included.
		const message = (role, text) =>
			JSON.stringify({ type: "message_start", message: { role, content: [{ type: "text", text }] } });
		process.stderr.write(`${message("user", "SECRET_PROMPT_BODY")}\n`);
		process.stderr.write(`${message("assistant", "SECRET_PROMPT_BODY echoed")}\n`);
		process.stderr.write(`${JSON.stringify({ type: "message_end", message: { role: "user" } })}\n`);
		process.stderr.write("Error: upstream refused the request\n");
		process.exitCode = exitCode;
		return;
	}

	if (mode === "slow") {
		out({ type: "turn_start" });
		await sleep(Number(process.env.FAKE_DELAY_MS ?? 1500));
		finalMessage("SLOW ANSWER");
		process.exitCode = exitCode;
		return;
	}

	if (mode === "big") {
		out({ type: "turn_start" });
		finalMessage("X".repeat(Number(process.env.FAKE_SIZE ?? 200_000)));
		process.exitCode = exitCode;
		return;
	}

	if (mode === "empty_final") {
		// A settled message with no text: the answer is genuinely missing, and an
		// earlier narration must not be promoted into its place.
		out({ type: "turn_start" });
		out({
			type: "message_end",
			message: {
				role: "assistant",
				provider: "fake",
				model: "fake-1",
				stopReason: "toolUse",
				usage: { input: 10, output: 2, cost: { total: 0 } },
				content: [
					{ type: "text", text: "NARRATION: about to do it." },
					{ type: "toolCall", id: "c1", name: "read", arguments: { path: "a.txt" } },
				],
			},
		});
		out({ type: "tool_execution_start", toolName: "read" });
		out({ type: "tool_execution_end", toolName: "read", isError: false });
		out({
			type: "message_end",
			message: {
				role: "assistant",
				provider: "fake",
				model: "fake-1",
				stopReason: "stop",
				usage: { input: 20, output: 0, cost: { total: 0 } },
				content: [],
			},
		});
		out({ type: "agent_end", willRetry: false });
		process.exitCode = exitCode;
		return;
	}

	if (mode === "child_then_answer") {
		// Leaves a detached grandchild behind and then answers normally — a pi that
		// does not clean up after itself. The server must not rely on it doing so.
		out({ type: "turn_start" });
		spawnMarkedChild();
		finalMessage("ANSWERED WITH CHILD LEFT");
		out({ type: "agent_end", willRetry: false });
		out({ type: "agent_settled" });
		process.exitCode = exitCode;
		return;
	}

	if (mode === "empty_completion") {
		// stopReason "stop" with an entirely empty content array: the stream is
		// well-formed and pi settles the turn, the model just said nothing.
		out({ type: "turn_start" });
		out({
			type: "message_end",
			message: {
				role: "assistant",
				provider: "fake",
				model: "fake-1",
				stopReason: "stop",
				usage: { input: 4748, output: 0, cost: { total: 0 } },
				content: [],
			},
		});
		out({ type: "agent_end", willRetry: false });
		out({ type: "agent_settled" });
		process.exitCode = exitCode;
		return;
	}

	if (mode === "error_turn") {
		// pi's error-termination contract: stopReason "error" plus errorMessage, and
		// no text at all. This is what a failed turn actually looks like.
		out({ type: "turn_start" });
		out({
			type: "message_end",
			message: {
				role: "assistant",
				provider: "fake",
				model: "fake-1",
				stopReason: "error",
				errorMessage: process.env.FAKE_ERROR_MESSAGE ?? "context window exceeded: 1048576 > 1000000 tokens",
				diagnostics: [{ type: "provider_error", timestamp: 0, error: { message: "upstream 400" } }],
				usage: { input: 12, output: 0, cost: { total: 0 } },
				content: [],
			},
		});
		out({ type: "agent_end", willRetry: false });
		out({ type: "agent_settled" });
		process.exitCode = exitCode;
		return;
	}

	if (mode === "no_stop") {
		out({ type: "turn_start" });
		out({
			type: "message_end",
			message: {
				role: "assistant",
				provider: "fake",
				model: "fake-1",
				usage: { input: 20, output: 5, cost: { total: 0 } },
				content: [{ type: "text", text: "ANSWER WITHOUT STOP REASON" }],
			},
		});
		out({ type: "agent_end", willRetry: false });
		process.exitCode = exitCode;
		return;
	}

	if (mode === "no_newline") {
		out({ type: "turn_start" });
		// Deliberately no trailing newline on the final event.
		process.stdout.write(
			JSON.stringify({
				type: "message_end",
				message: {
					role: "assistant",
					provider: "fake",
					model: "fake-1",
					stopReason: "stop",
					usage: { input: 20, output: 5, cost: { total: 0 } },
					content: [{ type: "text", text: "EOF TERMINATED ANSWER" }],
				},
			}),
		);
		process.exitCode = exitCode;
		return;
	}

	// Default: narration + tool call in one message, then the real answer. This is
	// the shape that makes "last text block" the wrong definition of the answer.
	out({ type: "turn_start" });
	out({
		type: "message_end",
		message: {
			role: "assistant",
			provider: "fake",
			model: "fake-1",
			stopReason: "toolUse",
			usage: { input: 10, output: 2, reasoning: 7, cost: { total: 0 } },
			content: [
				{ type: "text", text: "NARRATION: I'll check that for you." },
				{ type: "toolCall", id: "c1", name: "write", arguments: { path: "note.md", content: "hi" } },
			],
		},
	});
	out({ type: "tool_execution_start", toolName: "write" });
	out({ type: "tool_execution_end", toolName: "write", isError: false });
	out({ type: "turn_start" });
	finalMessage("FINAL ANSWER");
	out({ type: "agent_end", willRetry: false });
	out({ type: "agent_settled" });
	process.exitCode = exitCode;
}

/**
 * The rpc side of the fake: read JSONL commands and answer them.
 *
 * On `prompt` it plays the same FAKE_MODE scenario as print mode, because real pi
 * emits the same event stream in both. FAKE_RPC_WAIT=1 makes the turn sit and
 * wait for a steer or an abort instead, which is what the mid-run message tests
 * need; FAKE_RPC_SETTLE_MS answers after a delay.
 */
async function runRpc() {
	out({ type: "session", id: "fake-session", cwd: process.cwd() });
	out({ type: "agent_start" });

	const settleMs = process.env.FAKE_RPC_SETTLE_MS;
	let settled = false;
	const received = [];

	const settle = (text) => {
		if (settled) return;
		settled = true;
		out({ type: "turn_start" });
		finalMessage(text);
		out({ type: "agent_end", willRetry: false });
		out({ type: "agent_settled" });
	};

	const settleImageError = () => {
		if (settled) return;
		settled = true;
		out({ type: "turn_start" });
		out({
			type: "message_end",
			message: {
				role: "assistant",
				provider: "fake",
				model: "fake/alpha",
				stopReason: "error",
				errorMessage: "Current model does not support images.",
				usage: { input: 20, output: 0, cost: { total: 0 } },
				content: [],
			},
		});
		out({ type: "agent_end", willRetry: false });
		out({ type: "agent_settled" });
	};

	let buffer = "";
	process.stdin.setEncoding("utf8");
	process.stdin.on("data", (chunk) => {
		buffer += chunk;
		let nl = buffer.indexOf("\n");
		while (nl !== -1) {
			const line = buffer.slice(0, nl).trim();
			buffer = buffer.slice(nl + 1);
			nl = buffer.indexOf("\n");
			if (!line) continue;

			let cmd;
			try {
				cmd = JSON.parse(line);
			} catch {
				continue;
			}
			received.push(cmd.type);
			out({ type: "response", command: cmd.type, success: true });

			if (cmd.type === "prompt") {
				if (process.env.FAKE_IMAGE_UNSUPPORTED === "1" && Array.isArray(cmd.images) && cmd.images.length > 0) {
					settleImageError();
				} else if (process.env.FAKE_IMAGE_ECHO === "1" && Array.isArray(cmd.images) && cmd.images.length > 0) {
					const mimeTypes = cmd.images.map((image) => image.mimeType).join(",");
					const rawBase64 = cmd.images.every(
						(image) => typeof image.data === "string" && !image.data.startsWith("data:"),
					);
					settle(`IMAGES=${cmd.images.length} MIME=${mimeTypes} RAW=${rawBase64}`);
				} else if (settleMs) {
					out({ type: "turn_start" });
					setTimeout(() => settle("RPC ANSWER"), Number(settleMs));
				} else if (process.env.FAKE_RPC_WAIT === "1") {
					out({ type: "turn_start" });
					spawnMarkedChild();
				} else {
					settled = true;
					void runScenario().then(() => {
						// Real pi ends a turn with agent_settled, and the server closes stdin on
						// that event. Scenarios that deliberately break the message contract emit
						// no such event, so the fake exits by itself rather than sit until the
						// deadline — unless it is a scenario whose whole point is to hang. The
						// delay lets stdout flush.
						if (holding) return;
						setTimeout(() => process.exit(exitCode), 20);
					});
				}
			} else if (cmd.type === "steer") {
				// A steered turn reports what it was told, so the test can prove the
				// message reached a turn that was already running.
				settle(`STEERED: ${cmd.message}`);
			} else if (cmd.type === "follow_up") {
				settle(`FOLLOW_UP QUEUED: ${cmd.message}`);
			} else if (cmd.type === "abort") {
				// Mirrors pi closely enough for the tests that matter: an aborted turn
				// still reports through the event stream. FAKE_RPC_IGNORE_ABORT makes it
				// unresponsive instead, so the signal fallback can be exercised.
				if (process.env.FAKE_RPC_IGNORE_ABORT === "1") continue;
				settle("ABORTED");
			}
		}
	});
	process.stdin.on("end", () => {
		process.exitCode = exitCode;
		// Mirrors pi: closing stdin is how rpc mode is asked to exit.
		setTimeout(() => process.exit(exitCode), 20);
	});
	// Keep the process alive while it waits for commands.
	setInterval(() => {}, 1000);
}

/**
 * A long-lived grandchild, so a test can assert the whole process tree dies.
 * Tagged with FAKE_CHILD_TAG: test files run in parallel, and a bare `sleep 120`
 * would be found by every test's pgrep, not just the one that spawned it.
 */
function spawnMarkedChild() {
	const tag = process.env.FAKE_CHILD_TAG ?? "pi-cli-mcp-child";
	if (process.platform === "win32") {
		spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", tag], { stdio: "ignore" });
		return;
	}
	// Two commands, deliberately: with a single one `sh -c` execs it and replaces
	// its own image, which drops the tag from the command line that pgrep -f
	// matches on. The trailing `true` keeps the shell — and the tag — alive.
	spawn("sh", ["-c", `sleep 120; true # ${tag}`], { stdio: "ignore" });
}

function finalMessage(text) {
	if (process.env.FAKE_STREAM === "1") {
		for (const delta of ["streamed ", "preview"]) {
			out({
				type: "message_update",
				usage: { input: 20, output: 1, cost: { total: 0 } },
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta },
			});
		}
	}
	out({
		type: "message_end",
		message: {
			role: "assistant",
			provider: "fake",
			model: "fake-1",
			stopReason: stop,
			usage: { input: 20, output: 5, cost: { total: 0.0012 } },
			content: [{ type: "text", text }],
		},
	});
}
