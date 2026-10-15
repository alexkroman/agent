// Copyright 2026 the AAI authors. MIT license.
// A turn the sandbox dropped mid-stream — a platform deploy terminating the
// guest under it — is sent again once, by regenerating it, and the panel
// says so while it does.

import { describe, expect, it, vi } from "vitest";
import { StaleSandboxError, TurnDroppedError } from "./resilient-fetch.ts";
import { createTurnRecovery, type TurnRecoveryOptions } from "./turn-recovery.ts";

/**
 * A chat whose turns end however `outcomes` says, in order — `useChat`
 * reports a failure to `onError` and then resolves, never rejects.
 */
function chatWith(outcomes: (Error | null)[]) {
  const calls: string[] = [];
  const recovering: boolean[] = [];
  const next = (kind: string) => {
    calls.push(kind);
    const outcome = outcomes.shift() ?? null;
    if (outcome) recovery.onError(outcome);
    return Promise.resolve();
  };
  const options: TurnRecoveryOptions = {
    sendMessage: vi.fn(() => next("send")),
    regenerate: vi.fn(() => next("regenerate")),
    onRecovering: (value) => recovering.push(value),
  };
  const recovery = createTurnRecovery(options);
  return { recovery, calls, recovering };
}

describe("createTurnRecovery", () => {
  it("a turn that finishes is sent once and nothing else happens", async () => {
    const { recovery, calls, recovering } = chatWith([null]);
    await recovery.send({ text: "hi" });
    expect(calls).toEqual(["send"]);
    expect(recovering).toEqual([]);
  });

  it("a dropped turn is regenerated — never re-sent, which would duplicate the message", async () => {
    const { recovery, calls, recovering } = chatWith([new TurnDroppedError(), null]);
    await recovery.send({ text: "hi" });
    expect(calls).toEqual(["send", "regenerate"]);
    // Raised when the drop is reported — before the chat shows the error —
    // and lowered once the regeneration is over.
    expect(recovering).toEqual([true, false]);
  });

  it("regenerates ONCE: a regeneration that drops too is the turn's outcome", async () => {
    const { recovery, calls, recovering } = chatWith([
      new TurnDroppedError(),
      new TurnDroppedError(),
    ]);
    await recovery.send({ text: "hi" });
    expect(calls).toEqual(["send", "regenerate"]);
    expect(recovering).toEqual([true, false]);
  });

  it("any other failure is the turn's own, and is left to the chat", async () => {
    // A stale sandbox is the transport's retry, already spent by the time the
    // chat sees it; a model error is an answer.
    const { recovery, calls } = chatWith([new StaleSandboxError("refused")]);
    await recovery.send({ text: "hi" });
    const { recovery: second, calls: secondCalls } = chatWith([new Error("model failed")]);
    await second.send({ text: "hi" });
    expect(calls).toEqual(["send"]);
    expect(secondCalls).toEqual(["send"]);
  });

  it("each turn gets its own one recovery", async () => {
    const { recovery, calls } = chatWith([
      new TurnDroppedError(),
      null,
      new TurnDroppedError(),
      null,
    ]);
    await recovery.send({ text: "one" });
    await recovery.send({ text: "two" });
    expect(calls).toEqual(["send", "regenerate", "send", "regenerate"]);
  });

  it("lowers the notice even when the regeneration throws", async () => {
    const recovering: boolean[] = [];
    const recovery: ReturnType<typeof createTurnRecovery> = createTurnRecovery({
      sendMessage: () => {
        recovery.onError(new TurnDroppedError());
        return Promise.resolve();
      },
      regenerate: () => Promise.reject(new Error("no message to regenerate")),
      onRecovering: (value) => recovering.push(value),
    });
    await expect(recovery.send({ text: "hi" })).rejects.toThrow("no message to regenerate");
    expect(recovering).toEqual([true, false]);
  });
});
