// Copyright 2025 the AAI authors. MIT license.

import type {
  SttEvents,
  SttOpener,
  SttSession,
  SttTurnMeta,
  TtsEvents,
  TtsSession,
  Unsubscribe,
} from "@alexkroman1/aai/host-internal";
import type { LlmProvider } from "@alexkroman1/aai/llm";
import type { SttProvider } from "@alexkroman1/aai/stt";
import type { TtsProvider } from "@alexkroman1/aai/tts";
import { expectTypeOf, test } from "vitest";

type Descriptor = { kind: string; options: Record<string, unknown> };

test("Descriptors are { kind, options } data", () => {
  expectTypeOf<SttProvider>().toMatchTypeOf<Descriptor>();
  expectTypeOf<LlmProvider>().toMatchTypeOf<Descriptor>();
  expectTypeOf<TtsProvider>().toMatchTypeOf<Descriptor>();
});

test("SttOpener.open returns Promise<SttSession>", () => {
  expectTypeOf<SttOpener["open"]>().returns.toEqualTypeOf<Promise<SttSession>>();
});

test("SttEvents.partial takes a string plus optional turn metadata", () => {
  // The meta arg is OPTIONAL so that a provider with no end-of-turn signal
  // (deepgramStt, elevenlabs, sonioxStt) keeps emitting `emit("partial", text)`
  // unchanged — adding a signal to one provider must not touch the others.
  expectTypeOf<SttEvents["partial"]>().parameters.toEqualTypeOf<
    [text: string, meta?: SttTurnMeta | undefined]
  >();
});

test("TtsSession.cancel is synchronous", () => {
  expectTypeOf<TtsSession["cancel"]>().returns.toEqualTypeOf<void>();
});

test("TtsEvents.audio takes Int16Array", () => {
  expectTypeOf<TtsEvents["audio"]>().parameters.toEqualTypeOf<[Int16Array]>();
});

test("Stt/Tts on() returns Unsubscribe", () => {
  expectTypeOf<SttSession["on"]>().returns.toEqualTypeOf<Unsubscribe>();
  expectTypeOf<TtsSession["on"]>().returns.toEqualTypeOf<Unsubscribe>();
});
