// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:agent` epoch 7.
 *
 * **Epoch 8 widened one union and changed nothing else.** `BuiltinTool` gained
 * a tenth member, `"verify_action"`, so the export list did not move — every
 * name here is one epoch 7 promised — and this file is the evidence that
 * widening is all it was: `desk` below names builtins from the NINE that
 * existed at epoch 7, and `deskBuiltins` reads the union back as a narrowed
 * alias. An author who never hears about the tenth member is unaffected.
 *
 * That is the promise worth freezing, and it has a specific failure mode on the
 * other side. "Still compiles" would also be met by a union that RENAMED a
 * member, or by a `builtinTools` that started defaulting to a non-empty list —
 * and either would silently change what a deployed epoch-7 agent does.
 * `DEFAULT_BUILTIN_TOOLS` is empty and a builtin is something an agent asks
 * for; `emptyByDefault` below is that clause written as code.
 *
 * ## Why this file carries no roll-call
 *
 * Coverage is measured per CAPABILITY over the union of its frozen examples,
 * and epoch 7 ADDED no name — it is the epoch the fast/slow two-tier split was
 * removed AT, dropping nine (`TwoTierConfig`, `SlowTierEffort` and the seven
 * `DEFAULT_*`/`MAX_*` constants around them). `v1.ts` through `v4.ts` are
 * retained alongside this file and between them name everything epoch 7 still
 * promises, so restating those here would freeze nothing new.
 *
 * What a roll-call cannot do is the thing this epoch is actually about: an
 * agent declaration with NO two-tier field anywhere, which is what an epoch-7
 * author wrote and what must keep compiling. If a later epoch brings that
 * split back as a required field, this file reddens — the signal to DROP the
 * epoch rather than to edit the example.
 *
 * **Its specifiers are RELATIVE.** Importing the package by name would resolve
 * through its own `exports` map to whatever the current build publishes, so the
 * fixture would prove the CURRENT surface compiles rather than that epoch 7's
 * does.
 *
 * @module
 */

import type { AgentDef, BuiltinTool } from "../../../index.ts";
import { agent } from "../../../index.ts";

/**
 * The four cognitive builtins an epoch-7 author could name, as the narrowed
 * type rather than as bare strings — which is what makes this a check on the
 * UNION and not merely on a string literal surviving. A widened union still
 * accepts every one; a renamed member would not.
 */
const COGNITIVE: readonly BuiltinTool[] = ["think", "remember", "recall", "calculate"];

/** And the network half, named the same way. */
const NETWORK: readonly BuiltinTool[] = ["web_search", "visit_webpage", "fetch_json"];

/**
 * An epoch-7 declaration: builtins asked for by name, and no `twoTier`.
 *
 * `llm` as a bare model-id string is one of the three author conveniences
 * `agent()` normalizes, exercised here because it is the spelling a short
 * `agent.ts` uses and therefore the one most likely to be written.
 */
export const desk = agent({
  name: "Front desk",
  systemPrompt: "Answer in one or two sentences. Never guess an order number.",
  greeting: "Front desk, how can I help?",
  voice: "michael",
  llm: "claude-sonnet-4-6",
  builtinTools: [...COGNITIVE, ...NETWORK],
  maxSteps: 8,
});

/**
 * The declaration read BACK as the narrowed type. A config-driven list (a form,
 * an env var, a per-tenant record) is typed against this, so it is the read
 * that a changed member breaks rather than the write.
 */
export const deskBuiltins: readonly BuiltinTool[] = desk.builtinTools ?? [];

/**
 * Omitting the field is the off-switch, and an epoch-7 agent that omitted it
 * must still get NO builtins. Typed as `AgentDef` so the whole definition —
 * not just the one field — is held to the shape epoch 7 was promised.
 */
export const emptyByDefault: AgentDef = agent({
  name: "Quiet desk",
  systemPrompt: "Answer briefly.",
});
