// Copyright 2026 the AAI authors. MIT license.
/**
 * How one coding-agent turn reaches the browser: the response stream, and the
 * one-turn-at-a-time rule around it. Both exist because of failures measured
 * against a real guest, described below.
 *
 * ## A broken model stream must not read as a finished turn
 *
 * `pipeUIMessageStreamToResponse` returns a promise that REJECTS when the
 * stream errors, and its `finally` calls `response.end()` on the way out
 * (`writeToServerResponse` in the AI SDK). So a mid-stream failure — the
 * gateway dropping the body, a network fault between the guest and the model —
 * ended the response *cleanly*, after the last text delta and with no `error`,
 * `finish`, or `[DONE]` frame. Measured at the wire by teeing the SSE body in
 * the browser: the client's read completed normally, `useChat` moved to
 * `ready`, the panel showed a half-sentence reply with no error at all, and the
 * truncated turn was persisted as the conversation. The only trace was the
 * guest's `unhandled rejection: terminated` — the rejection the caller's `void`
 * discarded.
 *
 * The fix has to put the error INTO the stream, because by the time the pipe's
 * rejection is observable the response is already closed: nothing can be
 * written afterwards. {@link deliverTurn} therefore re-streams the UI message
 * stream through the AI SDK's `createUIMessageStream`, whose `writer.merge`
 * turns a source error into a final `error` chunk (via `onError`) before the
 * stream closes — which is exactly what the client's `processUIMessageStream`
 * turns into a thrown error, so the turn lands in `status: "error"` where the
 * studio already knows how to show it and hand queued follow-ups back to the
 * composer.
 *
 * ## Assistant messages need an id that is not `""`
 *
 * `handleUIMessageStreamFinish` falls back to `messageId: ""` when neither
 * `responseMessageId` nor `generateMessageId` is given, and that blank id is
 * what the `onFinish` reconstruction — the object this guest PERSISTS — carries.
 * The live transcript looked fine (the browser's own copy has a client-side
 * id), so this only showed up in the stored conversation, where it compounds:
 * the client hydrates the blank id, sends it back, and each turn adds another.
 * Measured over three reload-and-send rounds: 1 blank id, then 2, then 3, then
 * 4 — four messages sharing the React key `""`, which is the same key-collision
 * hazard `toBlocks` has tests for, one level up and in restored conversations.
 *
 * ## One turn at a time, per guest
 *
 * A project has ONE guest, and the browser's queue is per tab. Two tabs (or two
 * devices) therefore streamed turns into the same sandbox at once: measured,
 * their gateway requests overlapped, two agents edited one workspace, and the
 * end-of-turn `studio/persist-chat` writes raced — the loser's turn was absent
 * from the stored conversation afterwards, because each request carries its own
 * whole-conversation view and the last writer wins.
 *
 * {@link createTurnGate} refuses the second turn instead of interleaving it.
 * Refusing rather than queueing is deliberate: a waiting request would run with
 * a conversation snapshot taken before the turn it waited for, so it would
 * clobber that turn on settle anyway — the queue that makes sense is the one in
 * the tab, where the messages are re-read at dispatch. The refusal is a status
 * of its own (423) so the client can say which tab is busy rather than treating
 * it as a dead session and re-brokering.
 *
 * ## The gate is not only about TURNS — it is about the workspace
 *
 * A turn is one of two things that owns the session tree; the other is
 * `initStudioSession`, which opens with `rm -rf`. Gating only `POST
 * /studio/chat` left the second one wide open: a refresh or a second tab sends
 * `studio/session-init` to the LIVE sandbox, and `materializeWorkspace` deleted
 * the very directory the in-flight turn's tools had closed over — every edit
 * since the last checkpoint gone, with `settleTurn` then syncing the mixed tree
 * back marked `done: true`. So {@link enterTurn} is what both claim, and a
 * session-init that cannot claim it keeps the live tree instead of resetting it
 * (see `initStudioSession`). Taking the gate rather than merely reading a `busy`
 * flag also closes the mirror race — a turn starting while the re-install is
 * half way through the tree.
 */

import type { ServerResponse } from "node:http";
import {
  createIdGenerator,
  createUIMessageStream,
  pipeUIMessageStreamToResponse,
  type UIMessage,
  type UIMessageChunk,
} from "ai";

/** HTTP status for "this guest is already running a turn". */
export const TURN_IN_FLIGHT_STATUS = 423;
/** Machine-readable marker on that response, so clients need not match prose. */
export const TURN_IN_FLIGHT_CODE = "turn_in_flight";

/**
 * One turn at a time. `enter` returns the release for the turn it admitted, or
 * `null` when a turn is already running.
 *
 * The release is identity-checked like {@link createOwnedMap}'s: it runs after
 * awaits (a settled stream, an aborted request), by which point the slot may
 * hold a later turn that must not be freed by an earlier one's cleanup.
 *
 * There is deliberately no `busy` reader. There was one, and nothing in
 * production ever read it — the only observers were this module's own spec, so
 * it was a test affordance wearing an API's clothes, and the one caller that
 * genuinely needed the predicate (session-init, above) needs the CLAIM rather
 * than the reading. `enter() === null` answers the question and holds the
 * answer still.
 */
export type TurnGate = {
  enter(): (() => void) | null;
  /**
   * Wait for the claim instead of being refused it. The claim is HANDED OVER
   * at the holder's release, never released and re-taken, so no `enter()` can
   * slip in between — the property a shutdown drain needs (turn-drain.ts):
   * the turn it waited for ends, and no next turn starts on a guest that is
   * about to be terminated.
   */
  enterWhenFree(): Promise<() => void>;
};

export function createTurnGate(): TurnGate {
  let holder: symbol | null = null;
  const waiting: Array<(release: () => void) => void> = [];
  const claim = (): (() => void) => {
    const mine = Symbol("turn");
    holder = mine;
    return () => {
      if (holder !== mine) return;
      holder = null;
      waiting.shift()?.(claim());
    };
  };
  return {
    enter: () => (holder === null ? claim() : null),
    enterWhenFree: () =>
      holder === null
        ? Promise.resolve(claim())
        : new Promise<() => void>((resolve) => waiting.push(resolve)),
  };
}

/**
 * The gate every claim on this guest's workspace goes through, per PROCESS —
 * not per session object.
 *
 * A sandbox serves one project (its identity is pinned at first install), but
 * `studio/session-init` runs again on every page open, so a gate hanging off
 * the session would be replaced by the very event that creates the race:
 * measured, a second tab opening the project mid-turn re-installed the session,
 * got a fresh gate, and streamed a concurrent turn anyway.
 */
let processTurnGate = createTurnGate();

/**
 * Claim this guest's workspace — for a chat turn, or for the re-install that
 * would otherwise delete the tree under one. Returns the release, or `null`
 * when the claim is already held.
 */
export function enterTurn(): (() => void) | null {
  return processTurnGate.enter();
}

/** Wait for this guest's workspace claim — see {@link TurnGate.enterWhenFree}. */
export function enterTurnWhenFree(): Promise<() => void> {
  return processTurnGate.enterWhenFree();
}

/** Test-only: drop the in-flight claim, like `resetSessionIdentity`. */
export function resetTurnGate(): void {
  processTurnGate = createTurnGate();
}

/** The `streamText` surface this module needs — structural, so tests can fake it. */
export type TurnResultLike = {
  toUIMessageStream(options: {
    originalMessages?: UIMessage[];
    generateMessageId?: () => string;
    onFinish?: (event: { messages: UIMessage[] }) => void;
    onError?: (error: unknown) => string;
  }): ReadableStream<UIMessageChunk>;
  // PromiseLike, not Promise: that is what `streamText`'s result declares.
  consumeStream(options?: { onError?: (error: unknown) => void }): PromiseLike<void>;
};

export type DeliverTurnOptions = {
  headers: Record<string, string>;
  /** The conversation the request carried — the SDK reconstructs onto it. */
  originalMessages: UIMessage[];
  /** Runs when the turn settles (finish OR client abort). */
  onFinish: (event: { messages: UIMessage[] }) => void;
  toErrorText: (error: unknown) => string;
};

/**
 * Ids for persisted assistant messages. Prefixed so a message minted here is
 * recognizable in a stored conversation; unique per process, which is all the
 * uniqueness a single-session guest needs.
 */
const generateMessageId = createIdGenerator({ prefix: "msg", size: 16 });

/**
 * Stream one turn to `res`. Resolves once the response is closed, with the
 * failure that ended it (if any) — the caller logs it; the client has already
 * been told through the stream's own `error` chunk.
 */
export async function deliverTurn(
  result: TurnResultLike,
  res: ServerResponse,
  options: DeliverTurnOptions,
): Promise<{ failure?: unknown }> {
  let failure: unknown;
  const record = (error: unknown) => {
    failure ??= error;
  };
  const stream = result.toUIMessageStream({
    originalMessages: options.originalMessages,
    generateMessageId,
    onFinish: options.onFinish,
    onError: options.toErrorText,
  });
  const piped = pipeUIMessageStreamToResponse({
    response: res,
    headers: options.headers,
    // `merge` reads the source and, if it errors, writes `onError`'s text as a
    // final `error` chunk before the merged stream closes — the in-band failure
    // the module doc is about.
    stream: createUIMessageStream({
      execute: ({ writer }) => writer.merge(stream),
      onError: (error) => {
        record(error);
        return options.toErrorText(error);
      },
    }),
  }).catch(record);
  // Drives the model stream to completion even if the browser goes away, so
  // tool calls and the workspace settle either way.
  await result.consumeStream({ onError: record });
  await piped;
  return failure === undefined ? {} : { failure };
}
