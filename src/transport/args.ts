// Argument assembly shared by the transports.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ARGV_PROMPT_LIMIT } from "../config.ts";
import type { RunOverrides } from "../types.ts";

export function overrideArgs(overrides: RunOverrides): string[] {
	const args: string[] = [];
	if (overrides.model) args.push("--model", overrides.model);
	if (overrides.thinking) args.push("--thinking", overrides.thinking);
	if (overrides.no_tools) args.push("--no-tools");
	else if (overrides.tools) args.push("--tools", overrides.tools);
	if (overrides.system_prompt_append) args.push("--append-system-prompt", overrides.system_prompt_append);
	return args;
}

/**
 * The argv tail carrying the prompt, plus cleanup for any temp file.
 *
 * Only print mode needs this: pi has no `--` separator, so a dash-leading prompt
 * would parse as a flag, and argv has an OS size limit. rpc mode sends the
 * prompt inside a command, where neither problem exists.
 */
export function promptArgs(prompt: string): { args: string[]; cleanup: () => void } {
	if (!prompt.startsWith("-") && prompt.length <= ARGV_PROMPT_LIMIT) {
		return { args: [prompt], cleanup: () => {} };
	}
	const dir = mkdtempSync(join(tmpdir(), "pi-mcp-"));
	const file = join(dir, "prompt.md");
	writeFileSync(file, prompt, { mode: 0o600 });
	return {
		args: [`@${file}`, "Your task is the full contents of the attached file. Follow it exactly."],
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	};
}
