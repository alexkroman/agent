// Copyright 2026 the AAI authors. MIT license.
/**
 * One turn's primitives: the invalidation gate and turn chain (`gate.ts`),
 * the turn state machine (`state.ts`) and the per-reply metrics frame
 * (`metrics.ts`). A LEAF stage — it imports no other stage, and every other
 * stage may import it.
 */

export type { TurnChain, TurnGate } from "./gate.ts";
export { createTurnChain, createTurnGate, turnCrashLogger } from "./gate.ts";
export type { LlmTiming, TurnMetrics } from "./metrics.ts";
export { createTurnMetrics, withSttMarks } from "./metrics.ts";
export type { TurnMachine } from "./state.ts";
export { createTurnMachine } from "./state.ts";
