// Copyright 2026 the AAI authors. MIT license.
/**
 * The composer's follow-up queue, wired to a live `useChat`.
 *
 * `chat-queue.ts` owns the RULES (a pure reducer, testable without a chat);
 * this owns the wiring — the flush effect, the busy mirror, and what a Stop
 * does. It is its own module because `ProjectChat` was holding five concerns
 * in one ~200-line body (the transport, the queue, the busy mirror, the
 * initial prompt, and the render).
 */

import type { ChatStatus } from "ai";
import { type Dispatch, type SetStateAction, useCallback, useEffect, useReducer } from "react";
import {
  drainText,
  EMPTY_QUEUE,
  hasPendingWork,
  type MessageQueue,
  nextToFlush,
  type QueueAction,
  type QueuedMessage,
  queueReducer,
} from "./chat-queue.ts";

export type MessageQueueOptions = {
  /** The live chat's status — `nextToFlush` requires exactly `ready`. */
  status: ChatStatus;
  /** A turn is in flight (`submitted` or `streaming`). */
  busy: boolean;
  /** `/studio/status` has answered, so a turn can be started at all. */
  chatReady: boolean;
  /**
   * Hand a message to the chat. The RESULT is load-bearing: `useChat`'s
   * `sendMessage` resolves when the turn it started is over, whatever became
   * of it, and that is the only signal this module gets that always arrives —
   * see {@link runQueueEvent}.
   */
  sendMessage: (message: { text: string }) => unknown;
  /**
   * The composer's text, owned one level up so a Stop can hand the queue back
   * to it (see {@link drainText}).
   */
  setInput: Dispatch<SetStateAction<string>>;
};

export type MessageQueueApi = {
  /** Queued follow-ups, oldest first — what the composer renders above itself. */
  items: readonly QueuedMessage[];
  /**
   * The agent still owes work: a turn in flight, follow-ups waiting, or a
   * dispatch that has not become a turn yet. Publish gates on this, and so does
   * whether a note may be appended to the transcript.
   */
  pending: boolean;
  /** The composer submitted: send now, or join the queue. */
  submit: (text: string) => void;
  /** The user dismissed a queued message before it ran. */
  remove: (id: string) => void;
  /** Hand the queue back to the composer — a Stop, or a failed turn. */
  drainToComposer: () => void;
};

/** What the live chat reports, as the queue's decisions read it. */
export type QueueContext = {
  readonly status: ChatStatus;
  readonly busy: boolean;
  readonly chatReady: boolean;
};

/** The four things that can happen to the queue, from outside the reducer. */
export type QueueEvent =
  /** The flush effect ran: a render happened and the chat may have moved. */
  | { readonly kind: "settle" }
  /** The composer submitted. */
  | { readonly kind: "submit"; readonly text: string }
  /** The user dismissed a queued row. */
  | { readonly kind: "remove"; readonly id: string }
  /** Hand the queue back to the composer — an explicit Stop. */
  | { readonly kind: "stop" };

/**
 * Everything {@link runQueueEvent} can do to the world outside the reducer.
 * The hook passes React's own dispatchers; a test passes a model.
 */
export type QueueIo = {
  readonly dispatch: (action: QueueAction) => void;
  readonly setInput: (update: (current: string) => string) => void;
  /**
   * Hand `text` to the chat, and call `onSettled` when that handover is over —
   * the turn ended, failed, was aborted, or never started at all. A callback
   * rather than a returned promise so the whole module stays synchronous and a
   * property test can decide WHEN the handover ends.
   */
  readonly send: (text: string, onSettled: () => void) => void;
};

/**
 * Every decision this module makes, as ONE pure function.
 *
 * It is not here for reuse — there is exactly one caller, the hook below. It
 * is here because these decisions are only wrong in COMBINATION, and a React
 * effect is the one place a combination cannot be written down: to reach the
 * interesting states a test has to drive renders, a live `useChat`, and a
 * transport that fails at a chosen moment. Pulled out, the same states are a
 * sequence of calls, which is what lets
 * `message-queue-conservation.test.ts` assert the module's conservation law
 * over generated interleavings rather than over the handful anybody thought
 * to write down. `chat-queue.test.ts` pins twenty transitions in ISOLATION
 * and every one of them passes over the wedge that suite found.
 *
 * The hook keeps what is genuinely React's: the reducer, the effect's
 * dependency list, and the busy mirror.
 */
export function runQueueEvent(
  event: QueueEvent,
  queue: MessageQueue,
  ctx: QueueContext,
  io: QueueIo,
): void {
  switch (event.kind) {
    case "submit": {
      if (!ctx.chatReady) return;
      // Anything already owed means this joins the line — including the
      // dispatch latch, where `busy` is still false and a direct send would
      // open a second concurrent turn AHEAD of the message just dispatched.
      if (hasPendingWork(queue, ctx.busy)) {
        io.dispatch({ type: "queue", text: event.text });
        return;
      }
      io.send(event.text, releaseLatch(io));
      return;
    }
    case "remove":
      io.dispatch({ type: "remove", id: event.id });
      return;
    case "stop": {
      if (queue.items.length === 0) return;
      io.setInput((current) => drainText(queue, current));
      io.dispatch({ type: "clear" });
      return;
    }
    case "settle": {
      if (ctx.busy) {
        io.dispatch({ type: "turn-observed" });
        return;
      }
      // A failed turn parks the queue, and `status` stays `error` until some
      // request starts — but every submit joins the queue while it is
      // non-empty, so parking it here would wedge the composer permanently.
      if (ctx.status === "error") {
        runQueueEvent({ kind: "stop" }, queue, ctx, io);
        return;
      }
      const next = nextToFlush(queue, ctx);
      if (next === null) return;
      io.dispatch({ type: "dispatch" });
      io.send(next, releaseLatch(io));
      return;
    }
    default:
      throw unhandledEvent(event);
  }
}

/** Compile-time exhaustiveness — a new event makes this call a type error. */
function unhandledEvent(event: never): never {
  throw new Error(`unhandled queue event: ${JSON.stringify(event)}`);
}

/**
 * Release the dispatch latch because the HANDOVER is over — the one signal
 * that always arrives.
 *
 * `turn-observed` on a rendered `busy` is the fast path and stays, but it is
 * not a release the queue can rely on: it needs a render to land inside the
 * turn, and nothing about React promises one. React commits every state the
 * chat passes through today, so in practice a render does land — but let two
 * of those commits coalesce and the latch is armed with nothing left that can
 * ever disarm it. `hasPendingWork` then stays true forever: every submit joins
 * the queue, the flush effect returns at `nextToFlush` before it can flush
 * one, `clear` preserves the latch, and Publish never unlocks. The composer
 * becomes a field you can type in and never send, until a reload. The
 * property in `message-queue-conservation.test.ts` shrinks that to four steps
 * and needs no failure of any kind to get there.
 *
 * A handover ENDING is a fact about this module's own call, not an inference
 * from a status enum, so it cannot be coalesced away.
 *
 * It releases unconditionally rather than matching the dispatch it belongs to.
 * A token would make a stale handover unable to disarm a fresh latch, and the
 * property finds no interleaving where one can: a later dispatch needs
 * `status === "ready"`, which only comes back when the previous turn is over,
 * which is the same moment this fires.
 */
function releaseLatch(io: QueueIo): () => void {
  return () => io.dispatch({ type: "turn-observed" });
}

export function useMessageQueue(opts: MessageQueueOptions): MessageQueueApi {
  const { status, busy, chatReady, sendMessage, setInput } = opts;
  const [queue, dispatchQueue] = useReducer(queueReducer, EMPTY_QUEUE);
  const pending = hasPendingWork(queue, busy);

  /**
   * One event against the state this render is looking at. Memoized on
   * everything it reads, so the flush effect's dependency list is exactly
   * "something the decision depends on changed".
   */
  const run = useCallback(
    (event: QueueEvent) => {
      runQueueEvent(
        event,
        queue,
        { status, busy, chatReady },
        {
          dispatch: dispatchQueue,
          setInput,
          send: (text, onSettled) => {
            // BOTH arms, and then a `catch`. `useChat` resolves rather than
            // rejecting, so only the first arm runs today — but a rejection is
            // as final as a resolution, and a promise left with an unhandled
            // one does not merely go unnoticed here:
            // `scripts/fail-on-process-warning.mjs` is a `setupFiles` entry in
            // every vitest project and turns it into a failed RUN, in whatever
            // suite happens to be executing. The trailing `catch` covers the
            // one path the two arms cannot — `onSettled` itself throwing —
            // which is the `void p.catch(report)` shape this repo asks for and
            // the reason `guard-invariants` rule 23 exists next door.
            void Promise.resolve(sendMessage({ text }))
              .then(onSettled, onSettled)
              .catch((err: unknown) => {
                console.error("releasing the message queue's dispatch latch failed", err);
              });
          },
        },
      );
    },
    [queue, status, busy, chatReady, setInput, sendMessage],
  );

  /**
   * Hand the queue back to the composer: the one answer to "this turn will not
   * end normally". Used by an explicit Stop and by a failed turn — neither may
   * fire the follow-ups (a Stop is the user taking control back, and a
   * follow-up sent over a failed turn buries the error), and neither may eat
   * text the user typed while waiting.
   */
  const drainToComposer = useCallback(() => {
    run({ kind: "stop" });
  }, [run]);

  // Send the head of the queue the moment a turn settles — one turn at a
  // time, FIFO. A render that sees the turn running releases the dispatch latch
  // (see chat-queue.ts for why it exists at all), and so does the handover's
  // own settlement, which is the release that cannot be missed — see
  // {@link releaseLatch}.
  useEffect(() => {
    run({ kind: "settle" });
  }, [run]);

  return {
    items: queue.items,
    pending,
    submit: (text: string) => run({ kind: "submit", text }),
    remove: (id: string) => run({ kind: "remove", id }),
    drainToComposer,
  };
}
