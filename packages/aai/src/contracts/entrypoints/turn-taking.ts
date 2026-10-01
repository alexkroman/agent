// Copyright 2026 the AAI authors. MIT license.
/**
 * Capability contract: `turn-taking`.
 *
 * WHEN each side may speak in a pipeline session — the three groups of
 * {@link PipelineTuning}: `turnTaking` (the end-of-turn window, who ends the
 * caller's turn, the cap on one user turn, preemptive generation, the
 * start-speaking floor), `interruption` (the barge-in gates, the backoff,
 * false-interruption recovery) and `silence` (dead-air cover and the silence
 * nudge), plus the two phrases the pipeline speaks when a stage fails.
 *
 * Split out of `agent` because these fields move for a different reason than
 * the rest of an agent declaration: every one is optional, so while they sat
 * on `agent` every knob added or retuned renumbered the flagship capability
 * that every template imports. `agent` still names `PipelineTuning` (its
 * report records that `AgentDef` extends it), so adding or dropping a group is
 * visible there; what moves the groups' CONTENTS is this capability alone.
 * The per-state `interruption` a dialog or a persona declares is this same
 * type, so `dialog` and `persona` name it too.
 *
 * Re-exported from `@alexkroman1/aai`. This file is not shipped and nothing
 * imports it — it exists so `pnpm check:api-contracts` can extract a report
 * for this capability alone, hash it, and hold it to a committed epoch. See
 * `scripts/api-contracts.mjs`.
 */

export type {
  InterruptionTuning,
  PipelinePhrases,
  PipelineTuning,
  SilenceNudge,
  SilenceTuning,
  TurnTakingTuning,
  UserTurnLimit,
} from "../../index.ts";
