// pi owns the conversation on disk (`--session-id`); this only remembers which
// directory a session belongs to, so `pi_reply` resumes in the right project.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { MAX_SESSIONS, STATE_FILE } from "./config.ts";
import { asRecord } from "./parse.ts";
import type { SessionRecord, ThinkingLevel } from "./types.ts";
import { isThinkingLevel } from "./types.ts";

const sessions = new Map<string, SessionRecord>();

function readRecord(value: unknown): SessionRecord | null {
	const entry = asRecord(value);
	if (entry === null || typeof entry.cwd !== "string") return null;
	const record: SessionRecord = {
		cwd: entry.cwd,
		lastAccessed: typeof entry.lastAccessed === "number" ? entry.lastAccessed : 0,
	};
	if (typeof entry.model === "string") record.model = entry.model;
	if (isThinkingLevel(entry.thinking)) record.thinking = entry.thinking;
	return record;
}

function readStateFile(): Map<string, SessionRecord> {
	const found = new Map<string, SessionRecord>();
	try {
		const parsed = asRecord(JSON.parse(readFileSync(STATE_FILE, "utf8")));
		if (parsed?.version !== 1) return found;
		const stored = asRecord(parsed.sessions);
		if (stored === null) return found;
		for (const [id, value] of Object.entries(stored)) {
			const record = readRecord(value);
			if (record !== null) found.set(id, record);
		}
	} catch {
		// No state yet, or it is unreadable — start empty rather than fail.
	}
	return found;
}

export function loadSessions(): void {
	sessions.clear();
	for (const [id, record] of readStateFile()) sessions.set(id, record);
	prune();
}

function prune(): void {
	if (sessions.size <= MAX_SESSIONS) return;
	const ordered = [...sessions.entries()].sort((a, b) => a[1].lastAccessed - b[1].lastAccessed);
	for (const [id] of ordered.slice(0, sessions.size - MAX_SESSIONS)) sessions.delete(id);
}

/**
 * Re-read before writing: another server process may own sessions this one has
 * never seen, and a blind snapshot write would delete them. tmp+rename only buys
 * atomicity of a single write, not read-modify-write safety.
 */
function save(): void {
	try {
		mkdirSync(dirname(STATE_FILE), { recursive: true });
		const merged = readStateFile();
		// Ours wins per id: this process just observed those runs.
		for (const [id, record] of sessions) merged.set(id, record);

		const ordered = [...merged.entries()].sort((a, b) => b[1].lastAccessed - a[1].lastAccessed);
		const payload = { version: 1, sessions: Object.fromEntries(ordered.slice(0, MAX_SESSIONS)) };
		const tmp = `${STATE_FILE}.${process.pid}.tmp`;
		writeFileSync(tmp, JSON.stringify(payload), { mode: 0o600 });
		renameSync(tmp, STATE_FILE);
	} catch (err) {
		process.stderr.write(`pi-mcp: could not persist sessions: ${(err as Error).message}\n`);
	}
}

export function getSession(id: string): SessionRecord | undefined {
	return sessions.get(id);
}

export function listSessions(): [string, SessionRecord][] {
	return [...sessions.entries()].sort((a, b) => b[1].lastAccessed - a[1].lastAccessed);
}

export interface RememberOptions {
	model?: string | undefined;
	thinking?: ThinkingLevel | undefined;
}

/**
 * Only overwrite what was actually supplied: spreading `{model: undefined}` over
 * the previous entry would erase a remembered choice, and the next reply would
 * silently fall back to the default model.
 */
export function rememberSession(id: string, cwd: string, extra: RememberOptions = {}): void {
	const prev = sessions.get(id);
	const next: SessionRecord = { ...prev, cwd, lastAccessed: Date.now() };
	if (extra.model !== undefined) next.model = extra.model;
	if (extra.thinking !== undefined) next.thinking = extra.thinking;
	sessions.set(id, next);
	prune();
	save();
}

// --- per-session mutex ----------------------------------------------------

/**
 * Two pi processes writing one session file would corrupt it. Process-local
 * only — see README for the cross-process caveat.
 */
const sessionLocks = new Map<string, { tail: Promise<unknown> }>();

export async function withSessionLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
	const previous = sessionLocks.get(id)?.tail ?? Promise.resolve();
	let release!: () => void;
	const current = new Promise<void>((resolve) => {
		release = resolve;
	});
	// The stored handle's identity is what cleanup compares against. Storing
	// `previous.then(...)` and comparing with `current` never matches, which used
	// to leak one map entry per distinct session id.
	const handle = { tail: previous.then(() => current) };
	sessionLocks.set(id, handle);
	await previous;
	try {
		return await fn();
	} finally {
		release();
		// Drop the entry once we are the tail, so the map does not grow forever.
		void Promise.resolve().then(() => {
			if (sessionLocks.get(id) === handle) sessionLocks.delete(id);
		});
	}
}

/** Test seam: how many locks are still held. */
export function lockCount(): number {
	return sessionLocks.size;
}
