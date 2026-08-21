import { DEFAULT_TRANSPORT } from "../config.ts";
import { printTransport } from "./print.ts";
import { rpcTransport } from "./rpc.ts";
import type { Transport, TransportName } from "./types.ts";

export const TRANSPORTS: Record<TransportName, Transport> = {
	print: printTransport,
	rpc: rpcTransport,
};

export const TRANSPORT_NAMES = Object.keys(TRANSPORTS) as TransportName[];

export function isTransportName(value: unknown): value is TransportName {
	return typeof value === "string" && value in TRANSPORTS;
}

/** The transport for a call: explicit choice, else the server default. */
export function resolveTransport(requested: unknown): Transport {
	if (requested === undefined || requested === null) {
		const fallback = TRANSPORTS[DEFAULT_TRANSPORT];
		return fallback;
	}
	if (!isTransportName(requested)) {
		throw new Error(`unknown transport "${String(requested)}"; expected one of ${TRANSPORT_NAMES.join(", ")}`);
	}
	return TRANSPORTS[requested];
}

export { getRun, listRuns } from "./registry.ts";
export type { RunPlan, Transport, TransportName } from "./types.ts";
