// Copyright 2026 the AAI authors. MIT license.
/**
 * In-process store for the `remember`/`recall` builtins' session notes.
 *
 * Session-scoped notes, in the spirit of Letta/MemGPT's memory-block tools:
 * small labeled values the agent writes and re-reads via tool calls. On a
 * voice call the transcript is noisy (misheard IDs, self-corrections), so
 * persisting a value once confirmed — and recalling it instead of re-reading
 * the transcript — keeps later tool arguments exact.
 *
 * The store is in-process and module-level, keyed by sessionId: notes are
 * per-session working memory, not durable data. Map updates are synchronous,
 * which is what makes one LLM step's concurrent tool calls safe without the
 * per-key promise-chain lock the old KV-backed implementation needed.
 * Expired entries are pruned lazily on access, and total entries are capped
 * (evicting oldest) so an abandoned host process can't grow unboundedly.
 */

type NotesEntry = { notes: Record<string, string>; expiresAt: number };

const sessionNotes = new Map<string, NotesEntry>();

/**
 * TTL for a session's `remember`/`recall` notes in the in-process store.
 * Notes are scoped to one voice session, which is bounded by the idle
 * timeout — a generous TTL only guarantees abandoned sessions' notes don't
 * accumulate in the host process.
 */
export const SESSION_NOTES_TTL_MS = 86_400_000;
/** Hard cap on tracked sessions; oldest entries are evicted past it. */
const MAX_SESSION_NOTES_ENTRIES = 10_000;

function liveNotesEntry(sessionId: string): NotesEntry | undefined {
  const entry = sessionNotes.get(sessionId);
  if (!entry) return;
  if (entry.expiresAt <= Date.now()) {
    sessionNotes.delete(sessionId);
    return;
  }
  return entry;
}

/** All live notes for a session (empty record when none). */
export function readNotes(ctx: { sessionId: string }): Record<string, string> {
  return liveNotesEntry(ctx.sessionId)?.notes ?? {};
}

/** Write one note; returns the session's full note record. */
export function writeNote(sessionId: string, key: string, value: string): Record<string, string> {
  const entry = liveNotesEntry(sessionId) ?? { notes: {}, expiresAt: 0 };
  entry.notes[key] = value;
  entry.expiresAt = Date.now() + SESSION_NOTES_TTL_MS;
  // Delete-then-set moves the session to the back of the Map's insertion
  // order, so the eviction below always removes the least-recently-written.
  sessionNotes.delete(sessionId);
  sessionNotes.set(sessionId, entry);
  while (sessionNotes.size > MAX_SESSION_NOTES_ENTRIES) {
    const oldest = sessionNotes.keys().next().value;
    if (oldest === undefined) break;
    sessionNotes.delete(oldest);
  }
  return entry.notes;
}
