// Copyright 2026 the AAI authors. MIT license.
// Policy specs for preemptive generation, against a fake speculative stream.
// The transport-level guarantees (no TTS, no tool execution, no history trace)
// live in pipeline-preemption.test.ts.

import { PREEMPTIVE_QUIET_MS } from "@alexkroman1/aai/host-internal";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { silentLogger } from "../../../_logger-test-utils.ts";
import type { Logger } from "../../../logger.ts";
import type { SpeculativeStream } from "../llm/index.ts";
import { createSpeculationController, type SpeculationControllerDeps } from "./speculation.ts";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

/** An interim, then the caller pausing long enough for it to fire. */
function settle(a: { ctl: { onPartial(text: string): void } }, text: string): void {
  a.ctl.onPartial(text);
  vi.advanceTimersByTime(PREEMPTIVE_QUIET_MS);
}

type FakeStream = SpeculativeStream & {
  readonly abort: ReturnType<typeof vi.fn>;
  setPoisoned(): void;
};

function fakeStream(prompt: string): FakeStream {
  let poisoned = false;
  let aborted = false;
  const abort = vi.fn(() => {
    aborted = true;
  });
  return {
    prompt,
    ageMs: () => 42,
    poisoned: () => poisoned,
    aborted: () => aborted,
    abort,
    adopt: () => ({
      entries: async function* () {
        /* nothing to replay in the policy specs */
      },
      steps: async () => [],
      stalled: () => false,
      // The policy specs never reach the late-poison restart; the real
      // implementation aborts the underlying request here.
      abandon: abort,
    }),
    setPoisoned() {
      poisoned = true;
    },
  };
}

/**
 * A logger that records the REASON on every "Pipeline speculation discarded"
 * line. The fuzz (`integration/_pipeline-fuzz-run.ts`) counts each reason off
 * that exact line and deliberately floors none of them — its note beside the
 * counters says why — so a discard rule that stops applying has to fail HERE,
 * where the interleaving is written down rather than drawn.
 */
function recordingLog(): { log: Logger; discards: string[] } {
  const discards: string[] = [];
  const log: Logger = {
    ...silentLogger,
    debug: (msg: string, meta?: unknown) => {
      if (msg !== "Pipeline speculation discarded") return;
      discards.push((meta as { reason: string }).reason);
    },
  };
  return { log, discards };
}

function harness(overrides: Partial<SpeculationControllerDeps> = {}): {
  ctl: ReturnType<typeof createSpeculationController>;
  started: FakeStream[];
  /** The prompt each `start` was handed, in order — the parity key's source. */
  startedPrompts: string[];
  bumpHistory(): void;
  setPrompt(next: string): void;
} {
  const started: FakeStream[] = [];
  const startedPrompts: string[] = [];
  let revision = 0;
  let prompt = "base prompt";
  const deps: SpeculationControllerDeps = {
    enabled: true,
    quietMs: PREEMPTIVE_QUIET_MS,
    isIdle: () => true,
    historyRevision: () => revision,
    historyIsCurrent: (n) => n === revision,
    systemPrompt: () => prompt,
    start: (userText, systemPrompt) => {
      const s = fakeStream(userText);
      started.push(s);
      startedPrompts.push(systemPrompt);
      return s;
    },
    log: silentLogger,
    sid: "t",
    ...overrides,
  };
  return {
    ctl: createSpeculationController(deps),
    started,
    startedPrompts,
    bumpHistory: () => {
      revision += 1;
    },
    setPrompt: (next: string) => {
      prompt = next;
    },
  };
}

describe("firing rules", () => {
  test("fires once the text has held still for the quiet window, not before", () => {
    const a = harness();
    a.ctl.onPartial("what is my order status");
    vi.advanceTimersByTime(PREEMPTIVE_QUIET_MS - 1);
    expect(a.started).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(a.started).toHaveLength(1);
    expect(a.started[0]?.prompt).toBe("what is my order status");
  });

  test("new text restarts the window, and the speculation is built on the latest", () => {
    const a = harness();
    a.ctl.onPartial("what is");
    vi.advanceTimersByTime(PREEMPTIVE_QUIET_MS - 1);
    a.ctl.onPartial("what is my order status");
    vi.advanceTimersByTime(PREEMPTIVE_QUIET_MS - 1);
    expect(a.started).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(a.started.map((x) => x.prompt)).toEqual(["what is my order status"]);
  });

  test("the same text re-sent does not hold the window open", () => {
    // A provider re-emitting its last interim (or re-punctuating it) is not new
    // speech; re-arming on it would postpone the fire for as long as it repeats.
    const a = harness();
    a.ctl.onPartial("what is my order status");
    vi.advanceTimersByTime(PREEMPTIVE_QUIET_MS - 50);
    a.ctl.onPartial("What is my order status?");
    vi.advanceTimersByTime(50);
    expect(a.started).toHaveLength(1);
  });

  test("a zero window fires on the partial itself", () => {
    const a = harness({ quietMs: 0 });
    a.ctl.onPartial("what is my order status");
    expect(a.started).toHaveLength(1);
  });

  test("disabled never fires", () => {
    const a = harness({ enabled: false });
    settle(a, "what is my order status");
    expect(a.started).toHaveLength(0);
    expect(a.ctl.take("what is my order status")).toBeNull();
  });

  test("a busy transport never fires", () => {
    const a = harness({ isIdle: () => false });
    settle(a, "what is my order status");
    expect(a.started).toHaveLength(0);
  });

  test("idleness is read when the window closes, not when the partial arrived", () => {
    let idle = false;
    const a = harness({ isIdle: () => idle });
    a.ctl.onPartial("what is my order status");
    idle = true;
    vi.advanceTimersByTime(PREEMPTIVE_QUIET_MS);
    expect(a.started).toHaveLength(1);
  });

  test("does NOT re-fire on identical text", () => {
    const a = harness();
    settle(a, "my order is twelve thirty four");
    settle(a, "my order is twelve thirty four");
    expect(a.started).toHaveLength(1);
    expect(a.started[0]?.abort).not.toHaveBeenCalled();
  });

  test("normalization means punctuation alone is not a new utterance", () => {
    const a = harness();
    settle(a, "my order is 1234");
    settle(a, "My order is 1234.");
    expect(a.started).toHaveLength(1);
  });

  test.each([
    ["a final", (a: ReturnType<typeof harness>) => a.ctl.onFinal("what is my order status")],
    ["a take", (a: ReturnType<typeof harness>) => a.ctl.take("what is my order status")],
    ["a discard", (a: ReturnType<typeof harness>) => a.ctl.discard("reset")],
    ["an idle utterance", (a: ReturnType<typeof harness>) => a.ctl.onUtteranceIdle()],
  ])("%s inside the window cancels the pending fire", (_label, act) => {
    const a = harness();
    a.ctl.onPartial("what is my order status");
    act(a);
    vi.advanceTimersByTime(PREEMPTIVE_QUIET_MS * 2);
    expect(a.started).toHaveLength(0);
  });
});

describe("mid-utterance pauses", () => {
  test("a changed partial ABORTS the live speculation immediately", () => {
    const r = recordingLog();
    const a = harness({ log: r.log });
    settle(a, "my number is five five five");
    const first = a.started[0];
    a.ctl.onPartial("my number is five five five one");
    expect(first?.abort).toHaveBeenCalledTimes(1);
    // And logged as the caller REVISING what they said — the reason the fuzz
    // counts as `speculationDiscarded:superseded`.
    expect(r.discards).toEqual(["superseded"]);
    // Aborted, not merely dropped: the store no longer holds it either.
    expect(a.ctl.take("my number is five five five")).toBeNull();
  });

  test("bounded per utterance however often the caller pauses", () => {
    const a = harness();
    // A dictated identifier, with a pause after every group.
    for (const text of [
      "five five",
      "five five five",
      "five five five one",
      "five five five one two",
    ]) {
      settle(a, text);
    }
    expect(a.started.length).toBeLessThanOrEqual(2);
  });

  test("the budget is restored when the utterance ends", () => {
    const a = harness();
    settle(a, "one");
    settle(a, "two");
    settle(a, "three");
    expect(a.started).toHaveLength(2);
    a.ctl.onUtteranceIdle();
    settle(a, "four");
    expect(a.started).toHaveLength(3);
  });
});

describe("take", () => {
  function live(): ReturnType<typeof harness> {
    const a = harness();
    settle(a, "what is my order status");
    return a;
  }

  test("returns the stream when the final differs only in case/punctuation", () => {
    const a = live();
    expect(a.ctl.take("What is my order status?")).toBe(a.started[0]);
  });

  test.each([
    ["an extension", "what is my order status please"],
    ["a truncation", "what is my order"],
    ["a revision", "what is my refund status"],
  ])("returns null on %s, and aborts", (_label, final) => {
    const a = live();
    expect(a.ctl.take(final)).toBeNull();
    expect(a.started[0]?.abort).toHaveBeenCalled();
  });

  test("returns null when the tape is poisoned by a tool call or an error", () => {
    const a = live();
    a.started[0]?.setPoisoned();
    expect(a.ctl.take("what is my order status")).toBeNull();
    expect(a.started[0]?.abort).toHaveBeenCalled();
  });

  test("returns null when the history revision moved", () => {
    const a = live();
    a.bumpHistory();
    expect(a.ctl.take("what is my order status")).toBeNull();
  });

  test("returns null when the SYSTEM PROMPT moved, and aborts", () => {
    // A `dialog()` phase advanced between the interim that fired this and the
    // final that would adopt it. The request in flight carries the old
    // instructions and `system` cannot be amended mid-stream, so adopting it
    // would speak a reply generated under the wrong phase's rules — silently,
    // and only on the turns where preemption happened to fire.
    const a = live();
    a.setPrompt("base prompt\n\nPhase: collecting the shipping address.");
    expect(a.ctl.take("what is my order status")).toBeNull();
    expect(a.started[0]?.abort).toHaveBeenCalled();
  });

  test("an unchanged prompt is not a mismatch — the head start survives", () => {
    // The default path, and the one that must not regress: every agent without
    // a per-turn suffix resolves the same string on both reads.
    const a = live();
    expect(a.ctl.take("what is my order status")).toBe(a.started[0]);
  });

  test("the recorded parity key is the prompt the REQUEST was built on", () => {
    // One resolution, two uses. Resolving again inside `start` could record a
    // prompt the model never saw, and the check above would then pass on a lie.
    const a = harness();
    a.setPrompt("phase one");
    settle(a, "what is my order status");
    expect(a.startedPrompts).toEqual(["phase one"]);
    expect(a.ctl.take("what is my order status")).toBe(a.started[0]);
  });

  test("claims exactly once — a second turn cannot adopt the same stream", () => {
    const a = live();
    expect(a.ctl.take("what is my order status")).not.toBeNull();
    expect(a.ctl.take("what is my order status")).toBeNull();
  });
});

describe("discard", () => {
  test("onFinal aborts a speculation the final cannot match", () => {
    const r = recordingLog();
    const a = harness({ log: r.log });
    settle(a, "what is my order status");
    a.ctl.onFinal("cancel my order");
    expect(a.started[0]?.abort).toHaveBeenCalledTimes(1);
    // Logged as the FINAL disagreeing with the speculated text — the reason the
    // fuzz counts as `speculationDiscarded:mismatch`.
    expect(r.discards).toEqual(["mismatch"]);
  });

  test("onFinal keeps a matching speculation for take()", () => {
    const a = harness();
    settle(a, "what is my order status");
    a.ctl.onFinal("What is my order status?");
    expect(a.started[0]?.abort).not.toHaveBeenCalled();
    expect(a.ctl.take("What is my order status?")).toBe(a.started[0]);
  });

  test("onUtteranceIdle discards and aborts", () => {
    const a = harness();
    settle(a, "what is my order status");
    a.ctl.onUtteranceIdle();
    expect(a.started[0]?.abort).toHaveBeenCalledTimes(1);
    expect(a.ctl.take("what is my order status")).toBeNull();
  });

  test("an explicit discard aborts", () => {
    const a = harness();
    settle(a, "what is my order status");
    a.ctl.discard("reset");
    expect(a.started[0]?.abort).toHaveBeenCalledTimes(1);
  });
});
