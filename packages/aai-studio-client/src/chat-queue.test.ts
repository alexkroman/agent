// Copyright 2026 the AAI authors. MIT license.
// The queue's ordering rules. The one that needs a test rather than a read is
// the dispatch latch: the window where the SDK still reports `ready` after a
// queued message was handed to sendMessage is exactly where a second
// concurrent turn would start.

import { describe, expect, test } from "vitest";
import {
  drainText,
  EMPTY_QUEUE,
  hasPendingWork,
  type MessageQueue,
  nextToFlush,
  queueReducer,
} from "./chat-queue.ts";

const ready = { status: "ready", llmReady: true } as const;

function queued(...texts: string[]): MessageQueue {
  return texts.reduce<MessageQueue>(
    (state, text) => queueReducer(state, { type: "queue", text }),
    EMPTY_QUEUE,
  );
}

const texts = (queue: MessageQueue): string[] => queue.items.map((item) => item.text);

describe("hasPendingWork", () => {
  test("a turn in flight is pending work", () => {
    expect(hasPendingWork(EMPTY_QUEUE, true)).toBe(true);
  });

  test("an idle composer with an empty queue is idle", () => {
    expect(hasPendingWork(EMPTY_QUEUE, false)).toBe(false);
  });

  test("queued follow-ups are pending even between turns, so nothing jumps the line", () => {
    expect(hasPendingWork(queued("first"), false)).toBe(true);
  });

  test("a dispatched message is pending before its turn is in flight", () => {
    // The latch window: `busy` is still false and the item has left the queue,
    // so without this a submit would open a second concurrent turn and
    // Publish would unlock over a workspace that is about to be edited.
    const dispatched = queueReducer(queued("a"), { type: "dispatch" });
    expect(texts(dispatched)).toEqual([]);
    expect(hasPendingWork(dispatched, false)).toBe(true);
  });
});

describe("nextToFlush", () => {
  test("hands over the oldest message once the turn settles", () => {
    expect(nextToFlush(queued("a", "b"), ready)).toBe("a");
  });

  test("waits while a turn is in flight", () => {
    expect(nextToFlush(queued("a"), { status: "streaming", llmReady: true })).toBeNull();
    expect(nextToFlush(queued("a"), { status: "submitted", llmReady: true })).toBeNull();
  });

  test("parks the queue when the last turn failed", () => {
    // Firing follow-ups into a conversation whose turn just errored buries the
    // error; the messages stay queued and removable instead.
    expect(nextToFlush(queued("a"), { status: "error", llmReady: true })).toBeNull();
  });

  test("waits for the LLM to come up", () => {
    expect(nextToFlush(queued("a"), { status: "ready", llmReady: false })).toBeNull();
  });

  test("an empty queue has nothing to flush", () => {
    expect(nextToFlush(EMPTY_QUEUE, ready)).toBeNull();
  });

  test("holds the latch through the window where the status still reads ready", () => {
    // sendMessage awaits before flipping the status to `submitted`, so a
    // re-render in between sees `ready` with the next item at the head — the
    // exact shape that would start a second concurrent turn.
    const afterDispatch = queueReducer(queued("a", "b"), { type: "dispatch" });
    expect(texts(afterDispatch)).toEqual(["b"]);
    expect(nextToFlush(afterDispatch, ready)).toBeNull();

    // Once the turn is observed, the next one may go.
    const observed = queueReducer(afterDispatch, { type: "turn-observed" });
    expect(nextToFlush(observed, ready)).toBe("b");
  });
});

describe("queueReducer", () => {
  test("appends in submit order", () => {
    expect(texts(queued("a", "b", "c"))).toEqual(["a", "b", "c"]);
  });

  test("remove drops just that message, by id", () => {
    // By id, not position: the row the user clicks must be the row that goes,
    // even if the head was dispatched between render and click.
    const state = queued("a", "b", "c");
    const id = state.items.find((item) => item.text === "b")?.id ?? "";
    expect(texts(queueReducer(state, { type: "remove", id }))).toEqual(["a", "c"]);
  });

  test("ids stay unique across removals, so two identical texts never collide", () => {
    const state = queueReducer(queued("same", "same"), { type: "remove", id: "q0" });
    const readded = queueReducer(state, { type: "queue", text: "same" });
    expect(new Set(readded.items.map((item) => item.id)).size).toBe(readded.items.length);
  });

  test("turn-observed keeps identity when there is no latch to release", () => {
    // It fires on every render while a turn streams; a fresh object each time
    // would re-run the flush effect dozens of times a second.
    const state = queued("a");
    expect(queueReducer(state, { type: "turn-observed" })).toBe(state);
  });

  test("clear empties the queue but keeps the latch armed", () => {
    // A Stop landing inside the dispatch window must not let the next render
    // start a turn.
    const dispatched = queueReducer(queued("a", "b"), { type: "dispatch" });
    const cleared = queueReducer(dispatched, { type: "clear" });
    expect(texts(cleared)).toEqual([]);
    expect(cleared.dispatched).toBe(true);
  });

  test("clear keeps identity when the queue is already empty", () => {
    expect(queueReducer(EMPTY_QUEUE, { type: "clear" })).toBe(EMPTY_QUEUE);
  });

  test("an unknown action throws rather than silently returning the queue", () => {
    // The default clause exists to keep the union exhaustive at compile time;
    // reaching it at runtime means the two drifted.
    expect(() => queueReducer(EMPTY_QUEUE, { type: "nope" } as never)).toThrow(/unhandled/);
  });
});

describe("drainText", () => {
  test("queued messages come back ahead of the half-typed input", () => {
    expect(drainText(queued("first", "second"), "third")).toBe("first\n\nsecond\n\nthird");
  });

  test("an empty input contributes nothing", () => {
    expect(drainText(queued("only"), "   ")).toBe("only");
  });

  test("an empty queue leaves the input alone", () => {
    expect(drainText(EMPTY_QUEUE, "typing")).toBe("typing");
  });
});
