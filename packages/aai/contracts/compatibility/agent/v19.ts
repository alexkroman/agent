// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:agent` epoch 19.
 *
 * **What moved: the silence nudge became a PAIR in the type.** `silenceTimeoutMs`
 * and `silencePrompt` used to be two independently optional fields on
 * `PipelineAgentParams`, so a prompt with no timeout compiled and was refused
 * later, by `assertSilencePolicy` at config time — i.e. at `aai build`, after
 * the author had moved on. They are now two arms: a timeout with an optional
 * prompt, or neither.
 *
 * Epoch 18 is RETAINED, and this file is what says the retention is real: every
 * spelling below is one an epoch-18 agent could have used, and the only shape
 * that stopped compiling is the one that never worked.
 *
 * See `./v3.ts` for what "frozen" obliges and why the imports are relative.
 */

import { type AgentDef, agent, assemblyAIPipeline } from "../../../index.ts";

/** A nudge with both halves — the shape the pair type is FOR. */
export const nudging: AgentDef = agent({
  name: "Front Desk",
  silenceTimeoutMs: 12_000,
  silencePrompt: "Ask, once, whether they are still there.",
});

/** A nudge with the timeout alone, which takes the framework's own prompt. */
export const quiet: AgentDef = agent({ name: "Quiet", silenceTimeoutMs: 20_000 });

/** Neither half, which is every other agent. */
export const plain: AgentDef = agent({ name: "Plain", ...assemblyAIPipeline() });

/**
 * The pair beside the rest of the pipeline knobs, which are unchanged: only the
 * two silence fields were subtracted from the derived optional set, so a
 * declaration that sets a tuning knob and a nudge together still compiles.
 */
export const tuned: AgentDef = agent({
  name: "Tuned",
  voice: "michael",
  minBargeInWords: 3,
  deadAirCoverMs: 0,
  resumeFalseInterruption: false,
  silenceTimeoutMs: 15_000,
  silencePrompt: "Offer to call back.",
});

/**
 * An options bag reaching the call through a spread, which is the shape that
 * makes the arms worth checking: the union has to survive one, or a caller that
 * builds its config elsewhere loses the pair.
 */
const opts = { silenceTimeoutMs: 8000, silencePrompt: "Still with me?" };
export const spread: AgentDef = agent({ name: "Spread", ...opts });
