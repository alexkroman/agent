// Copyright 2026 the AAI authors. MIT license.
/**
 * The S2S fuzz's service model and the frames it emits: each `emit*` keeps the
 * model and the link's ledgers in step, and `syncFromReality` re-reads what
 * the code under test actually did.
 */

import { describe, expect, test } from "vitest";
import { createHarness, drain, FIRST_SESSION_ID } from "./_s2s-fuzz-harness.ts";
import {
  emitDrop,
  emitReady,
  emitReplyDone,
  emitToolCall,
  freshModel,
  hit,
  syncFromReality,
} from "./_s2s-fuzz-service.ts";

describe("freshModel", () => {
  test("starts ready on the harness's first session, with the given fault budget", () => {
    expect(freshModel(2)).toMatchObject({
      faultBudget: 2,
      ready: true,
      awaitingOpen: false,
      sessionId: FIRST_SESSION_ID,
      replyInFlight: false,
      retired: false,
    });
    expect(freshModel(0).outstanding.size).toBe(0);
  });
});

describe("the emitters", () => {
  test("a tool call is recorded as outstanding, and a completed reply keeps it so", async () => {
    const h = await createHarness({});
    try {
      const m = freshModel(1);
      m.replyId = "rep-1";
      emitToolCall(m, h);
      const [callId] = [...m.outstanding];
      expect(callId).toBe("call-0-1");
      expect(m.sawToolCall).toBe(true);
      expect(h.link.calls.get(callId ?? "")?.replyId).toBe("rep-1");

      emitReplyDone(m, h, false);
      expect(m.outstanding.size).toBe(1);
      expect(h.link.calls.get(callId ?? "")?.replyEnded).toBe("completed");
      expect(m.replyInFlight).toBe(false);
    } finally {
      await h.session.stop();
    }
  });

  test("an interrupted reply clears what was outstanding", async () => {
    const h = await createHarness({});
    try {
      const m = freshModel(1);
      emitToolCall(m, h);
      emitReplyDone(m, h, true);
      expect(m.outstanding.size).toBe(0);
    } finally {
      await h.session.stop();
    }
  });

  test("a drop spends budget; the resume it causes is answered on the new socket", async () => {
    const cov: Record<string, number> = {};
    const h = await createHarness(cov);
    try {
      const m = freshModel(1);
      emitDrop(m, h, 1006, "");
      expect(m.faultBudget).toBe(0);
      expect(m.ready).toBe(false);
      await drain();
      syncFromReality(m, h);
      expect(m.awaitingOpen).toBe(true);

      h.link.unopened()?.open();
      await drain();
      emitReady(m, h, false);
      await drain();
      syncFromReality(m, h);
      // The new socket asked to resume the first session, and got it back.
      expect(h.link.resumeRequests).toEqual([FIRST_SESSION_ID]);
      expect(m.sessionId).toBe(FIRST_SESSION_ID);
      expect(m.ready).toBe(true);
      expect(cov.resumeCompleted).toBe(1);
    } finally {
      await h.session.stop();
    }
  });
});

describe("hit", () => {
  test("counts on the harness's shared table", async () => {
    const h = await createHarness({});
    try {
      hit(h, "x");
      hit(h, "x");
      expect(h.cov.x).toBe(2);
    } finally {
      await h.session.stop();
    }
  });
});
