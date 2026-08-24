// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:agent` epoch 20.
 *
 * **Moved for a TRANSITIVE reason, and nothing an `agent.ts` writes changed.**
 * `ToolContext` gained `delegate` — the `ctx.delegate` capability, whose own
 * contract is `aai:subagent` — and this capability's report mentions
 * `ToolContext` through `AgentDef.tools`, so the hash moved with it. Epoch 19
 * is RETAINED and `./v19.ts` compiles unchanged beside this file; every
 * spelling below is byte-for-byte what an epoch-19 author wrote.
 *
 * The same transitivity that `../tool/v11.ts` records for `WorkflowClient`,
 * one capability further out. It is the mechanism working: a mention is part
 * of a capability's shape, so an agent's tools really can do something they
 * could not before.
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
