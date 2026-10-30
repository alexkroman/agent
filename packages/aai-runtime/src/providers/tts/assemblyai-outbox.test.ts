// Copyright 2026 the AAI authors. MIT license.
// The TTS outbox on its own: the unspoken-character cap, what releases a held
// backlog, and requeue after a dropped socket. Virtual time.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createControlBudget } from "./assemblyai-control-budget.ts";
import { createTtsOutbox, MAX_UNSPOKEN_CHARS } from "./assemblyai-outbox.ts";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function makeOutbox() {
  const sent: string[] = [];
  const state = { canSend: true, closed: 0 };
  const outbox = createTtsOutbox({
    budget: createControlBudget(),
    canSend: () => state.canSend,
    sendFlush: (text) => {
      sent.push(text);
      return true;
    },
    closeTurn: () => {
      state.closed += 1;
    },
  });
  outbox.beginTurn();
  return { outbox, sent, state };
}

/** A sentence of exactly `n` characters (n >= 12). */
const sentence = (n: number) => `${"a".repeat(n - 11)} b c end. `;

describe("createTtsOutbox", () => {
  test("holds a flush that would take the unspoken characters over the cap", () => {
    const { outbox, sent } = makeOutbox();
    const big = sentence(MAX_UNSPOKEN_CHARS - 100);
    outbox.push(big);
    outbox.push(sentence(200));
    expect(sent).toEqual([big]);
    // The acknowledgement frees the room, and the held text goes out.
    outbox.onAck();
    expect(sent).toEqual([big, sentence(200)]);
  });

  test("cuts a held backlog at a sentence end, never mid-sentence", () => {
    const { outbox, sent } = makeOutbox();
    outbox.push(sentence(3000));
    outbox.push(sentence(900));
    // 100 characters of room: all three held, and merged once there is room.
    const backlog = [sentence(1200), sentence(1200), sentence(1200)];
    for (const s of backlog) outbox.push(s);
    expect(sent).toHaveLength(2);
    // 3100 characters of room: the first two sentences, cut where the second ends.
    outbox.onAck();
    expect(sent.at(-1)).toBe(`${backlog[0]}${backlog[1]}`);
    outbox.onAck();
    expect(sent.at(-1)).toBe(backlog[2]);
  });

  test("a sentence larger than the cap is still delivered, never over it", () => {
    const { outbox, sent } = makeOutbox();
    outbox.push(sentence(100));
    const huge = sentence(MAX_UNSPOKEN_CHARS + 1000);
    outbox.push(huge);
    outbox.close();
    let outstanding = sent.reduce((n, s) => n + s.length, 0);
    for (let acks = 0; acks < 500 && sent.join("") !== sentence(100) + huge; acks++) {
      expect(outstanding).toBeLessThanOrEqual(MAX_UNSPOKEN_CHARS);
      const before = sent.length;
      outbox.onAck();
      outstanding = sent.slice(before).reduce((n, s) => n + s.length, 0);
    }
    expect(sent.join("")).toBe(sentence(100) + huge);
  });

  test("close() waits for a held backlog before closing the turn", () => {
    const { outbox, sent, state } = makeOutbox();
    outbox.push(sentence(MAX_UNSPOKEN_CHARS - 10));
    const rest = "and then the rest of it, with no sentence end in sight at all";
    outbox.push(rest);
    outbox.close();
    expect(state.closed).toBe(0);
    outbox.onAck();
    expect(sent.slice(1).join("")).toBe(rest);
    expect(state.closed).toBe(1);
  });

  test("requeued text waits for the replacement socket, then goes out first", () => {
    const { outbox, sent, state } = makeOutbox();
    outbox.push(sentence(100));
    state.canSend = false;
    expect(outbox.takeOwed()).toEqual([sentence(100)]);
    outbox.push(sentence(50));
    outbox.requeue(sentence(100), true);
    expect(sent).toHaveLength(1);
    state.canSend = true;
    outbox.socketReady();
    expect(sent.at(-1)).toBe(sentence(100) + sentence(50));
    expect(state.closed).toBe(1);
  });
});
