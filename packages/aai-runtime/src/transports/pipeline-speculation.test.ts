// Copyright 2026 the AAI authors. MIT license.
// Policy specs for preemptive generation, against a fake speculative stream.
// The transport-level guarantees (no TTS, no tool execution, no history trace)
// live in pipeline-preemption.test.ts.

import { PREEMPTIVE_CONFIDENCE_THRESHOLD } from "@alexkroman1/aai/host-internal";
import { describe, expect, test, vi } from "vitest";
import { silentLogger } from "../_test-utils.ts";
import {
  createSpeculationController,
  type SpeculationControllerDeps,
} from "./pipeline-speculation.ts";
import type { SpeculativeStream } from "./pipeline-speculative-stream.ts";

const ABOVE = PREEMPTIVE_CONFIDENCE_THRESHOLD;
const BELOW = PREEMPTIVE_CONFIDENCE_THRESHOLD - 0.1;

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
      // The policy specs never reach the late-poison restart; the real
      // implementation aborts the underlying request here.
      abandon: abort,
    }),
    setPoisoned() {
      poisoned = true;
    },
  };
}

function harness(overrides: Partial<SpeculationControllerDeps> = {}): {
  ctl: ReturnType<typeof createSpeculationController>;
  started: FakeStream[];
  bumpHistory(): void;
} {
  const started: FakeStream[] = [];
  let revision = 0;
  const deps: SpeculationControllerDeps = {
    enabled: true,
    isIdle: () => true,
    historyRevision: () => revision,
    historyIsCurrent: (n) => n === revision,
    start: (userText) => {
      const s = fakeStream(userText);
      started.push(s);
      return s;
    },
    log: silentLogger,
    sid: "t",
    ...overrides,
  };
  return {
    ctl: createSpeculationController(deps),
    started,
    bumpHistory: () => {
      revision += 1;
    },
  };
}

describe("firing rules", () => {
  test("fires above the threshold and not below", () => {
    const a = harness();
    a.ctl.onPartial("what is my order status", BELOW);
    expect(a.started).toHaveLength(0);

    const b = harness();
    b.ctl.onPartial("what is my order status", ABOVE);
    expect(b.started).toHaveLength(1);
  });

  test("no confidence at all never fires", () => {
    const a = harness();
    a.ctl.onPartial("what is my order status");
    expect(a.started).toHaveLength(0);
  });

  test("disabled never fires", () => {
    const a = harness({ enabled: false });
    a.ctl.onPartial("what is my order status", 1);
    expect(a.started).toHaveLength(0);
    expect(a.ctl.take("what is my order status")).toBeNull();
  });

  test("a busy transport never fires", () => {
    const a = harness({ isIdle: () => false });
    a.ctl.onPartial("what is my order status", 1);
    expect(a.started).toHaveLength(0);
  });

  test("does NOT re-fire on identical text at rising confidence", () => {
    // The recorded `0.95 → 1` terminal re-emission — see
    // SttTurnMeta.endOfTurnConfidence.
    const a = harness();
    a.ctl.onPartial("my order is twelve thirty four", 0.95);
    a.ctl.onPartial("my order is twelve thirty four", 1);
    expect(a.started).toHaveLength(1);
    expect(a.started[0]?.abort).not.toHaveBeenCalled();
  });

  test("normalization means punctuation alone is not a new utterance", () => {
    const a = harness();
    a.ctl.onPartial("my order is 1234", 1);
    a.ctl.onPartial("My order is 1234.", 1);
    expect(a.started).toHaveLength(1);
  });
});

describe("the confidence sawtooth", () => {
  test("a changed partial ABORTS the live speculation immediately", () => {
    const a = harness();
    a.ctl.onPartial("my number is five five five", 1);
    const first = a.started[0];
    a.ctl.onPartial("my number is five five five one", 0);
    expect(first?.abort).toHaveBeenCalledTimes(1);
    // Aborted, not merely dropped: the store no longer holds it either.
    expect(a.ctl.take("my number is five five five")).toBeNull();
  });

  test("bounded per utterance however the confidence sawtooths", () => {
    const a = harness();
    // Rising / falling / rising across revisions of the same dictated
    // identifier — the shape recorded on SttTurnMeta.endOfTurnConfidence.
    const revisions = [
      "five five",
      "five five five",
      "five five five one",
      "five five five one two",
    ];
    for (const text of revisions) {
      a.ctl.onPartial(text, 0);
      a.ctl.onPartial(text, 1);
    }
    expect(a.started.length).toBeLessThanOrEqual(2);
  });

  test("the budget is restored when the utterance ends", () => {
    const a = harness();
    a.ctl.onPartial("one", 1);
    a.ctl.onPartial("two", 1);
    a.ctl.onPartial("three", 1);
    expect(a.started).toHaveLength(2);
    a.ctl.onUtteranceIdle();
    a.ctl.onPartial("four", 1);
    expect(a.started).toHaveLength(3);
  });
});

describe("take", () => {
  function live(): ReturnType<typeof harness> {
    const a = harness();
    a.ctl.onPartial("what is my order status", 1);
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

  test("claims exactly once — a second turn cannot adopt the same stream", () => {
    const a = live();
    expect(a.ctl.take("what is my order status")).not.toBeNull();
    expect(a.ctl.take("what is my order status")).toBeNull();
  });
});

describe("discard", () => {
  test("onFinal aborts a speculation the final cannot match", () => {
    const a = harness();
    a.ctl.onPartial("what is my order status", 1);
    a.ctl.onFinal("cancel my order");
    expect(a.started[0]?.abort).toHaveBeenCalledTimes(1);
  });

  test("onFinal keeps a matching speculation for take()", () => {
    const a = harness();
    a.ctl.onPartial("what is my order status", 1);
    a.ctl.onFinal("What is my order status?");
    expect(a.started[0]?.abort).not.toHaveBeenCalled();
    expect(a.ctl.take("What is my order status?")).toBe(a.started[0]);
  });

  test("onUtteranceIdle discards and aborts", () => {
    const a = harness();
    a.ctl.onPartial("what is my order status", 1);
    a.ctl.onUtteranceIdle();
    expect(a.started[0]?.abort).toHaveBeenCalledTimes(1);
    expect(a.ctl.take("what is my order status")).toBeNull();
  });

  test("an explicit discard aborts", () => {
    const a = harness();
    a.ctl.onPartial("what is my order status", 1);
    a.ctl.discard("reset");
    expect(a.started[0]?.abort).toHaveBeenCalledTimes(1);
  });
});
