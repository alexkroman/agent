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
  nextToFlush,
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

export function useMessageQueue(opts: MessageQueueOptions): MessageQueueApi {
  const { status, busy, chatReady, sendMessage, setInput } = opts;
  const [queue, dispatchQueue] = useReducer(queueReducer, EMPTY_QUEUE);
  const pending = hasPendingWork(queue, busy);

  /**
   * Hand the queue back to the composer: the one answer to "this turn will not
   * end normally". Used by an explicit Stop and by a failed turn — neither may
   * fire the follow-ups (a Stop is the user taking control back, and a
   * follow-up sent over a failed turn buries the error), and neither may eat
   * text the user typed while waiting.
   */
  const drainToComposer = useCallback(() => {
    if (queue.items.length === 0) return;
    setInput((current) => drainText(queue, current));
    dispatchQueue({ type: "clear" });
  }, [queue, setInput]);

  // Send the head of the queue the moment a turn settles — one turn at a
  // time, FIFO. While a turn runs, `turn-observed` releases the dispatch
  // latch (see chat-queue.ts for why it exists at all).
  useEffect(() => {
    if (busy) {
      dispatchQueue({ type: "turn-observed" });
      return;
    }
    // A failed turn parks the queue, and `status` stays `error` until some
    // request starts — but every submit joins the queue while it is non-empty,
    // so parking it here would wedge the composer permanently.
    if (status === "error") {
      drainToComposer();
      return;
    }
    const next = nextToFlush(queue, { status, chatReady });
    if (next === null) return;
    dispatchQueue({ type: "dispatch" });
    void sendMessage({ text: next });
  }, [busy, status, chatReady, queue, sendMessage, drainToComposer]);

  return {
    items: queue.items,
    pending,
    submit: (text: string) => {
      if (!chatReady) return;
      if (pending) {
        dispatchQueue({ type: "queue", text });
        return;
      }
      void sendMessage({ text });
    },
    remove: (id: string) => dispatchQueue({ type: "remove", id }),
    drainToComposer,
  };
}
