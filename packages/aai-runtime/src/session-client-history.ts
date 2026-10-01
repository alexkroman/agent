// Copyright 2026 the AAI authors. MIT license.
/**
 * A client's conversation, read back across its sessions — what makes a device
 * that connects with `?client=<id>` have ONE conversation rather than one per
 * wake word.
 *
 * Two readers over one durable index (`session-state/clients.ts`):
 *
 * - {@link loadClientHistory}, at every connect that names a client: the
 *   client's recent prior sessions, newest first until a budget is spent,
 *   handed back OLDEST first as one event list for `historyFromEvents` — so the
 *   model's view and the client's `history.restored` are built by the same walk
 *   a same-session resume uses, and cannot disagree about what a turn is.
 * - {@link readClientTranscript}, behind `stepClientTranscript`: the same log as
 *   a plain transcript, for the app's own summarizer.
 *
 * ## The budget, and why it is characters
 *
 * {@link CLIENT_HISTORY_TOKEN_BUDGET} tokens, estimated at
 * {@link CHARS_PER_TOKEN} characters each, counted over what the model would
 * READ (transcript text, and each prior tool result as it is seeded again) rather
 * than over events. A tokenizer here would be a provider dependency for a number
 * whose job is "bounded", not "exact"; chars/4 is the usual English estimate
 * and errs a little high for speech. The budget is spent newest-first and the session it
 * runs out in contributes its most recent events, so what is dropped is always
 * the oldest. The record's own memory bound (`HISTORY_RETAIN_TOKENS`, applied
 * by `historyFromEvents`) is far larger and only ever applies after this one.
 *
 * The APP narrows further with `sessionContext`'s `historySince`: a session
 * whose last event is older is not read at all, and older events of one that
 * straddles it are dropped — the part its summary already covers.
 *
 * ## Resets
 *
 * A `session.reset` in a prior session clears what came before it, exactly as it
 * does within one: the walk is the same walk. The raw events are still kept,
 * and {@link readClientTranscript} ignores resets — a summarizer reads what was
 * said, whatever the caller asked the agent to forget in the moment.
 */

import { type SessionEvent, SessionEventSchema } from "@alexkroman1/aai";
import type { ClientTranscriptReader } from "@alexkroman1/aai/host-internal";
import {
  publishClientTranscriptReader,
  publishedClientTranscriptReader,
} from "@alexkroman1/aai/host-internal";
import {
  type ClientTranscript,
  type ClientTranscriptSession,
  mapConcurrent,
  type StepClientTranscriptOptions,
} from "@alexkroman1/aai/step";
import { errorMessage } from "@alexkroman1/aai/utils";
import type { Logger } from "./runtime-config.ts";
import { historyMessageOf, seededToolResult } from "./session-event-history.ts";
import { SESSION_EVENT_READ_LIMIT, type SessionEventStream } from "./session-event-stream.ts";
import type { ClientSessionRecord } from "./session-state/clients.ts";
import type { SessionStateBackend } from "./session-state/store.ts";

/** The default size of a client's prior history in a new session, in (estimated) tokens. */
export const CLIENT_HISTORY_TOKEN_BUDGET = 8000;

/** The characters-per-token estimate {@link CLIENT_HISTORY_TOKEN_BUDGET} is spent at. */
export const CHARS_PER_TOKEN = 4;

/**
 * How many prior sessions one connect may read. The budget normally stops the
 * walk long before this; the cap is for a client with hundreds of empty
 * sessions (a speaker woken by the TV), where the budget never would.
 */
export const MAX_CLIENT_HISTORY_SESSIONS = 50;

/** How many sessions one `stepClientTranscript` may list. */
export const MAX_CLIENT_TRANSCRIPT_SESSIONS = 500;

/** How many of a transcript's sessions are read at once. */
const TRANSCRIPT_READ_CONCURRENCY = 4;

/** The backend and stream a client's log is read through. */
export type ClientHistoryDeps = {
  backend: SessionStateBackend;
  stream: SessionEventStream;
  logger?: Logger | undefined;
};

/** One stored event, parsed, with the index it is stored at. */
type IndexedEvent = { index: number; event: SessionEvent };

/**
 * Every stored event of `sessionId`, WITH its index — a cursor needs the index,
 * which `stream.read` does not hand back, and the log need not be dense.
 * Flushed first, so a session still live in this process is read whole.
 */
async function readIndexed(deps: ClientHistoryDeps, sessionId: string): Promise<IndexedEvent[]> {
  await deps.stream.flush(sessionId);
  const out: IndexedEvent[] = [];
  let from = 0;
  for (;;) {
    const page = await deps.backend.readEvents(sessionId, from, SESSION_EVENT_READ_LIMIT);
    for (const row of page) {
      try {
        out.push({ index: row.index, event: SessionEventSchema.parse(JSON.parse(row.json)) });
      } catch (err: unknown) {
        // The same fail-open the stream's own reader takes for a row this code
        // cannot parse (an older SDK's shape): dropped, and said so.
        deps.logger?.warn?.("Stored session event dropped", {
          sessionId,
          index: row.index,
          error: errorMessage(err),
        });
      }
    }
    const last = page.at(-1);
    if (page.length < SESSION_EVENT_READ_LIMIT || last === undefined) break;
    from = last.index + 1;
  }
  return out;
}

/** What one event costs the model to read, in characters — 0 for events it never sees. */
function costOf(event: SessionEvent): number {
  const message = historyMessageOf(event);
  if (message) return message.content.length;
  // What the model reads of a result again, which is capped — see `modelHistoryOf`.
  // The call half (a name and capped arguments) is small and uncharged.
  if (event.type === "tool.completed") return seededToolResult(event.result).length;
  return 0;
}

/**
 * Where the longest tail of `events` that costs at most `budget` starts, and
 * what it costs — walked newest first, so the session a budget runs out in
 * keeps its END.
 */
function tailWithin(
  events: readonly SessionEvent[],
  budget: number,
): { start: number; spent: number } {
  let start = events.length;
  let spent = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event === undefined) break;
    const cost = costOf(event);
    if (spent + cost > budget) break;
    spent += cost;
    start = i;
  }
  return { start, spent };
}

/**
 * Record, best-effort, that `sessionId` belongs to `clientId`.
 *
 * A failure is a warning, not a failed start: the session works without it,
 * and what it costs is that THIS session's events are reclaimed on the usual
 * grace sweep rather than kept for the client.
 *
 * @internal
 */
export async function bindClientSession(
  deps: ClientHistoryDeps,
  sessionId: string,
  clientId: string,
): Promise<void> {
  if (!deps.backend.bindClient) return;
  try {
    await deps.backend.bindClient(sessionId, clientId);
  } catch (err: unknown) {
    deps.logger?.warn?.("Session not bound to its client", {
      sid: sessionId.slice(0, 8),
      error: errorMessage(err),
    });
  }
}

/**
 * `clientId`'s recent prior sessions as one event list, oldest first, spent
 * against the budget newest first — see the module doc.
 *
 * `excludeSessionId` is the session being started: a resume restores its OWN
 * log separately, and reading it here too would double every turn it had.
 * Never rejects; a read failure is logged and answers what was read so far.
 *
 * @internal
 */
export async function loadClientHistory(
  deps: ClientHistoryDeps,
  options: {
    clientId: string;
    excludeSessionId: string;
    since?: number | undefined;
    budgetChars?: number | undefined;
  },
): Promise<SessionEvent[]> {
  const { backend } = deps;
  if (!backend.clientSessions) return [];
  const { since } = options;
  let remaining = options.budgetChars ?? CLIENT_HISTORY_TOKEN_BUDGET * CHARS_PER_TOKEN;
  const chunks: SessionEvent[][] = [];
  try {
    const sessions = await backend.clientSessions(options.clientId, {
      since,
      limit: MAX_CLIENT_HISTORY_SESSIONS + 1,
    });
    for (const session of sessions) {
      if (session.sessionId === options.excludeSessionId) continue;
      if (remaining <= 0) break;
      const events = (await readIndexed(deps, session.sessionId))
        .map((e) => e.event)
        .filter((e) => since === undefined || e.meta.at >= since);
      const { start, spent } = tailWithin(events, remaining);
      remaining -= spent;
      if (start < events.length) chunks.unshift(events.slice(start));
      if (start > 0) break;
    }
  } catch (err: unknown) {
    deps.logger?.warn?.("Client history not loaded", { error: errorMessage(err) });
  }
  return chunks.flat();
}

/** One session's transcript, from its indexed events. */
function transcriptOf(
  record: ClientSessionRecord,
  events: readonly IndexedEvent[],
): ClientTranscriptSession {
  const session: ClientTranscriptSession = {
    sessionId: record.sessionId,
    startedAt: record.startedAt,
    lastEventIndex: events.at(-1)?.index ?? -1,
    messages: [],
    tools: [],
  };
  const calls = new Map<string, { name: string; args: Record<string, unknown> }>();
  for (const { event } of events) {
    const message = historyMessageOf(event);
    if (message && message.role !== "tool") {
      session.messages.push({ role: message.role, text: message.content, at: event.meta.at });
    } else if (event.type === "tool.called") {
      calls.set(event.toolCallId, { name: event.toolName, args: event.args });
    } else if (event.type === "tool.completed") {
      const call = calls.get(event.toolCallId);
      session.tools.push({
        name: call?.name,
        args: call?.args,
        result: event.result,
        at: event.meta.at,
      });
    }
  }
  return session;
}

/**
 * `clientId`'s log as a transcript — what `stepClientTranscript` answers.
 * Oldest session first; see `StepClientTranscriptOptions` for the two filters.
 *
 * @internal
 */
export async function readClientTranscript(
  deps: ClientHistoryDeps,
  clientId: string,
  options: StepClientTranscriptOptions = {},
): Promise<ClientTranscript> {
  if (!deps.backend.clientSessions) return { sessions: [] };
  const { since, afterEventIndex: cursor } = options;
  const records = [
    ...(await deps.backend.clientSessions(clientId, {
      since,
      limit: MAX_CLIENT_TRANSCRIPT_SESSIONS,
    })),
  ].reverse();
  // Everything from the cursor's session on; an unknown cursor reads it all.
  const at = cursor ? records.findIndex((r) => r.sessionId === cursor.sessionId) : -1;
  // Each session's read is independent, so a few run at once; order is kept.
  const read = await mapConcurrent(
    at >= 0 ? records.slice(at) : records,
    TRANSCRIPT_READ_CONCURRENCY,
    async (record) => {
      const events = (await readIndexed(deps, record.sessionId)).filter(
        (e) =>
          (since === undefined || e.event.meta.at >= since) &&
          !(cursor && at >= 0 && record.sessionId === cursor.sessionId && e.index <= cursor.index),
      );
      return events.length > 0 ? transcriptOf(record, events) : undefined;
    },
  );
  const sessions = read.filter((s): s is ClientTranscriptSession => s !== undefined);
  return { sessions };
}

/**
 * Publish {@link readClientTranscript} over this runtime's log as
 * `stepClientTranscript`'s reader, and return how to take it back down —
 * which only unpublishes if the slot still holds THIS reader: one process can
 * hold several runtimes (a rebuild, a spec), the last one built is the one a
 * step reads through, and disposing an older one must not unpublish it.
 *
 * @internal
 */
export function publishClientTranscripts(deps: ClientHistoryDeps): () => void {
  const reader: ClientTranscriptReader = (clientId, options) =>
    readClientTranscript(deps, clientId, options);
  publishClientTranscriptReader(reader);
  return () => {
    if (publishedClientTranscriptReader() === reader) publishClientTranscriptReader(undefined);
  };
}
