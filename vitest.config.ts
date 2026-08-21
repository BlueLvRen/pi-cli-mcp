import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		// Every test drives a real server process and a real (fake) pi binary.
		testTimeout: 30_000,
		hookTimeout: 30_000,
		reporters: process.env.GITHUB_ACTIONS ? ["dot", "github-actions"] : ["default"],
		include: ["test/**/*.test.ts"],
		// Type-level tests assert our view of pi's wire contract against the
		// installed @earendil-works/pi-* types.
		typecheck: {
			enabled: true,
			include: ["test/**/*.test-d.ts"],
			tsconfig: "./tsconfig.json",
		},
	},
});
