import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, makeWorkspace, sessionIdOf, type Workspace } from "./helpers/client.ts";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

let ws: Workspace;

beforeAll(() => {
	ws = makeWorkspace();
});

afterAll(() => ws.cleanup());

describe("image input", () => {
	it("normalizes raw base64 and data URIs for rpc pi prompts", async () => {
		const client = new Client({ ...ws.env, FAKE_IMAGE_ECHO: "1" }, ws.dir);
		await client.handshake();
		const result = await client.tool("pi", {
			prompt: "describe the images",
			cwd: ws.dir,
			images: [
				{ data: PNG, mimeType: "image/png" },
				{ data: `data:image/png;base64,${PNG}`, mimeType: "image/png" },
			],
		});
		client.close();

		expect(result.isError).toBe(false);
		expect(result.text).toContain("IMAGES=2 MIME=image/png,image/png RAW=true");
	});

	it("supports an image on a pi_reply continuation", async () => {
		const client = new Client({ ...ws.env, FAKE_IMAGE_ECHO: "1" }, ws.dir);
		await client.handshake();
		const first = await client.tool("pi", { prompt: "start", cwd: ws.dir });
		const result = await client.tool("pi_reply", {
			session: sessionIdOf(first.text),
			prompt: "now inspect this",
			images: [{ data: PNG, mimeType: "image/png" }],
		});
		client.close();

		expect(result.isError).toBe(false);
		expect(result.text).toContain("IMAGES=1 MIME=image/png RAW=true");
	});

	it("preserves the nonblocking start and retrieval lifecycle with images", async () => {
		const client = new Client({ ...ws.env, FAKE_IMAGE_ECHO: "1" }, ws.dir);
		await client.handshake();
		const started = await client.tool("pi_start", {
			prompt: "inspect in background",
			cwd: ws.dir,
			images: [{ data: PNG, mimeType: "image/png" }],
		});
		const result = await client.tool("pi_reply", { session: sessionIdOf(started.text) });
		client.close();

		expect(started.isError).toBe(false);
		expect(result.isError).toBe(false);
		expect(result.text).toContain("IMAGES=1 MIME=image/png RAW=true");
	});

	it("returns stable structured errors for invalid images", async () => {
		const client = new Client(ws.env, ws.dir);
		await client.handshake();
		const badMime = await client.tool("pi", {
			prompt: "inspect",
			images: [{ data: PNG, mimeType: "image/bmp" }],
		});
		const badBytes = await client.tool("pi", {
			prompt: "inspect",
			images: [{ data: Buffer.from("not an image").toString("base64"), mimeType: "image/png" }],
		});
		client.close();

		expect(badMime.isError).toBe(true);
		expect(badMime.structuredContent?.error).toMatchObject({ code: "unsupported_mime_type", retryable: false });
		expect(badMime.text).toContain("[image_error: unsupported_mime_type]");
		expect(badBytes.structuredContent?.error).toMatchObject({ code: "invalid_image_data", retryable: false });
	});

	it("rejects images on print transport before starting pi", async () => {
		const client = new Client(ws.env, ws.dir);
		await client.handshake();
		const result = await client.tool("pi", {
			prompt: "inspect",
			transport: "print",
			images: [{ data: PNG, mimeType: "image/png" }],
		});
		client.close();

		expect(result.isError).toBe(true);
		expect(result.structuredContent?.error).toMatchObject({ code: "image_transport_error", retryable: false });
	});

	it("surfaces a model capability failure instead of dropping images", async () => {
		const client = new Client({ ...ws.env, FAKE_IMAGE_UNSUPPORTED: "1" }, ws.dir);
		await client.handshake();
		const result = await client.tool("pi", {
			prompt: "inspect",
			images: [{ data: PNG, mimeType: "image/png" }],
		});
		client.close();

		expect(result.isError).toBe(true);
		expect(result.structuredContent?.error).toMatchObject({ code: "unsupported_model", retryable: false });
		expect(result.text).toContain("Choose a model whose pi_models entry has images=yes");
	});

	it("preflights an explicitly selected model marked images=no", async () => {
		const client = new Client(ws.env, ws.dir);
		await client.handshake();
		const result = await client.tool("pi", {
			prompt: "inspect",
			model: "fake/alpha",
			images: [{ data: PNG, mimeType: "image/png" }],
		});
		client.close();

		expect(result.isError).toBe(true);
		expect(result.structuredContent?.error).toMatchObject({ code: "unsupported_model", retryable: false });
		expect(result.text).toContain("marked images=no");
	});

	it("does not treat background result retrieval as an image turn", async () => {
		const client = new Client({ ...ws.env, FAKE_IMAGE_ECHO: "1" }, ws.dir);
		await client.handshake();
		const started = await client.tool("pi_start", { prompt: "background", cwd: ws.dir });
		const result = await client.tool("pi_reply", {
			session: sessionIdOf(started.text),
			images: [{ data: PNG, mimeType: "image/png" }],
		});
		client.close();

		expect(result.isError).toBe(true);
		expect(result.structuredContent?.error).toMatchObject({ code: "image_input_not_allowed", retryable: false });
	});
});
