import type { PiImageContent } from "./types.ts";

export const IMAGE_MIME_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;
export type ImageMimeType = (typeof IMAGE_MIME_TYPES)[number];

/** DeepSeek's current inline-image limits, kept here as adapter limits too. */
export const MAX_IMAGES = 600;
export const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
export const MAX_TOTAL_IMAGE_BYTES = 64 * 1024 * 1024;

export type ImageInputErrorCode =
	| "invalid_image_data"
	| "unsupported_mime_type"
	| "image_too_large"
	| "image_request_too_large";

export class ImageTransportError extends Error {
	readonly code = "image_transport_error" as const;
	readonly retryable = false;

	constructor(message: string) {
		super(message);
		this.name = "ImageTransportError";
	}
}

export class ImageInputError extends Error {
	readonly code: ImageInputErrorCode;
	readonly imageIndex: number | undefined;
	readonly retryable = false;

	constructor(code: ImageInputErrorCode, message: string, imageIndex?: number) {
		super(message);
		this.name = "ImageInputError";
		this.code = code;
		this.imageIndex = imageIndex;
	}
}

interface ImageInput {
	data: string;
	mimeType: string;
}

/**
 * Convert caller input to pi's ImageContent shape. Only inline base64 is
 * accepted: paths, URLs and provider-specific file ids would make this adapter
 * behave differently across providers and are deliberately not forwarded.
 */
export function readImages(value: unknown, tool: string): PiImageContent[] {
	if (value === undefined || value === null) return [];
	if (!Array.isArray(value)) throw new ImageInputError("invalid_image_data", `${tool}: images must be an array`);
	if (value.length > MAX_IMAGES) {
		throw new ImageInputError(
			"image_request_too_large",
			`${tool}: images contains ${value.length} items; maximum is ${MAX_IMAGES}`,
		);
	}

	let totalBytes = 0;
	return value.map((raw, index) => {
		const image = readImageInput(raw, index, tool);
		const decoded = decodeBase64(image.data, index, tool);
		if (decoded.byteLength > MAX_IMAGE_BYTES) {
			throw new ImageInputError(
				"image_too_large",
				`${tool}: image ${index} is ${decoded.byteLength} bytes; maximum is ${MAX_IMAGE_BYTES} bytes`,
				index,
			);
		}
		if (!hasImageSignature(decoded, image.mimeType)) {
			throw new ImageInputError(
				"invalid_image_data",
				`${tool}: image ${index} bytes do not match mimeType ${image.mimeType}`,
				index,
			);
		}
		totalBytes += decoded.byteLength;
		if (totalBytes > MAX_TOTAL_IMAGE_BYTES) {
			throw new ImageInputError(
				"image_request_too_large",
				`${tool}: decoded images total ${totalBytes} bytes; maximum is ${MAX_TOTAL_IMAGE_BYTES} bytes`,
			);
		}
		return { type: "image", data: image.data, mimeType: image.mimeType };
	});
}

function readImageInput(value: unknown, index: number, tool: string): { data: string; mimeType: ImageMimeType } {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new ImageInputError("invalid_image_data", `${tool}: images[${index}] must be an object`, index);
	}
	const input = value as Partial<ImageInput>;
	if (typeof input.data !== "string" || input.data.trim() === "") {
		throw new ImageInputError("invalid_image_data", `${tool}: images[${index}].data must be non-empty base64`, index);
	}
	if (typeof input.mimeType !== "string") {
		throw new ImageInputError("invalid_image_data", `${tool}: images[${index}].mimeType must be a string`, index);
	}

	const mimeType = input.mimeType.toLowerCase();
	if (!(IMAGE_MIME_TYPES as readonly string[]).includes(mimeType)) {
		throw new ImageInputError(
			"unsupported_mime_type",
			`${tool}: images[${index}].mimeType ${JSON.stringify(input.mimeType)} is unsupported; use ${IMAGE_MIME_TYPES.join(", ")}`,
			index,
		);
	}

	let data = input.data.trim();
	if (data.startsWith("data:")) {
		const match = data.match(/^data:([^;,]+);base64,([A-Za-z0-9+/=_-]+)$/i);
		if (!match?.[1] || !match[2]) {
			throw new ImageInputError(
				"invalid_image_data",
				`${tool}: images[${index}].data is not a valid base64 data URI`,
				index,
			);
		}
		if (match[1].toLowerCase() !== mimeType) {
			throw new ImageInputError(
				"invalid_image_data",
				`${tool}: images[${index}] data URI mime type ${match[1]} does not match mimeType ${mimeType}`,
				index,
			);
		}
		data = match[2];
	}

	return { data: data.replace(/-/g, "+").replace(/_/g, "/"), mimeType: mimeType as ImageMimeType };
}

function decodeBase64(data: string, index: number, tool: string): Uint8Array {
	if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data) || data.length % 4 === 1 || data.length === 0) {
		throw new ImageInputError("invalid_image_data", `${tool}: images[${index}].data is not valid base64`, index);
	}
	try {
		const bytes = Buffer.from(data, "base64");
		if (bytes.length === 0 || bytes.toString("base64").replace(/=+$/, "") !== data.replace(/=+$/, "")) {
			throw new Error("round-trip mismatch");
		}
		return bytes;
	} catch {
		throw new ImageInputError("invalid_image_data", `${tool}: images[${index}].data is not valid base64`, index);
	}
}

function hasImageSignature(bytes: Uint8Array, mimeType: ImageMimeType): boolean {
	if (mimeType === "image/png") return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	if (mimeType === "image/jpeg") return startsWith(bytes, [0xff, 0xd8, 0xff]);
	if (mimeType === "image/gif") return ascii(bytes, 0, "GIF87a") || ascii(bytes, 0, "GIF89a");
	return ascii(bytes, 0, "RIFF") && ascii(bytes, 8, "WEBP");
}

function startsWith(bytes: Uint8Array, signature: number[]): boolean {
	return signature.every((byte, index) => bytes[index] === byte);
}

function ascii(bytes: Uint8Array, offset: number, value: string): boolean {
	return [...value].every((char, index) => bytes[offset + index] === char.charCodeAt(0));
}
