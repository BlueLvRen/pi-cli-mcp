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

if (process.env.FAKE_STARTED_FILE) {
	appendFileSync(process.env.FAKE_STARTED_FILE, `${process.pid}\n`);
}

// `pi --list-models` is a utility flag, not an agent run: emit the table and
// stop. This must not fall through into the event stream below.
if (process.argv.includes("--list-models")) {
	const filter = process.argv[process.argv.indexOf("--list-models") + 1];
	const rows = [
		"provider  model                 context  max-out  thinking  images",
		"fake      fake/alpha            1.0M     32.8K    yes       no",
		"fake      fake/beta             200K     32.8K    no        no",
	];
	const kept =
		filter && !filter.startsWith("-") ? [rows[0], ...rows.slice(1).filter((r) => r.includes(filter))] : rows;
	process.stdout.write(`${kept.join("\n")}\n`);
	process.exitCode = exitCode;
} else {
	await runAgent();
}

async function runAgent() {
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

	out({ type: "session", id: "fake-session", cwd: process.cwd() });
	out({ type: "agent_start" });

	if (mode === "hang") {
		out({ type: "turn_start" });
		// A child of its own, to assert the whole tree dies with the parent.
		spawn("sleep", ["120"], { stdio: "ignore" });
		setInterval(() => {}, 1000);
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

function finalMessage(text) {
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
