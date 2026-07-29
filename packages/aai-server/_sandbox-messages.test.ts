// Copyright 2026 the AAI authors. MIT license.
/**
 * Unit tests for the host-side message delta tracker: the "may I append?"
 * identity check, splice/reset fallback to full sends, per-session
 * independence, and the desync response detector.
 */

import type { Message } from "@alexkroman1/aai";
import { describe, expect, test } from "vitest";
import { createMessageDeltaTracker, isMessagesDesync } from "./_sandbox-messages.ts";
import { createSessionMessagesCache, MESSAGES_DESYNC_ERROR } from "./guest/harness-messages.ts";

function msg(content: string, role: Message["role"] = "user"): Message {
  return { role, content };
}

describe("createMessageDeltaTracker", () => {
  test("first call for a session sends full history", () => {
    const tracker = createMessageDeltaTracker();
    const history = [msg("a"), msg("b")];

    const delta = tracker.delta("s1", history);

    expect(delta).toEqual({ messages: history, messagesMode: "full" });
  });

  test("appends only the tail when the sent prefix is identity-stable", () => {
    const tracker = createMessageDeltaTracker();
    const a = msg("a");
    const b = msg("b", "assistant");
    const c = msg("c");
    tracker.delta("s1", [a, b]);

    // The runtime snapshots with history.slice(): fresh array, same elements.
    const delta = tracker.delta("s1", [a, b, c]);

    expect(delta).toEqual({ messages: [c], messagesMode: "append", messagesBase: 2 });
  });

  test("unchanged history appends an empty tail", () => {
    const tracker = createMessageDeltaTracker();
    const a = msg("a");
    tracker.delta("s1", [a]);

    const delta = tracker.delta("s1", [a]);

    expect(delta).toEqual({ messages: [], messagesMode: "append", messagesBase: 1 });
  });

  test("appends everything after a session started empty", () => {
    const tracker = createMessageDeltaTracker();
    tracker.delta("s1", []);

    const a = msg("a");
    const delta = tracker.delta("s1", [a]);

    expect(delta).toEqual({ messages: [a], messagesMode: "append", messagesBase: 0 });
  });

  test("front splice (maxHistory cap) breaks identity and falls back to full", () => {
    const tracker = createMessageDeltaTracker();
    const a = msg("a");
    const b = msg("b");
    const c = msg("c");
    tracker.delta("s1", [a, b]);

    // The cap spliced `a` off the front — messages[0] is a different object.
    const delta = tracker.delta("s1", [b, c]);

    expect(delta.messagesMode).toBe("full");
    expect(delta.messages).toEqual([b, c]);
  });

  test("equal-content but different objects at the watermark forces full", () => {
    const tracker = createMessageDeltaTracker();
    tracker.delta("s1", [msg("a")]);

    // A reset rebuilt the history: structurally equal, different identity.
    const delta = tracker.delta("s1", [msg("a"), msg("b")]);

    expect(delta.messagesMode).toBe("full");
  });

  test("shrunken history (client reset) falls back to full", () => {
    const tracker = createMessageDeltaTracker();
    const a = msg("a");
    const b = msg("b");
    tracker.delta("s1", [a, b]);

    const delta = tracker.delta("s1", [a]);

    expect(delta.messagesMode).toBe("full");
    expect(delta.messages).toEqual([a]);
  });

  test("sessions are tracked independently", () => {
    const tracker = createMessageDeltaTracker();
    const a = msg("a");
    tracker.delta("s1", [a]);

    const other = tracker.delta("s2", [a]);
    expect(other.messagesMode).toBe("full");

    const delta = tracker.delta("s1", [a, msg("b")]);
    expect(delta.messagesMode).toBe("append");
  });

  test("reset forces the next call to send full history", () => {
    const tracker = createMessageDeltaTracker();
    const a = msg("a");
    tracker.delta("s1", [a]);
    tracker.reset("s1");

    const delta = tracker.delta("s1", [a, msg("b")]);

    expect(delta.messagesMode).toBe("full");
  });

  test("full sends copy the snapshot so callers cannot alias the params array", () => {
    const tracker = createMessageDeltaTracker();
    const history = [msg("a")];

    const delta = tracker.delta("s1", history);

    expect(delta.messages).not.toBe(history);
    expect(delta.messages).toEqual(history);
  });
});

describe("randomized host↔guest delta round-trip", () => {
  /** Tiny seeded PRNG (mulberry32) — deterministic, no Math.random. */
  function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d_2b_79_f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
    };
  }

  /** Append 1–3 new messages (the common case between tool calls). */
  function appendRandom(rand: () => number, history: Message[], nextId: () => number): void {
    const n = 1 + Math.floor(rand() * 3);
    for (let i = 0; i < n; i++) {
      history.push(msg(`m${nextId()}`, rand() < 0.5 ? "user" : "assistant"));
    }
  }

  /**
   * Randomly mutate one session's history in place (append / front splice /
   * reset / no-op). Returns true when the guest cache should be replaced,
   * simulating a guest restart or eviction. `nextId` hands out unique
   * message contents.
   */
  function mutateHistory(rand: () => number, history: Message[], nextId: () => number): boolean {
    const op = rand();
    if (op < 0.55) {
      appendRandom(rand, history, nextId);
    } else if (op < 0.7) {
      // maxHistory cap: splice from the front (breaks prefix identity).
      history.splice(0, 1 + Math.floor(rand() * history.length));
    } else if (op < 0.78) {
      // Client reset: history emptied in place.
      history.length = 0;
    } else if (op < 0.88) {
      // Guest restart / cache eviction: the next append must desync, and
      // the host's full-history retry must heal it.
      return true;
    }
    // else: unchanged history — a repeat tool call in the same state.
    return false;
  }

  test("guest reconstruction equals host history across ~200 random operations", () => {
    const rand = mulberry32(0xc0_ff_ee);
    const tracker = createMessageDeltaTracker();
    let guest = createSessionMessagesCache();
    // Three interleaved sessions, each with its own append-only history.
    const histories: Message[][] = [[], [], []];
    let counter = 0;
    const nextId = () => counter++;

    for (let step = 0; step < 200; step++) {
      const idx = Math.floor(rand() * histories.length);
      const sid = `s${idx}`;
      const history = histories[idx] ?? [];
      if (mutateHistory(rand, history, nextId)) {
        guest = createSessionMessagesCache();
      }

      // One tool/execute round-trip, mirroring sandbox.ts's retry protocol:
      // snapshot → delta → apply; on desync, reset and resend full.
      const snapshot = history.slice();
      let delta = tracker.delta(sid, snapshot);
      let reconstructed = guest.apply(sid, delta.messages, delta.messagesMode, delta.messagesBase);
      if (reconstructed === null) {
        tracker.reset(sid);
        delta = tracker.delta(sid, snapshot);
        reconstructed = guest.apply(sid, delta.messages, delta.messagesMode, delta.messagesBase);
      }
      expect(reconstructed, `step ${step} (session ${sid})`).toEqual(snapshot);
    }
  });
});

describe("isMessagesDesync", () => {
  test("matches the guest's desync error response", () => {
    expect(isMessagesDesync({ error: MESSAGES_DESYNC_ERROR })).toBe(true);
  });

  test("rejects everything else", () => {
    expect(isMessagesDesync({ error: "boom" })).toBe(false);
    expect(isMessagesDesync({ result: MESSAGES_DESYNC_ERROR })).toBe(false);
    expect(isMessagesDesync(undefined)).toBe(false);
    expect(isMessagesDesync(null)).toBe(false);
    expect(isMessagesDesync(MESSAGES_DESYNC_ERROR)).toBe(false);
  });
});
