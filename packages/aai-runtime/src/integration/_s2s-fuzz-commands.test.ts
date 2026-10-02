// Copyright 2026 the AAI authors. MIT license.
/**
 * The S2S fuzz's commands: legality lives in each `check()` against the service
 * model, so a counterexample holds only commands that ran — and `run()` keeps
 * the model in step with what the session really did.
 */

import { describe, expect, test } from "vitest";
import {
  AgentText,
  ClientReset,
  type Cmd,
  Drop,
  OpenSocket,
  Ready,
  ReplyDone,
  ReplyStart,
  SettleTool,
  SpeechStart,
  SpeechStop,
  ToolCall,
  ToolTurnAcrossResume,
} from "./_s2s-fuzz-commands.ts";
import { createHarness, type Harness } from "./_s2s-fuzz-harness.ts";
import { freshModel, type ServiceModel } from "./_s2s-fuzz-service.ts";

/** Run a command only when its precondition holds, as `fc.commands` does. */
async function step(cmd: Cmd, m: ServiceModel, h: Harness): Promise<boolean> {
  if (!cmd.check(m)) return false;
  await cmd.run(m, h);
  return true;
}

describe("preconditions", () => {
  test("speech pairs, a reply needs a ready socket, and faults need budget", () => {
    const m = freshModel(0);
    expect(new SpeechStop().check(m)).toBe(false);
    expect(new SpeechStart().check(m)).toBe(true);
    expect(new AgentText().check(m)).toBe(false);
    expect(new ReplyStart().check(m)).toBe(true);
    expect(new Drop(true, 0).check(m)).toBe(false);
    expect(new ClientReset().check(m)).toBe(false);
    expect(new ToolTurnAcrossResume().check(m)).toBe(false);
    expect(new SettleTool(true).check(m)).toBe(false);
    expect(new OpenSocket().check(m)).toBe(false);
    expect(new Ready(false).check(m)).toBe(false);
  });

  test("a reply that carried a tool call speaks no agent transcript", () => {
    const m = freshModel(0);
    m.replyInFlight = true;
    expect(new AgentText().check(m)).toBe(true);
    m.sawToolCall = true;
    expect(new AgentText().check(m)).toBe(false);
  });

  test("labels read as the frame each command delivers", () => {
    expect(String(new Ready(true))).toBe("ready(session.updated)");
    expect(String(new ReplyDone(true))).toBe("reply.done(interrupted)");
    expect(String(new Drop(false, 1))).toBe("drop.fatal(4001)");
    expect(String(new Drop(true, 0))).toBe("drop.transient(1005)");
    expect(String(new SettleTool(false))).toBe("settleTool(throws)");
  });
});

describe("a tool turn, command by command", () => {
  test("the call is executed, settled, and answered once the reply completes", async () => {
    const h = await createHarness({});
    try {
      const m = freshModel(0);
      expect(await step(new ReplyStart(), m, h)).toBe(true);
      expect(await step(new ToolCall(), m, h)).toBe(true);
      expect(m.toolsInFlight).toBe(1);
      expect(await step(new SettleTool(true), m, h)).toBe(true);
      expect(m.toolsInFlight).toBe(0);
      expect(await step(new ReplyDone(false), m, h)).toBe(true);
      // The answer was flushed and seen, so the model no longer holds the call.
      expect(m.outstanding.size).toBe(0);
      expect([...h.link.calls.values()].map((call) => call.answers)).toEqual([1]);
    } finally {
      await h.session.stop();
    }
  });

  test("a tool turn across a resume spends one fault and comes back ready", async () => {
    const cov: Record<string, number> = {};
    const h = await createHarness(cov);
    try {
      const m = freshModel(1);
      await step(new ReplyStart(), m, h);
      expect(await step(new ToolTurnAcrossResume(), m, h)).toBe(true);
      expect(m.faultBudget).toBe(0);
      expect(m.ready).toBe(true);
      expect(h.link.sockets).toHaveLength(2);
      expect(cov.resumeCompleted).toBe(1);
      expect([...h.link.calls.values()][0]?.survivedResume).toBe(true);
    } finally {
      await h.session.stop();
    }
  });
});
