// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:dialog` epoch 2.
 *
 * **Nothing in this capability's own surface changed at epoch 3**, and that is
 * worth stating plainly because it is the reason this file is short. The hash
 * moved because a capability's report is the whole rollup its entrypoint pulls
 * in, and `agent({ lowConfidence })`'s three new types landed in that rollup
 * as foreign declarations. `DialogSpec`, `DialogStateSpec`, `DialogToolDef`
 * and the rest are byte-identical.
 *
 * What DID change is on the other side of the same feature and is invisible
 * from here: a state's `keyterms` used to be accepted and applied by nothing,
 * warned about once per deployed agent. It is live now, pushed to the STT
 * stream at the end of each agent turn. That is a behaviour change under an
 * unchanged declaration — which is exactly why the example below declares one
 * and asserts nothing about what happens to it.
 *
 * So the promise is that every epoch-2 dialog declaration still compiles. If a
 * later epoch drops a spec feature or obliges a new key, this file reddens —
 * the signal to DROP the epoch rather than to edit the example.
 *
 * The 15 names epoch 2 promised are already imported and used by `v1.ts`
 * beside this file, and the gate's coverage rule reads the UNION of a
 * capability's frozen examples; restating them here would be a copy that can
 * drift rather than a second proof. Specifiers are RELATIVE, like every
 * fixture here.
 *
 * @module
 */

import type { DialogSpec, DialogStateSpec, DialogVoiceConfig } from "../../../index.ts";
import { dialog } from "../../../index.ts";

/**
 * A state that narrows the recognizer's vocabulary for one phase of the call.
 *
 * The declaration an epoch-2 author wrote — and the one whose MEANING epoch 3
 * changed, from "accepted and warned about" to "applied per turn".
 */
const collecting: DialogStateSpec = {
  instruction: "Ask for the order number and read it back.",
  keyterms: ["order number", "gift card"],
  bargeIn: { minWords: 3 },
  temperature: 0.2,
  on: { CONFIRMED: "done" },
} satisfies DialogVoiceConfig & DialogStateSpec;

const callSpec = {
  initial: "collecting",
  states: {
    collecting,
    done: { final: true, instruction: "Thank them and stop." },
  },
} as const satisfies DialogSpec;

export const callFlow = dialog("call", callSpec);
