// Copyright 2026 the AAI authors. MIT license.
/**
 * `stepClientTranscript()` — read back what a client's sessions SAID, from a
 * workflow step.
 *
 * A device that connects with `?client=<id>` has one conversation across many
 * sessions, and the runtime keeps every session's raw event log for it rather
 * than reclaiming it when the session ends (see `aai-runtime`'s
 * `session-client-history.ts`). This is how the app's own summarizer reads that
 * log: `onSessionEnd` starts a run, and the run's step calls this with the
 * client id and a cursor, then writes whatever digest it likes somewhere its
 * `sessionContext` can find it next time.
 *
 * ## What comes back
 *
 * The conversation, not the log: committed user and agent transcripts (the
 * words the session recorded as SAID — an interrupted reply's unheard tail is
 * not here, exactly as it is not in the model's own history) and each settled
 * tool call with its arguments and result. Sessions oldest first, each with the
 * index of its last event so a caller can advance its cursor.
 *
 * ## Why a global slot
 *
 * The log lives in the runtime's session-state backend and the step runs from
 * the agent bundle's own copy of this module, so the reader hangs off
 * `globalThis` under a `Symbol.for` key both copies agree on — the same shape
 * as {@link stepNotifyClient}'s. An unpublished slot THROWS a `FatalError`:
 * there is no log to wait for, and retrying would only wait longer to say so.
 *
 * @module
 */

import { FatalError } from "./step-error-classes.ts";
import { CLIENT_ID_RE } from "./step-notify-client.ts";

const CLIENT_TRANSCRIPT_SLOT = Symbol.for("@alexkroman1/aai.clientTranscriptReader");

/** One committed line of a client's conversation. */
export type ClientTranscriptMessage = {
  role: "user" | "assistant";
  text: string;
  /** Epoch ms the line was recorded. */
  at: number;
};

/** One settled tool call in a client's conversation. */
export type ClientTranscriptTool = {
  /** The tool's name, or `undefined` when the log's front no longer holds the call. */
  name: string | undefined;
  /** The arguments it was called with, when the call is still in the log. */
  args: Readonly<Record<string, unknown>> | undefined;
  /** What it returned, serialized and capped as the client's own frame carries it. */
  result: string;
  /** Epoch ms the result was recorded. */
  at: number;
};

/** One of a client's sessions, as {@link stepClientTranscript} reads it. */
export type ClientTranscriptSession = {
  sessionId: string;
  /** Epoch ms the session was first bound to the client. */
  startedAt: number;
  /**
   * The index of the last event read for this session (`-1` when none) — the
   * `index` half of the next call's `afterEventIndex`.
   */
  lastEventIndex: number;
  messages: ClientTranscriptMessage[];
  tools: ClientTranscriptTool[];
};

/** What {@link stepClientTranscript} returns. */
export type ClientTranscript = {
  /** Oldest session first. */
  sessions: ClientTranscriptSession[];
};

/** Options for {@link stepClientTranscript}. */
export type StepClientTranscriptOptions = {
  /** Epoch ms: only sessions active, and events recorded, at or after it. */
  since?: number | undefined;
  /**
   * A cursor: only what came AFTER event `index` of session `sessionId` — the
   * rest of that session, and every session that started after it. An unknown
   * session id reads from the beginning, which is the safe way to be wrong for a
   * summarizer that keys its own writes.
   */
  afterEventIndex?: { sessionId: string; index: number } | undefined;
};

/**
 * What the runtime publishes: read a client's durable log.
 *
 * @internal
 */
export type ClientTranscriptReader = (
  clientId: string,
  options: StepClientTranscriptOptions,
) => Promise<ClientTranscript>;

type ReaderSlot = { [CLIENT_TRANSCRIPT_SLOT]?: ClientTranscriptReader };

/**
 * What {@link stepClientTranscript} throws when no runtime published a reader.
 *
 * @internal
 */
export const CLIENT_TRANSCRIPT_UNAVAILABLE_MESSAGE =
  "This process has no session log to read, so a step cannot read a client's transcript. " +
  "It is published by createRuntime (aai dev, aai start, a self-hosted server). " +
  "In a test, use `stubClientTranscript` from @alexkroman1/aai/testing.";

/**
 * Publish how this process reads a client's log. `undefined` unpublishes.
 *
 * @internal — a host concern. A step author calls {@link stepClientTranscript}.
 */
export function publishClientTranscriptReader(reader: ClientTranscriptReader | undefined): void {
  if (reader === undefined) delete (globalThis as ReaderSlot)[CLIENT_TRANSCRIPT_SLOT];
  else (globalThis as ReaderSlot)[CLIENT_TRANSCRIPT_SLOT] = reader;
}

/**
 * The reader currently published, for a host that must only unpublish its own.
 *
 * @internal
 */
export function publishedClientTranscriptReader(): ClientTranscriptReader | undefined {
  return (globalThis as ReaderSlot)[CLIENT_TRANSCRIPT_SLOT];
}

/**
 * Read what `clientId`'s sessions said — the durable log behind `?client=`.
 *
 * ```ts
 * import type { WorkflowContext } from "@alexkroman1/aai";
 * import { stepClientTranscript } from "@alexkroman1/aai/step";
 *
 * export async function memorize(
 *   input: { clientId: string; after?: { sessionId: string; index: number } },
 *   ctx: WorkflowContext,
 * ) {
 *   // Everything said since the last digest this run's caller recorded.
 *   const { sessions } = await ctx.step("read", () =>
 *     stepClientTranscript(input.clientId, { afterEventIndex: input.after }),
 *   );
 *   return { lines: sessions.reduce((n, s) => n + s.messages.length, 0) };
 * }
 * ```
 */
export async function stepClientTranscript(
  clientId: string,
  options: StepClientTranscriptOptions = {},
): Promise<ClientTranscript> {
  if (!CLIENT_ID_RE.test(clientId)) {
    throw new FatalError(
      `stepClientTranscript: "${clientId}" is not a client id (${CLIENT_ID_RE})`,
    );
  }
  const reader = publishedClientTranscriptReader();
  if (!reader) throw new FatalError(CLIENT_TRANSCRIPT_UNAVAILABLE_MESSAGE);
  return await reader(clientId, options);
}
