// Copyright 2025 the AAI authors. MIT license.
import type { LanguageModel } from "ai";
import { expectTypeOf, test } from "vitest";
import type { LlmProvider } from "./llm.ts";
import type { SttEvents, SttProvider, SttSession, Unsubscribe } from "./stt.ts";
import type { TtsEvents, TtsSession } from "./tts.ts";

test("SttProvider.open returns Promise<SttSession>", () => {
  expectTypeOf<SttProvider["open"]>().returns.toEqualTypeOf<Promise<SttSession>>();
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

test("LlmProvider is Vercel AI SDK's LanguageModel", () => {
  expectTypeOf<LlmProvider>().toEqualTypeOf<LanguageModel>();
});

test("Sstt/Tts on() returns Unsubscribe", () => {
  expectTypeOf<SttSession["on"]>().returns.toEqualTypeOf<Unsubscribe>();
  expectTypeOf<TtsSession["on"]>().returns.toEqualTypeOf<Unsubscribe>();
});
