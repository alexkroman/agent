// Copyright 2026 the AAI authors. MIT license.
// Shared test harness for the pipeline-transport specs (split across
// pipeline-transport.test.ts and pipeline-turn.test.ts).

import { afterEach, beforeEach, vi } from "vitest";
import {
  createFakeLanguageModel,
  createFakeSttProvider,
  createFakeTtsProvider,
  type ScriptedPart,
} from "../_pipeline-test-fakes.ts";
import { silentLogger } from "../runtime-config.ts";
import { makeCallbacks, type RecordingCallbacks } from "./_transport-recorder.ts";
import type { PipelineTransportOptions } from "./pipeline-transport.ts";

export type SttFake = ReturnType<typeof createFakeSttProvider>;
export type TtsFake = ReturnType<typeof createFakeTtsProvider>;

/**
 * The recorded calls of a {@link createFakeLanguageModel} passed through
 * `makeOpts`. `PipelineTransportOptions.llm` is the plain `LanguageModel`
 * type, which drops the fake's `calls` array — recovering it needs a cast, so
 * keep it at this one seam; the escape-hatch ratchet counts every occurrence.
 */
export function llmCalls(opts: PipelineTransportOptions): {
  calls: Array<{ prompt?: unknown }>;
} {
  return opts.llm as unknown as { calls: Array<{ prompt?: unknown }> };
}

export function makeOpts(
  overrides: Partial<PipelineTransportOptions> = {},
  {
    stt = createFakeSttProvider(),
    tts = createFakeTtsProvider(),
    callbacks = makeCallbacks(),
  }: { stt?: SttFake; tts?: TtsFake; callbacks?: RecordingCallbacks } = {},
): {
  opts: PipelineTransportOptions;
  stt: SttFake;
  tts: TtsFake;
  callbacks: RecordingCallbacks;
} {
  const opts: PipelineTransportOptions = {
    sid: "test-sid",
    stt,
    llm: createFakeLanguageModel({ script: [] }),
    tts,
    callbacks,
    sessionConfig: { systemPrompt: "s", greeting: "" },
    executeTool: async () => {
      throw new Error("No executeTool provided to test harness");
    },
    providerKeys: { stt: "stt-key", tts: "tts-key" },
    logger: silentLogger,
    // Disable the barge-in duration gate by default: a spec that fires one
    // partial and asserts the reply was cancelled is testing the cancel path,
    // not the gate, and the real default would make every such spec wait out
    // 500 ms of "sustained speech" it never simulates. The gate's own specs set
    // it explicitly, and `pipeline-transport-options.test.ts` pins the shipped
    // default so this override cannot hide a bad one.
    interruptionMinDurationMs: 0,
    ...overrides,
  };
  return { opts, stt, tts, callbacks };
}

/**
 * A scripted reply that cannot finish on its own while a spec asserts on
 * in-flight state (barge-in, `cancelReply()`, the `minBargeInWords` gates).
 *
 * Those specs `vi.waitFor` the *first* TTS chunk and then assert that the turn
 * is still interruptible. A short script (3 parts × 20 ms ≈ 60 ms) can run to
 * completion in the gap between those two lines when the machine is loaded —
 * e.g. under `pnpm test`, where 8 turbo tasks compete for CPU — leaving no
 * in-flight turn to cancel and failing the assertion. Padding the script to
 * ~2 s of stream removes the race without slowing the specs down: every one of
 * them aborts the stream (barge-in, `cancelReply()`, or `stop()`), and
 * `streamScript` checks its abort signal between parts, so the untold parts are
 * never waited on.
 */
export function inFlightReplyScript(): ScriptedPart[] {
  return Array.from({ length: 100 }, (_, i) => ({ type: "text", text: `chunk${i} ` }));
}

export function firstCallArg<T>(fn: unknown): T {
  // biome-ignore lint/style/noNonNullAssertion: caller asserts the spy was invoked
  return (fn as ReturnType<typeof vi.fn>).mock.calls[0]![0] as T;
}

export const noopToolSchema = {
  type: "function" as const,
  name: "lookup",
  description: "Look something up.",
  parameters: { type: "object" as const, properties: {}, required: [] },
};

/**
 * Run this file's specs on VIRTUAL time.
 *
 * The pipeline transports are a pile of timers — the endpoint settler, the
 * silence countdown, the dead-air cover, the speaking-edge watchdog — and
 * their specs used to observe those timers by waiting out real wall-clock
 * milliseconds (`await sleep(60)`). Three costs, in rising order of how much
 * they matter:
 *
 * - ~2.3s of the unit run spent asleep.
 * - Every window had to be squeezed to tens of milliseconds to keep that
 *   bearable, which puts the effect under test the same size as a scheduling
 *   hiccup. A spec cannot then describe the SHIPPED window (a 5s dead-air
 *   cover, a 300s idle timeout) at all.
 * - These are races, so a contended runner fails them FIRST — the flake lands
 *   on whoever is merging, and it names a timing spec rather than a bug.
 *
 * `vi.useFakeTimers()` reaches all of it, including the fakes: `_fake-llm.ts`
 * spaces its scripted parts with the same GLOBAL `setTimeout` that fake timers
 * replace, which is why no scheduler had to be threaded through
 * `PipelineTransportOptions` to make this work. `vi.waitFor` composes too — it
 * advances the fake clock while it polls.
 *
 * Call at file scope, then drive with `vi.advanceTimersByTimeAsync(ms)`.
 */
export function useVirtualTime(): void {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });
}
