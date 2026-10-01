// Copyright 2026 the AAI authors. MIT license.
/**
 * One model request: `streamText` assembly, the restartable drain, tool speech,
 * the per-turn trace, the word smoother and the speculative stream a speculation
 * drains into. May import `history/`, `output/`, `reply/` and `turn/`.
 */

export type { SpeculativeStream } from "./speculative-stream.ts";
export { startSpeculativeStream } from "./speculative-stream.ts";
export type { TurnLlmRunner } from "./stream.ts";
export { createTurnLlmRunner } from "./stream.ts";
export type { AdoptedLlmStream, SharedLlmRequest } from "./types.ts";
