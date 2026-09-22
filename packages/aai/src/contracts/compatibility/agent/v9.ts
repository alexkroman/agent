// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:agent` epoch 9.
 *
 * ## Epoch 10 adds a CAP on the caller's turn, and nothing an epoch-9 author wrote moved
 *
 * Epoch 10 is `AgentDef.userTurnLimit` — `{ maxWords?, maxDurationMs? }`, the
 * bound on a caller who never pauses — with its type `UserTurnLimit`, both
 * through `PipelineVoiceTuning`; and, as rollup collateral, `SessionEventType`
 * gaining `"user-turn.exceeded"`, the event each cut leaves behind. The field
 * is optional and the event is one more member of a union a handler map is
 * keyed by, so an epoch-9 declaration compiles unchanged: this file is the
 * evidence. If a later epoch makes the cap the default, makes the field
 * required, or removes an event name an epoch-9 `events` map is keyed on, this
 * file reddens — the signal to DROP the epoch rather than to edit the example.
 *
 * ## What epoch 9 itself was, and what this file has to name
 *
 * Epoch 9 is the surface AFTER the regex-keyed endpointing table, the two
 * barge-in phrase lists and the `smartMatching` preset were removed (epoch 8's
 * drop reason): the three remaining voice presets and the five voice knobs that
 * survived. The three retained examples before this one (`v1`–`v3`) never
 * reached the preset half — `AgentVoicePresets`, `VOICE_PRESETS` and
 * `VoicePresetName` were promised by epochs 4–9 and imported by none of them —
 * so the coverage this file adds to the union is exactly those three, and the
 * agent below is written around them. The rest of epoch 9's surface is `v3`'s.
 *
 * Relative specifiers, as every frozen example: the package's own `exports`
 * map would resolve to the CURRENT build, which is the wrong thing to prove.
 *
 * @module
 */

import type { AgentVoicePresets, SessionEventHandlers, VoicePresetName } from "../../../index.ts";
import { agent, VOICE_PRESETS } from "../../../index.ts";

/**
 * The presets an epoch-9 author could name. Three, and `smartMatching` is
 * deliberately not among them — epoch 8 removed it, so a list carrying it would
 * not have compiled at epoch 9 either.
 */
const presets: readonly VoicePresetName[] = ["echoVerification", "natoAlphabet"];

/** The field group as a standalone typed value, spread in — see `v3.ts` for why both shapes matter. */
const spreadPresets: AgentVoicePresets = { voicePresets: presets };

/**
 * An epoch-9 `events` map: keyed on the vocabulary epoch 9 had. Epoch 10 adds
 * `"user-turn.exceeded"` beside these; a map that names none of it is
 * unaffected, which is the property this constant holds.
 */
const events: SessionEventHandlers = {
  "guardrail.blocked": (event) => {
    void event.direction;
  },
  "usage.updated": (event) => {
    void event.totalTokens;
  },
};

/**
 * A flat epoch-9 pipeline agent: the five surviving voice knobs written out,
 * and NO `userTurnLimit` — a caller's turn at epoch 9 ended only when the
 * transcriber's silence window said so.
 */
export const dispatch = agent({
  name: "Dispatch",
  greeting: "Dispatch, go ahead.",
  systemPrompt: "Read every callsign back in the NATO alphabet before acting on it.",
  minBargeInWords: 2,
  interruptionMinDurationMs: 500,
  deadAirCoverMs: 5000,
  resumeFalseInterruption: true,
  preemptiveGeneration: false,
  voicePresets: ["natoAlphabet", "speechNormalization"],
  events,
});

/** The same agent with the preset group spread in rather than written flat. */
export const spreadDispatch = agent({
  name: "Dispatch",
  greeting: "Dispatch, go ahead.",
  ...spreadPresets,
});

/**
 * The preset TEXT is a published value an author can read — a spec that pins
 * the prompt section its agent will carry does exactly this.
 */
export const natoSection: string = VOICE_PRESETS.natoAlphabet;
