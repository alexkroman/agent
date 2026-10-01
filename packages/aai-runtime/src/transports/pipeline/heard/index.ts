// Copyright 2026 the AAI authors. MIT license.
/**
 * What the caller actually HEARD: the heard cursor (`tracker.ts`), its word
 * alignment and playback clock, and the false-interruption recovery latch that
 * reads it. A LEAF stage — it imports no other stage.
 */

export type { FalseInterruptionRecovery } from "./recovery.ts";
export { createFalseInterruptionRecovery } from "./recovery.ts";
export type { HeardPosition, HeardTracker } from "./tracker.ts";
export { createHeardTracker } from "./tracker.ts";
