// Copyright 2026 the AAI authors. MIT license.
/**
 * The wire schemas for the three `PipelineTuning` groups (`agent-tuning.ts`).
 *
 * Serializable for the reason every other declaration in `AgentConfigSchema`
 * is: the runtime that reads them may be in a guest sandbox, so they have to
 * survive CLI → server → runtime.
 *
 * `.strict()`, unlike the top-level object: the stray-field check
 * (`_stray-fields.ts`) only sees top-level keys, so without it a misspelled
 * `interruption: { minWord: 1 }` would be STRIPPED by Zod and deploy an agent
 * running the default it was declared to change — the failure the stray-field
 * check exists to refuse, one level down.
 *
 * An `_`-internal module: split out of `agent-config.ts` at its length cap.
 */

import { z } from "zod";
import {
  MAX_INTERRUPTION_BACKOFF_MS,
  MAX_START_SPEAKING_FLOOR_MS,
} from "./speak-gate-constants.ts";

/**
 * A cap on one user turn, by words and/or elapsed time. REFINED rather than
 * left as two optionals: `{}` is a limit on nothing, and a control that is
 * accepted and never fires is the failure this whole layer exists to refuse.
 */
const UserTurnLimitSchema = z
  .object({
    maxWords: z.number().int().positive().optional(),
    maxDurationMs: z.number().int().positive().optional(),
  })
  .refine((limit) => limit.maxWords !== undefined || limit.maxDurationMs !== undefined, {
    message: "userTurnLimit must set maxWords, maxDurationMs, or both",
  });

/** @internal */
export const TurnTakingSchema = z
  .object({
    // Lowered onto the default STT descriptor by `agent()`, so a config that
    // went through it never carries them; accepted here so the schema's type
    // stays the authoring type's.
    minSilenceMs: z.number().int().nonnegative().optional(),
    maxSilenceMs: z.number().int().nonnegative().optional(),
    // Who ends the caller's turn: an OPEN string, so a config naming a mode a
    // later SDK implements still deploys here; the runtime treats anything but
    // "manual" as "auto", and `agentConfigWarnings` says so at build time.
    detection: z.string().min(1).optional(),
    userTurnLimit: UserTurnLimitSchema.optional(),
    preemptiveGeneration: z.boolean().optional(),
    startSpeakingFloorMs: z
      .number()
      .int()
      .nonnegative()
      .max(MAX_START_SPEAKING_FLOOR_MS)
      .optional(),
  })
  .strict();

/** @internal */
export const InterruptionSchema = z.union([
  z.literal("off"),
  z
    .object({
      minWords: z.number().int().min(1).optional(),
      minDurationMs: z.number().int().nonnegative().optional(),
      backoffMs: z.number().int().nonnegative().max(MAX_INTERRUPTION_BACKOFF_MS).optional(),
      resumeFalseInterruption: z.boolean().optional(),
    })
    .strict(),
]);

/** @internal */
export const SilenceSchema = z
  .object({
    deadAirCoverMs: z.number().int().nonnegative().optional(),
    nudge: z
      .object({ afterMs: z.number().positive(), prompt: z.string().optional() })
      .strict()
      .optional(),
  })
  .strict();
