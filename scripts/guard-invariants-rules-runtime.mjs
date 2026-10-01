// Copyright 2026 the AAI authors. MIT license.
/**
 * The RUNTIME rules — rule 35, over `aai-runtime`'s own shipped source.
 *
 * Its own module because its corpus is one package's source rather than the
 * repo's, and a scope is what a rule module here is organised by.
 *
 * ## Why a NODE rule
 *
 * The thing banned is a VALUE in a position — what a `prepareStep` property or
 * assignment holds — not a name. A line pattern on `prepareStep:` cannot tell
 * `prepareStep: composePreparers([` from `prepareStep: forceFinalAnswer(` once
 * Biome wraps the value onto the next line, and it reads the field's own type
 * declaration and every doc comment naming the slot as hits. A parse sees a
 * `Property` and its value.
 */

import { isUncomposedPrepareStep } from "./guard-invariants-nodes.mjs";
import { RUNTIME_EGRESS_PATHSPECS } from "./guard-invariants-scopes.mjs";

/**
 * Node rules over `aai-runtime`'s shipped source.
 *
 * @type {import("./guard-invariants-rules.mjs").NodeRule[]}
 */
export const RUNTIME_RULES = [
  {
    id: 35,
    key: "rule35_uncomposedPrepareStep",
    label: "prepareStep slot written without composePreparers",
    match: isUncomposedPrepareStep,
    // The runtime's shipped source — the same corpus as rule 29, and the only
    // package that fills the slot. `composePreparers` is a private module of
    // this package, so a remedy exists here and nowhere else; a caller's own
    // `prepareStep` in another package (the studio chat) reaches the slot only
    // through the text agent, which registers it as the `"caller"` stage.
    paths: RUNTIME_EGRESS_PATHSPECS,
    samples: {
      matches: [
        "streamText({ prepareStep: forceFinalAnswer(n) });",
        "new ToolLoopAgent({\n  prepareStep: async ({ messages }) => ({ messages }),\n});",
        // Shorthand: the value is the bare identifier.
        "streamText({ model, prepareStep });",
        "options.prepareStep = contextBudget;",
        'streamText({ "prepareStep": budget });',
      ],
      ignores: [
        'streamText({\n  prepareStep: composePreparers([\n    { stage: "dialog", prepare: dialogStep },\n  ]),\n});',
        "options.prepareStep = composePreparers([]);",
        // A TYPE declaring the field is not a write into it.
        "interface Turn { prepareStep?: PrepareStepFunction<ToolSet>; }",
        // A different key, and a read of the slot.
        "const opts = { prepare: forceFinal };",
        "const hook = turn.prepareStep;",
      ],
    },
    remedy:
      "Register the concern with composePreparers from _prepare-step.ts:\n" +
      '`prepareStep: composePreparers([{ stage: "dialog", prepare: dialogStep }, …])`.\n' +
      "\n" +
      "The AI SDK's prepareStep is ONE slot. A second writer does not add a layer,\n" +
      "it REPLACES the first, and every such loss is silent: the context budget,\n" +
      "the agent-scoped toolChoice reset, the persona and dialog-state knobs, the\n" +
      "tool-error budget and forceFinalAnswer all write it, and dropping any one\n" +
      "of them is a turn that stops mid-chain, a request that overflows the\n" +
      "window, or a dialog pin that stops applying after step 0.\n" +
      "\n" +
      "composePreparers layers the stages in PREPARER_ORDER whatever order they\n" +
      "are registered in, and refuses a stage registered twice. A new per-step\n" +
      "concern is a new stage in that list, placed by its scope precedence, with\n" +
      "a case in _prepare-step.test.ts's order spec.\n" +
      "\n" +
      "The rule is ABSOLUTE: there is no baseline.",
  },
];
