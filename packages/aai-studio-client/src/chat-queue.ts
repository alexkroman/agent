// Copyright 2026 the AAI authors. MIT license.
// The composer's follow-up queue: what pressing Enter does while the agent is
// still working. The AI SDK has NO queue of its own — `sendMessage` calls
// `makeRequest` straight away, which resets the chat status and overwrites the
// live `activeResponse` (its only serialization, `SerialJobExecutor`, guards
// stream-update jobs, not requests). Two concurrent turns on one guest session
// would interleave their workspace syncs, so the ordering rules live here,
// as a pure reducer that can be tested without a live useChat.

import type { ChatStatus } from "ai";

/** One follow-up waiting its turn. The id is a React key and a remove handle. */
export type QueuedMessage = { readonly id: string; readonly text: string };

export type MessageQueue = {
  /** Follow-ups typed while a turn was in flight, oldest first. */
  readonly items: readonly QueuedMessage[];
  /**
   * A queued message has been handed to `sendMessage` but the turn it starts
   * has not been observed yet. The latch has to exist because `sendMessage`
   * is async — it awaits before flipping the status to `submitted` — so a
   * re-render in that window still sees `status: "ready"` and would dispatch
   * the NEXT item into a second concurrent turn.
   */
  readonly dispatched: boolean;
  /** Monotonic id source, so ids stay unique without touching a clock. */
  readonly nextId: number;
};

export const EMPTY_QUEUE: MessageQueue = { items: [], dispatched: false, nextId: 0 };

export type QueueAction =
  /** The user submitted while the agent was busy. */
  | { readonly type: "queue"; readonly text: string }
  /** The user dismissed a queued message before it ran. */
  | { readonly type: "remove"; readonly id: string }
  /** The head was handed to `sendMessage`; arm the latch. */
  | { readonly type: "dispatch" }
  /** A turn is in flight, so the dispatch above landed; release the latch. */
  | { readonly type: "turn-observed" }
  /** Stop: the queue is handed back to the composer (see {@link drainText}). */
  | { readonly type: "clear" };

/** Compile-time exhaustiveness — a new action makes this call a type error. */
function unhandled(action: never): never {
  throw new Error(`unhandled queue action: ${JSON.stringify(action)}`);
}

export function queueReducer(state: MessageQueue, action: QueueAction): MessageQueue {
  switch (action.type) {
    case "queue":
      return {
        ...state,
        items: [...state.items, { id: `q${state.nextId}`, text: action.text }],
        nextId: state.nextId + 1,
      };
    case "remove":
      return { ...state, items: state.items.filter((item) => item.id !== action.id) };
    case "dispatch":
      return { ...state, items: state.items.slice(1), dispatched: true };
    case "turn-observed":
      // Identity-stable when there is nothing to release: this action fires on
      // every render while a turn streams, and a fresh object each time would
      // re-run the flush effect dozens of times a second.
      return state.dispatched ? { ...state, dispatched: false } : state;
    case "clear":
      // The latch survives a clear: a Stop landing in the dispatch window
      // must not let the next render start a turn.
      return state.items.length === 0 ? state : { ...state, items: [] };
    default:
      return unhandled(action);
  }
}

/**
 * The message to send now, or `null` to wait: one turn at a time, FIFO.
 *
 * `status` must be exactly `ready` — an `error` status parks the queue instead
 * of firing follow-ups into a conversation whose last turn failed, and the
 * user can still remove them or send something else.
 */
export function nextToFlush(
  queue: MessageQueue,
  ctx: { readonly status: ChatStatus; readonly llmReady: boolean },
): string | null {
  const [next] = queue.items;
  if (next === undefined || queue.dispatched) return null;
  return ctx.llmReady && ctx.status === "ready" ? next.text : null;
}

/**
 * Whether the agent still owes work: a turn in flight, follow-ups waiting, or
 * a dispatch that has not become a turn yet.
 *
 * Both callers need exactly this predicate, and both are wrong without the
 * `dispatched` term — which covers the same latch window as
 * {@link nextToFlush}, where `busy` is still false and the queue is already
 * short one item:
 *
 * - A submit in that window would go out as a SECOND concurrent turn (and
 *   ahead of the message just dispatched); it has to join the queue instead.
 * - Publish must not unlock there: it deploys the workspace the end-of-turn
 *   sync writes, and the dispatched follow-up is about to edit it again.
 */
export function hasPendingWork(queue: MessageQueue, busy: boolean): boolean {
  return busy || queue.items.length > 0 || queue.dispatched;
}

/**
 * The composer text after a Stop drains the queue: queued messages first (they
 * were typed first), then whatever is in the input. Stop hands them back
 * rather than firing or dropping them — an explicit interrupt must not start a
 * new turn behind the user's back, and must not lose what they typed.
 */
export function drainText(queue: MessageQueue, input: string): string {
  return [...queue.items.map((item) => item.text), input]
    .map((text) => text.trim())
    .filter((text) => text.length > 0)
    .join("\n\n");
}
