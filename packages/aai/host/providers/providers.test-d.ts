// Copyright 2025 the AAI authors. MIT license.
import { expectTypeOf, test } from "vitest";
import type {
  LlmProvider,
  SttEvents,
  SttOpener,
  SttProvider,
  SttSession,
  SttTurnMeta,
  TtsEvents,
  TtsProvider,
  TtsSession,
  Unsubscribe,
} from "../../sdk/providers.ts";

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
  // (deepgram, elevenlabs, soniox) keeps emitting `emit("partial", text)`
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
