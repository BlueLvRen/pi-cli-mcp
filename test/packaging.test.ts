// The published package must stay dependency-free at runtime. pi's types are
// borrowed at compile time (src/types.ts), which is only safe as long as every
// such import is `import type` and therefore erased.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(root, "src");

function sourceFiles(): string[] {
	return readdirSync(srcDir)
		.filter((name) => name.endsWith(".ts"))
		.map((name) => join(srcDir, name));
}

describe("runtime dependencies", () => {
	it("has no dependencies declared at all", () => {
		const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
		expect(pkg.dependencies ?? {}).toEqual({});
	});

	it("imports pi's packages only as types", () => {
		for (const file of sourceFiles()) {
			const text = readFileSync(file, "utf8");
			const lines = text.split("\n");
			for (const [index, line] of lines.entries()) {
				if (!line.includes("@earendil-works/")) continue;
				// A comment mentioning the package is fine; a value import is not.
				const isImport = /^\s*(import|export)\b/.test(line);
				if (!isImport) continue;
				expect(
					/^\s*(import|export)\s+type\b/.test(line),
					`${file}:${index + 1} imports a pi package as a value: ${line.trim()}`,
				).toBe(true);
			}
		}
	});

	it("imports nothing outside node: builtins and relative paths", () => {
		for (const file of sourceFiles()) {
			const text = readFileSync(file, "utf8");
			for (const match of text.matchAll(/^\s*import\s+(?!type\b)[^;]*?from\s+["']([^"']+)["']/gm)) {
				const specifier = match[1] ?? "";
				const allowed = specifier.startsWith("node:") || specifier.startsWith("./") || specifier.startsWith("../");
				expect(allowed, `${file} has a runtime import of ${specifier}`).toBe(true);
			}
		}
	});
});

describe("packaging", () => {
	it("ships the built output and nothing else", () => {
		const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
		expect(pkg.files).toContain("dist");
		expect(pkg.bin["pi-cli-mcp"]).toBe("dist/index.js");
		// src/ and test/ must not be published: the bin is the built artifact.
		expect(pkg.files).not.toContain("src");
		expect(pkg.files).not.toContain("test");
	});

	it("declares the node version the code actually needs", () => {
		const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
		// Object.hasOwn (ES2022) and node: prefixes are used throughout.
		expect(pkg.engines.node).toBe(">=22");
	});
});
