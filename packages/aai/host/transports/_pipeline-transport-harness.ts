// Copyright 2026 the AAI authors. MIT license.
// Shared test harness for the pipeline-transport specs (split across
// pipeline-transport.test.ts and pipeline-turn.test.ts).

import { vi } from "vitest";
import {
  createFakeLanguageModel,
  createFakeSttProvider,
  createFakeTtsProvider,
  type ScriptedPart,
} from "../_pipeline-test-fakes.ts";
import type { Logger } from "../runtime-config.ts";
import type { PipelineTransportOptions } from "./pipeline-transport.ts";
import type { TransportCallbacks } from "./types.ts";

export type SttFake = ReturnType<typeof createFakeSttProvider>;
export type TtsFake = ReturnType<typeof createFakeTtsProvider>;

// Inline no-op logger (not imported from _test-utils, whose vitest-spy-typed
// export is excluded from the package build and isn't declaration-portable).
const noop = (): void => undefined;
const silentLogger: Logger = { info: noop, warn: noop, error: noop, debug: noop };

export function makeCallbacks(): TransportCallbacks {
  return {
    onReplyStarted: vi.fn(),
    onReplyDone: vi.fn(),
    onCancelled: vi.fn(),
    onAudioChunk: vi.fn(),
    onAudioDone: vi.fn(),
    onUserTranscript: vi.fn(),
    onUserTranscriptPartial: vi.fn(),
    onAgentTranscript: vi.fn(),
    onAgentTranscriptPartial: vi.fn(),
    onToolCall: vi.fn(),
    onError: vi.fn(),
    onSpeechStarted: vi.fn(),
    onSpeechStopped: vi.fn(),
    onSessionReady: vi.fn(),
  };
}

export function makeOpts(
  overrides: Partial<PipelineTransportOptions> = {},
  {
    stt = createFakeSttProvider(),
    tts = createFakeTtsProvider(),
    callbacks = makeCallbacks(),
  }: { stt?: SttFake; tts?: TtsFake; callbacks?: TransportCallbacks } = {},
): {
  opts: PipelineTransportOptions;
  stt: SttFake;
  tts: TtsFake;
  callbacks: TransportCallbacks;
} {
  const opts: PipelineTransportOptions = {
    sid: "test-sid",
    stt,
    llm: createFakeLanguageModel({ script: [] }),
    tts,
    callbacks,
    sessionConfig: { systemPrompt: "s", greeting: "" },
    providerKeys: { stt: "stt-key", tts: "tts-key" },
    logger: silentLogger,
    // Disable the endpoint settle window by default so specs that fire a single
    // final commit the turn immediately (the pre-endpointing behavior most
    // specs assume). Settle-window specs opt in via an explicit endpointSettleMs.
    endpointSettleMs: 0,
    // Same reasoning for the barge-in duration gate: a spec that fires one
    // partial and asserts the reply was cancelled is testing the cancel path,
    // not the gate, and the real default would make every one of them wait out
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

/**
 * The interim-transcript spy. `onAgentTranscriptPartial` is optional on
 * {@link TransportCallbacks} (S2S transports never call it) but {@link
 * makeCallbacks} always sets it, so this narrows once instead of asserting at
 * every call site.
 */
export function partialTranscriptSpy(
  callbacks: TransportCallbacks,
): ReturnType<typeof vi.fn<(text: string) => void>> {
  const fn = callbacks.onAgentTranscriptPartial;
  if (fn === undefined) throw new Error("harness callbacks are missing onAgentTranscriptPartial");
  return vi.mocked(fn);
}

export const noopToolSchema = {
  type: "function" as const,
  name: "lookup",
  description: "Look something up.",
  parameters: { type: "object" as const, properties: {}, required: [] },
};
