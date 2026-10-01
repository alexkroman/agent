// Copyright 2026 the AAI authors. MIT license.
/**
 * The path from text to the caller's ear: the TTS coalescer and flush
 * (`tts.ts`), the guardrail hold on that funnel, the speak gate, and the audio
 * and word-timing handlers (`audio-out.ts`). May import `heard/` and `turn/`.
 */

export { createAudioOut } from "./audio-out.ts";
export type { SpeechGate, TurnGuardrails } from "./guardrails.ts";
export { createTurnGuardrails, NO_GUARDRAILS } from "./guardrails.ts";
export { createTtsTextCoalescer, flushTtsAndWait, toModelMessage } from "./tts.ts";
