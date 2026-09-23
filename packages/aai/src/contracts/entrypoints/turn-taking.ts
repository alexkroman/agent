// Copyright 2026 the AAI authors. MIT license.
/**
 * Capability contract: `turn-taking`.
 *
 * WHEN each side may speak in a pipeline session: barge-in thresholds, the
 * interruption and dead-air windows, preemptive generation, the cap on one user
 * turn ({@link UserTurnLimit}) and whether the turn ends on silence or on the
 * client's say-so (`turnDetection`).
 *
 * Split out of `agent` because these fields move for a different reason than
 * the rest of an agent declaration. `PipelineVoiceTuning` is a FIELD GROUP that
 * `AgentDef` extends, and every one of its fields is optional, so while it sat
 * on `agent` every turn-taking knob added or retuned renumbered the flagship
 * capability that every template imports — the same "unrelated optional field"
 * cost that made `agent` the most-bumped contract in the tree. `agent` still
 * names `PipelineVoiceTuning` (its report records that `AgentDef` extends it), so
 * adding the group or dropping it is still visible there; what moves the group's
 * CONTENTS is this capability alone.
 *
 * The endpointing SHORTHANDS an agent declares (`minTurnSilenceMs`,
 * `maxTurnSilenceMs`) are fields of the parameter unions and stay with `agent`,
 * whose misuse diagnostics reject them next to an explicit `stt`; the provider
 * defaults are `stt`'s.
 *
 * Re-exported from `@alexkroman1/aai`. This file is not shipped and nothing
 * imports it — it exists so `pnpm check:api-contracts` can extract a report
 * for this capability alone, hash it, and hold it to a committed epoch. See
 * `scripts/api-contracts.mjs`.
 */

export type { PipelineVoiceTuning, UserTurnLimit } from "../../index.ts";
