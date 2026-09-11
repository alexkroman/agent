// Copyright 2026 the AAI authors. MIT license.
// Specs for the RUNTIME half of `ToolDef.messages`: when each declared line
// goes out, what it is allowed to do to the turn around it, and the latch that
// takes the model out of the loop.
//
// Every timing spec here runs on VIRTUAL time. The ladder's shipped offsets are
// seconds, and a spec that waits them out on the wall clock can only ever
// describe a squeezed version of the thing that ships.

import type { ToolMessages } from "@alexkroman1/aai";
import { serializeToolFailure } from "@alexkroman1/aai/host-internal";
import { sleep } from "@alexkroman1/aai/internal";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { makeLogger, silentLogger } from "./_test-utils.ts";
import {
  createToolSpeechController,
  estimateSpokenMs,
  TOOL_SYSTEM_HINT_LABEL,
  type ToolSpeechChannel,
} from "./tool-messages-runner.ts";

type Sent = { text: string; record: boolean };

function harness(
  overrides: Partial<ToolSpeechChannel> & { log?: ReturnType<typeof makeLogger> } = {},
) {
  const sent: Sent[] = [];
  const recorded: string[] = [];
  const log = overrides.log ?? makeLogger();
  const controller = createToolSpeechController({ log, sid: "s", random: () => 0 });
  const channel: ToolSpeechChannel = {
    send: (text, opts) => sent.push({ text, record: opts.record }),
    boundary: () => undefined,
    record: (text) => recorded.push(text),
    callerSpeaking: () => false,
    awaitSpoken: (text) => sleep(estimateSpokenMs(text)),
    ...overrides,
  };
  controller.bind(channel);
  controller.beginTurn();
  return { controller, sent, recorded, log, spoken: (): string[] => sent.map((s) => s.text) };
}

// Virtual time, per the rule in `packages/aai/CLAUDE.md`, "Specs that observe a
// timer" — the ladder's shipped offsets are seconds. Spelled out rather than
// reached for through `transports/_pipeline-transport-harness.ts`'s
// `useVirtualTime()`: this module is not a transport and importing that helper
// would pull the whole pipeline in for two lines.
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("the START message", () => {
  test("is spoken as the call begins, and NEVER as a recordable", async () => {
    // The property the whole feature rests on. `record: false` is what
    // `HeardTracker.spokeRecordable()` reads, so a turn that has played only
    // this cannot be spoken over — the bug class "Stop dead-air filler from
    // opening the barge-in gate" closed, reopened here if this ever flips.
    const { controller, sent } = harness();
    const call = controller.begin({ start: [{ content: "One sec." }] }, "lookup", {}, undefined);
    await call?.start();
    expect(sent).toEqual([{ text: "One sec.", record: false }]);
  });

  test("declines while the CALLER is talking", async () => {
    const { controller, sent } = harness({ callerSpeaking: () => true });
    const call = controller.begin({ start: [{ content: "One sec." }] }, "lookup", {}, undefined);
    await call?.start();
    expect(sent).toEqual([]);
  });

  test("does not hold the tool call up unless it is `blocking`", async () => {
    const { controller } = harness();
    const call = controller.begin({ start: [{ content: "One sec." }] }, "lookup", {}, undefined);
    let started = false;
    void call?.start().then(() => {
      started = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toBe(true);
  });

  test("`blocking` waits out the line, and only the line", async () => {
    const { controller } = harness();
    const text = "Okay, I'm cancelling that order now.";
    const call = controller.begin(
      { start: [{ content: text, blocking: true }] },
      "cancel",
      {},
      undefined,
    );
    let started = false;
    void call?.start().then(() => {
      started = true;
    });
    await vi.advanceTimersByTimeAsync(estimateSpokenMs(text) - 1);
    expect(started).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(started).toBe(true);
  });

  test("a blocking wait that never settles is bounded, and never rejects", async () => {
    // The bound is the CALL SITE's `pTimeout`, not the channel's good
    // behaviour: a tool call may not be wedged by a line the agent wanted to
    // say. `fallback` rather than a rejection, or the tool would report itself
    // as having failed.
    const { controller } = harness({ awaitSpoken: () => new Promise<void>(() => undefined) });
    const call = controller.begin(
      { start: [{ content: "Hold on.", blocking: true }] },
      "cancel",
      {},
      undefined,
    );
    let settled: "resolved" | "rejected" | undefined;
    void call
      ?.start()
      .then(() => {
        settled = "resolved";
      })
      .catch(() => {
        settled = "rejected";
      });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(settled).toBe("resolved");
  });
});

describe("the DELAYED ladder", () => {
  const ladder: ToolMessages = {
    delayed: [
      { afterMs: 3000, content: "Still checking." },
      { afterMs: 8000, content: "Almost there." },
    ],
  };

  test("rungs fire at their own offset from the CALL, not one after another", async () => {
    const { controller, spoken } = harness();
    controller.begin(ladder, "lookup", {}, undefined);
    await vi.advanceTimersByTimeAsync(2999);
    expect(spoken()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(spoken()).toEqual(["Still checking."]);
    // 8000 from the call, so 5000 more — NOT 8000 more.
    await vi.advanceTimersByTimeAsync(4999);
    expect(spoken()).toEqual(["Still checking."]);
    await vi.advanceTimersByTimeAsync(1);
    expect(spoken()).toEqual(["Still checking.", "Almost there."]);
  });

  test("every rung is filler", async () => {
    const { controller, sent } = harness();
    controller.begin(ladder, "lookup", {}, undefined);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sent.every((s) => s.record === false)).toBe(true);
  });

  test("the ladder stops the moment the call settles", async () => {
    const { controller, spoken } = harness();
    const call = controller.begin(ladder, "lookup", {}, undefined);
    await vi.advanceTimersByTimeAsync(3000);
    call?.settled("{}");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(spoken()).toEqual(["Still checking."]);
  });

  test("an aborted turn silences the rest of the ladder", async () => {
    const abort = new AbortController();
    const { controller, spoken } = harness();
    controller.begin(ladder, "lookup", {}, abort.signal);
    await vi.advanceTimersByTimeAsync(3000);
    abort.abort();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(spoken()).toEqual(["Still checking."]);
  });

  test("a rung the call's arguments rule out never fires", async () => {
    const { controller, spoken } = harness();
    controller.begin(
      {
        delayed: [
          { afterMs: 3000, content: "Refunding.", when: [{ arg: "act", value: "refund" }] },
        ],
      },
      "orders",
      { act: "lookup" },
      undefined,
    );
    await vi.advanceTimersByTimeAsync(60_000);
    expect(spoken()).toEqual([]);
  });
});

describe("`covering()` — what makes the generic dead-air cover stand down", () => {
  test("true while a call with its own filler is in flight", () => {
    const { controller } = harness();
    expect(controller.covering()).toBe(false);
    const call = controller.begin({ start: [{ content: "One sec." }] }, "lookup", {}, undefined);
    expect(controller.covering()).toBe(true);
    call?.dispose();
    expect(controller.covering()).toBe(false);
  });

  test("FALSE for a tool that only declares an outcome", () => {
    // That call is as silent as any other while it runs, so the generic cover
    // is exactly what it needs. Suppressing on the mere presence of `messages`
    // would leave those tools uncovered.
    const { controller } = harness();
    controller.begin({ complete: [{ content: "Done." }] }, "lookup", {}, undefined);
    expect(controller.covering()).toBe(false);
  });

  test("two overlapping calls both have to finish before the cover comes back", () => {
    const { controller } = harness();
    const a = controller.begin({ start: [{ content: "One sec." }] }, "a", {}, undefined);
    const b = controller.begin({ start: [{ content: "One sec." }] }, "b", {}, undefined);
    a?.dispose();
    expect(controller.covering()).toBe(true);
    b?.dispose();
    expect(controller.covering()).toBe(false);
  });

  test("dispose is idempotent — a settle then a dispose does not double-count", () => {
    const { controller } = harness();
    const call = controller.begin({ start: [{ content: "One sec." }] }, "a", {}, undefined);
    call?.settled("{}");
    call?.dispose();
    expect(controller.covering()).toBe(false);
  });
});

describe("the COMPLETE/FAILED role switch", () => {
  test("`assistant` speaks verbatim, records, and latches the model out", () => {
    const { controller, sent, recorded } = harness();
    const call = controller.begin(
      { complete: [{ role: "assistant", content: "Your order ships Tuesday." }] },
      "lookup",
      {},
      undefined,
    );
    const forModel = call?.settled('{"status":"shipped"}');
    expect(sent).toEqual([{ text: "Your order ships Tuesday.", record: true }]);
    // Recorded, unlike every other line here: this IS the agent's answer, so
    // it belongs in the transcript and in history.
    expect(recorded).toEqual(["Your order ships Tuesday."]);
    expect(controller.verbatim()).toBe("Your order ships Tuesday.");
    // The MODEL's copy of the result is untouched — the arm that skips it does
    // not also rewrite what the step recorded.
    expect(forModel).toBe('{"status":"shipped"}');
  });

  test("`system` speaks NOTHING and annotates the result the model reads", () => {
    const { controller, sent } = harness();
    const call = controller.begin(
      { complete: [{ role: "system", content: "Confirm the ship date warmly." }] },
      "lookup",
      {},
      undefined,
    );
    const forModel = call?.settled('{"status":"shipped"}');
    expect(sent).toEqual([]);
    expect(controller.verbatim()).toBeUndefined();
    expect(forModel).toBe(
      `{"status":"shipped"}\n\n${TOOL_SYSTEM_HINT_LABEL} Confirm the ship date warmly.`,
    );
  });

  test("the default role is `assistant`", () => {
    const { controller, sent } = harness();
    controller.begin({ complete: [{ content: "Done." }] }, "t", {}, undefined)?.settled("{}");
    expect(sent).toEqual([{ text: "Done.", record: true }]);
  });

  test("a serialized failure takes the FAILED arm", () => {
    const { controller, sent } = harness();
    const messages: ToolMessages = {
      complete: [{ content: "All set." }],
      failed: [{ content: "I couldn't reach the order system." }],
    };
    controller
      .begin(messages, "lookup", {}, undefined)
      ?.settled(serializeToolFailure("upstream 503"));
    expect(sent).toEqual([{ text: "I couldn't reach the order system.", record: true }]);
  });

  test("a result that merely CONTAINS the word error is not a failure", () => {
    const { controller, sent } = harness();
    const messages: ToolMessages = {
      complete: [{ content: "All set." }],
      failed: [{ content: "Sorry." }],
    };
    controller.begin(messages, "lookup", {}, undefined)?.settled('{"note":"no error found"}');
    expect(sent).toEqual([{ text: "All set.", record: true }]);
  });

  test("conditions choose the line from the call's ARGUMENTS", () => {
    const messages: ToolMessages = {
      complete: [
        { content: "Refund issued.", when: [{ arg: "action", value: "refund" }] },
        { content: "Here's your order.", when: [{ arg: "action", value: "lookup" }] },
      ],
    };
    const refund = harness();
    refund.controller.begin(messages, "orders", { action: "refund" }, undefined)?.settled("{}");
    expect(refund.spoken()).toEqual(["Refund issued."]);

    const lookup = harness();
    lookup.controller.begin(messages, "orders", { action: "lookup" }, undefined)?.settled("{}");
    expect(lookup.spoken()).toEqual(["Here's your order."]);
  });

  test("the SECOND verbatim completion in one turn stays quiet", () => {
    // Two tools in one step settle concurrently. The reply is already spoken;
    // a second one would talk over it and the step loop stops either way.
    const { controller, spoken } = harness();
    const messages: ToolMessages = { complete: [{ role: "assistant", content: "First." }] };
    controller.begin(messages, "a", {}, undefined)?.settled("{}");
    controller
      .begin({ complete: [{ role: "assistant", content: "Second." }] }, "b", {}, undefined)
      ?.settled("{}");
    expect(spoken()).toEqual(["First."]);
    expect(controller.verbatim()).toBe("First.");
  });

  test("an aborted turn speaks no completion and latches nothing", () => {
    const abort = new AbortController();
    abort.abort();
    const { controller, spoken } = harness();
    controller
      .begin({ complete: [{ role: "assistant", content: "Done." }] }, "a", {}, abort.signal)
      ?.settled("{}");
    expect(spoken()).toEqual([]);
    expect(controller.verbatim()).toBeUndefined();
  });

  test("`beginTurn` clears the latch so the next turn can call the model", () => {
    const { controller } = harness();
    controller.begin({ complete: [{ content: "Done." }] }, "a", {}, undefined)?.settled("{}");
    expect(controller.verbatim()).toBe("Done.");
    controller.beginTurn();
    expect(controller.verbatim()).toBeUndefined();
  });
});

describe("binding", () => {
  test("with no channel bound, nothing is spoken and nothing throws", async () => {
    const controller = createToolSpeechController({ log: silentLogger, sid: "s" });
    const call = controller.begin(
      { start: [{ content: "One sec." }], complete: [{ content: "Done." }] },
      "t",
      {},
      undefined,
    );
    await call?.start();
    expect(call?.settled("{}")).toBe("{}");
    expect(controller.verbatim()).toBeUndefined();
  });

  test("a tool call outliving its turn finds the controller unbound", () => {
    const { controller, spoken } = harness();
    const call = controller.begin({ complete: [{ content: "Done." }] }, "t", {}, undefined);
    // What `consumeLlmStream` does in its `finally`.
    controller.bind({
      send: () => undefined,
      boundary: () => undefined,
      record: () => undefined,
      callerSpeaking: () => false,
      awaitSpoken: () => Promise.resolve(),
    })();
    call?.settled("{}");
    expect(spoken()).toEqual([]);
  });

  test("a tool with no declared messages gets no handle at all", () => {
    const { controller } = harness();
    expect(controller.begin(undefined, "t", {}, undefined)).toBeUndefined();
  });

  test("every line the caller hears is LOGGED", () => {
    // The dead-air cover's lesson: these reach no transcript, so without a log
    // line a harness trajectory shows a covered gap and an uncovered one
    // identically.
    const log = makeLogger();
    const { controller } = harness({ log });
    controller.begin({ complete: [{ content: "Done." }] }, "t", {}, undefined)?.settled("{}");
    expect(log.info).toHaveBeenCalledWith(
      "Tool message",
      expect.objectContaining({ kind: "verbatim", tool: "t" }),
    );
  });
});
