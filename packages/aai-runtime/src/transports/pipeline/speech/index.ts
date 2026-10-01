// Copyright 2026 the AAI authors. MIT license.
/**
 * The CALLER's side of the pipeline: STT events in, a committed user turn out —
 * speaking edges, the barge-in policy, push-to-talk, the silence nudger, the
 * user-turn cap, transcript word helpers, and preemptive generation started from
 * an interim (`speculation.ts`). May import `heard/`, `history/` and `llm/` (the
 * last only for speculation). No other stage imports this one; only the
 * assembly beside `../index.ts` does.
 */

export type { ManualTurn } from "./manual-turn.ts";
export type { SpeculationController } from "./speculation.ts";
export { createPipelineSpeculation } from "./speculation.ts";
export { hasMinWords } from "./text.ts";
export type { UserActivity } from "./user-speech.ts";
export { createUserActivity } from "./user-speech.ts";
export { createForceEndOfTurn } from "./user-turn-limit.ts";
