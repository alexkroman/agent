// Copyright 2026 the AAI authors. MIT license.
// Shared test harness for the pipeline-transport specs (split across
// pipeline-transport.test.ts and pipeline-turn.test.ts).

import { vi } from "vitest";
import {
  createFakeLanguageModel,
  createFakeSttProvider,
  createFakeTtsProvider,
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
    ...overrides,
  };
  return { opts, stt, tts, callbacks };
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
