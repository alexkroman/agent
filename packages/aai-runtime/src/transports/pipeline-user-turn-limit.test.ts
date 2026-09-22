// Copyright 2026 the AAI authors. MIT license.
// The cap on one user turn — `AgentDef.userTurnLimit`. Two halves: the
// limiter's own rules (which cap fires, once per utterance, cleared with the
// edge), exercised directly the way `createSpeechEdgeTracker`'s are in
// pipeline-user-speech.test.ts; and the wiring through the transport, asserted
// the way every transport spec is — on what was REPORTED and what the STT
// provider was ASKED, never on an internal flag. Shared helpers in
// _pipeline-transport-harness.ts.

import { describe, expect, test, vi } from "vitest";
import { createFakeLanguageModel } from "../_pipeline-test-fakes.ts";
import { silentLogger } from "../_test-utils.ts";
import { makeOpts, useVirtualTime } from "./_pipeline-transport-harness.ts";
import { createPipelineTransport } from "./pipeline-transport.ts";
import {
  createUserTurnLimiter,
  NO_USER_TURN_LIMIT,
  type UserTurnLimitKind,
} from "./pipeline-user-turn-limit.ts";

useVirtualTime();

/**
 * Keep the caller talking for `ms`: a growing partial every 500 ms, the way a
 * real transcriber streams one. An utterance that goes quiet for the speaking
 * edge's idle watchdog (4 s by default) is CLOSED as a false interruption, and
 * with it the cap's deadline — which is right, and is why a spec about the
 * duration cap cannot fire one partial and wait.
 */
async function talk(
  stt: { last: () => { firePartial: (text: string) => void } | undefined },
  ms: number,
  text: (i: number) => string,
): Promise<void> {
  for (let i = 1; i * 500 <= ms; i++) {
    await vi.advanceTimersByTimeAsync(500);
    stt.last()?.firePartial(text(i));
  }
}

function makeLimiter(limit: { maxWords?: number; maxDurationMs?: number } | undefined): {
  limiter: ReturnType<typeof createUserTurnLimiter>;
  fired: { limit: UserTurnLimitKind; words: number; durationMs: number }[];
  clock: { durationMs: number };
} {
  const fired: { limit: UserTurnLimitKind; words: number; durationMs: number }[] = [];
  const clock = { durationMs: 0 };
  const limiter = createUserTurnLimiter(limit, {
    durationMs: () => clock.durationMs,
    onExceeded: (kind, words, durationMs) => fired.push({ limit: kind, words, durationMs }),
  });
  return { limiter, fired, clock };
}

describe("createUserTurnLimiter", () => {
  test("no limit, or a limit naming no cap, is the shared no-op — the shipped default", () => {
    // Identity, not equivalence: the partial handler's hot path pays a no-op
    // call and nothing else, and `maxWords: 0` keeps the bounded scan bounded.
    expect(createUserTurnLimiter(undefined, { durationMs: () => 0, onExceeded: vi.fn() })).toBe(
      NO_USER_TURN_LIMIT,
    );
    expect(createUserTurnLimiter({}, { durationMs: () => 0, onExceeded: vi.fn() })).toBe(
      NO_USER_TURN_LIMIT,
    );
    expect(NO_USER_TURN_LIMIT.maxWords).toBe(0);
  });

  test("the word cap fires on the first partial at or over it, once per utterance", () => {
    const { limiter, fired, clock } = makeLimiter({ maxWords: 3 });
    expect(limiter.maxWords).toBe(3);

    limiter.onUtteranceStarted();
    limiter.onPartial("one two", 2);
    expect(fired).toEqual([]);
    clock.durationMs = 900;
    limiter.onPartial("one two three", 3);
    expect(fired).toEqual([{ limit: "words", words: 3, durationMs: 900 }]);
    // The provider's final follows within its own latency; every partial
    // until then is still over the cap and must not fire again.
    limiter.onPartial("one two three four", 3);
    limiter.onPartial("one two three four five", 3);
    expect(fired).toHaveLength(1);

    // The next utterance is a fresh cap.
    limiter.onUtteranceEnded();
    limiter.onUtteranceStarted();
    limiter.onPartial("six seven eight", 3);
    expect(fired).toHaveLength(2);
  });

  test("the duration cap fires when the open utterance has run that long", async () => {
    const { limiter, fired, clock } = makeLimiter({ maxDurationMs: 20_000 });
    expect(limiter.maxWords).toBe(0);

    limiter.onUtteranceStarted();
    limiter.onPartial("still talking", 2);
    await vi.advanceTimersByTimeAsync(19_999);
    expect(fired).toEqual([]);
    clock.durationMs = 20_000;
    limiter.onPartial("still talking and talking", 2);
    await vi.advanceTimersByTimeAsync(1);
    // An EXACT count for the record, not the partial handler's bounded one.
    expect(fired).toEqual([{ limit: "duration", words: 4, durationMs: 20_000 }]);
  });

  test("continued speech does not push the deadline out — it is not the idle watchdog", async () => {
    const { limiter, fired } = makeLimiter({ maxDurationMs: 1000 });
    limiter.onUtteranceStarted();
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(150);
      limiter.onPartial("word ".repeat(i + 1), i + 1);
    }
    expect(fired).toHaveLength(1);
    expect(fired[0]?.limit).toBe("duration");
  });

  test("closing the edge clears the deadline, so a committed turn never fires it late", async () => {
    const { limiter, fired } = makeLimiter({ maxDurationMs: 1000 });
    limiter.onUtteranceStarted();
    limiter.onPartial("hello", 1);
    limiter.onUtteranceEnded();
    await vi.advanceTimersByTimeAsync(5000);
    expect(fired).toEqual([]);
  });

  test("with both caps, whichever the caller reaches first fires, and only that one", async () => {
    const { limiter, fired } = makeLimiter({ maxWords: 3, maxDurationMs: 1000 });
    limiter.onUtteranceStarted();
    limiter.onPartial("one two three", 3);
    await vi.advanceTimersByTimeAsync(2000);
    expect(fired).toHaveLength(1);
    expect(fired[0]?.limit).toBe("words");
  });
});

describe("PipelineTransport — userTurnLimit", () => {
  test("no limit by default: a long utterance is never cut and nothing is reported", async () => {
    const { opts, stt, callbacks } = makeOpts({
      llm: createFakeLanguageModel({ script: [{ type: "text", text: "ok" }] }),
    });
    const t = createPipelineTransport(opts);
    await t.start();

    stt.last()?.firePartial("word ".repeat(500).trim());
    await vi.advanceTimersByTimeAsync(600_000);
    expect(stt.last()?.forceEndOfTurn).not.toHaveBeenCalled();
    expect(callbacks.reported("user-turn.exceeded")).not.toHaveBeenCalled();
    await t.stop();
  });

  test("the word cap reports user-turn.exceeded and asks the transcriber to end the turn", async () => {
    const { opts, stt, callbacks } = makeOpts({
      llm: createFakeLanguageModel({ script: [{ type: "text", text: "ok" }] }),
      userTurnLimit: { maxWords: 4 },
    });
    const t = createPipelineTransport(opts);
    await t.start();

    stt.last()?.firePartial("I would");
    stt.last()?.firePartial("I would like to");
    expect(callbacks.reported("user-turn.exceeded")).toHaveBeenCalledTimes(1);
    expect(callbacks.reported("user-turn.exceeded")).toHaveBeenCalledWith(
      expect.objectContaining({ type: "user-turn.exceeded", limit: "words", words: 4 }),
    );
    expect(stt.last()?.forceEndOfTurn).toHaveBeenCalledTimes(1);

    // The provider answers the cut with its final; the turn commits on the
    // ordinary path, and the cap does not fire again on the way there.
    stt.last()?.firePartial("I would like to ask");
    stt.last()?.fireFinal("I would like to ask");
    await vi.waitFor(() => {
      expect(callbacks.reported("user-transcript.committed")).toHaveBeenCalledWith({
        type: "user-transcript.committed",
        text: "I would like to ask",
      });
    });
    expect(callbacks.reported("user-turn.exceeded")).toHaveBeenCalledTimes(1);
    expect(stt.last()?.forceEndOfTurn).toHaveBeenCalledTimes(1);

    // The record precedes the turn it cut.
    const order = callbacks.events
      .map((event) => event.type)
      .filter((type) => type === "user-turn.exceeded" || type === "user-transcript.committed");
    expect(order).toEqual(["user-turn.exceeded", "user-transcript.committed"]);
    await t.stop();
  });

  test("the duration cap fires on the clock from the utterance's first word", async () => {
    const { opts, stt, callbacks } = makeOpts({
      llm: createFakeLanguageModel({ script: [{ type: "text", text: "ok" }] }),
      userTurnLimit: { maxDurationMs: 20_000 },
    });
    const t = createPipelineTransport(opts);
    await t.start();

    stt.last()?.firePartial("so");
    await talk(stt, 19_500, (i) => `so ${"anyway ".repeat(i).trim()}`);
    expect(callbacks.reported("user-turn.exceeded")).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    expect(callbacks.reported("user-turn.exceeded")).toHaveBeenCalledWith(
      // 39 partials of "so anyway…", the last carrying "so" + 39 words.
      expect.objectContaining({ limit: "duration", words: 40, durationMs: 20_000 }),
    );
    expect(stt.last()?.forceEndOfTurn).toHaveBeenCalledTimes(1);
    await t.stop();
  });

  test("a turn that ends on its own clears the deadline for the next one", async () => {
    const { opts, stt, callbacks } = makeOpts({
      llm: createFakeLanguageModel({ script: [{ type: "text", text: "ok" }] }),
      userTurnLimit: { maxDurationMs: 5000 },
    });
    const t = createPipelineTransport(opts);
    await t.start();

    stt.last()?.firePartial("short");
    await talk(stt, 4000, () => "short one");
    stt.last()?.fireFinal("short one");
    await vi.waitFor(() => {
      expect(callbacks.reported("user-transcript.committed")).toHaveBeenCalled();
    });
    await vi.advanceTimersByTimeAsync(4000);
    expect(callbacks.reported("user-turn.exceeded")).not.toHaveBeenCalled();

    // The next utterance starts its own clock.
    stt.last()?.firePartial("and");
    await talk(stt, 5000, (i) => `and now ${"a longer one ".repeat(i).trim()}`);
    expect(callbacks.reported("user-turn.exceeded")).toHaveBeenCalledTimes(1);
    expect(callbacks.reported("user-turn.exceeded")).toHaveBeenCalledWith(
      expect.objectContaining({ limit: "duration", durationMs: 5000 }),
    );
    await t.stop();
  });

  test("a provider that cannot end a turn on demand leaves the cap inert, said once", async () => {
    const warn = vi.fn();
    const { opts, stt, callbacks } = makeOpts({
      llm: createFakeLanguageModel({ script: [{ type: "text", text: "ok" }] }),
      userTurnLimit: { maxWords: 2 },
      logger: { ...silentLogger, warn },
    });
    const t = createPipelineTransport(opts);
    await t.start();
    const session = stt.last();
    if (session === undefined) throw new Error("no STT session");
    // The capability is OPTIONAL on `SttSession` — this is a provider without it.
    (session as { forceEndOfTurn?: unknown }).forceEndOfTurn = undefined;

    session.firePartial("one two");
    session.fireFinal("one two");
    await vi.waitFor(() => {
      expect(callbacks.reported("user-transcript.committed")).toHaveBeenCalled();
    });
    session.firePartial("three four");
    // Reported both times — the record is the provider-independent half.
    expect(callbacks.reported("user-turn.exceeded")).toHaveBeenCalledTimes(2);
    // Said ONCE per session, not per utterance.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatch(/cannot end a turn on demand/);
    await t.stop();
  });
});
