// Copyright 2025 the AAI authors. MIT license.
import { expectTypeOf, test } from "vitest";
import type {
  LlmProvider,
  SttEvents,
  SttOpener,
  SttProvider,
  SttSession,
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

test("SttEvents.partial takes a string", () => {
  expectTypeOf<SttEvents["partial"]>().parameters.toEqualTypeOf<[string]>();
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
