// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:agent` epoch 15.
 *
 * Epoch 15 is epoch 14 with two changes, and both are about what an author has
 * to KNOW rather than about what a declaration may say.
 *
 * The ten field-list and message types behind `AgentParams`' four arms left the
 * root barrel. They still type the arms — every mode mistake is the same compile
 * error naming the same rule — but they are no longer names in an authoring
 * autocomplete, because nobody writes them. Every message is unchanged —
 * `define.test-d.ts` pins each one — and what is gone is
 * only the ability to `import type { PipelineOnlyMisuse }`. This file therefore
 * demonstrates what epoch 15 lets an author WRITE; the refusals are a spec's
 * job, not a frozen example's.
 *
 * And `minTurnSilenceMs`/`maxTurnSilenceMs` joined the author conveniences
 * beside `voice`, desugaring to `stt: assemblyAIStt({ … })`. That is purely
 * WIDENING — the descriptor form still works and is what an agent with an
 * explicit `stt` stage uses — so epoch 13 and its predecessors are unaffected.
 *
 * See `./v3.ts` for what "frozen" obliges and why the imports are relative.
 */

import { agent, assemblyAIPipeline } from "../../../index.ts";

/**
 * The pause-tolerance knob, as one field on the default pipeline.
 *
 * This is the shape epoch 15 adds. Before it, moving this number meant writing
 * `stt: assemblyAIStt({ maxTurnSilenceMs })` — which opts the stage out of the
 * default fill, so an author who also wanted a region had to re-declare that
 * too or silently lose it.
 */
export const patient = agent({
  name: "Patient",
  greeting: "Take your time.",
  // Bounds only utterances that never read as complete, so hesitant speech pays
  // for it and a finished sentence does not.
  maxTurnSilenceMs: 4500,
});

/** The same setting on a config that already spreads the preset, for a region. */
export const eu = agent({
  name: "EU",
  ...assemblyAIPipeline({ region: "eu", maxTurnSilenceMs: 4500 }),
  llm: "claude-sonnet-4-6",
});
