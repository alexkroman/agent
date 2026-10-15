// Copyright 2026 the AAI authors. MIT license.
/**
 * Capability contract: `eval-phone-tree`.
 *
 * Putting an eval session through an automated phone menu declared as data:
 * `walkPhoneTree` plays each prompt, follows the keys the agent pressed
 * (`EvalTurn.dtmf`, which `eval` carries) and reports the path and the leaf it
 * reached.
 *
 * Its own capability rather than part of `eval`: a new feature whose tree
 * shape and walk report are still young, and a change to either is not a
 * change to the harness that runs the case.
 *
 * Re-exported from `@alexkroman1/aai-runtime/eval` and `/eval/vitest`. This
 * file is not shipped and nothing imports it — it exists so
 * `pnpm check:api-contracts` can extract a report for this capability alone,
 * hash it, and hold it to a committed epoch. See `scripts/api-contracts.mjs`.
 */

export {
  type PhoneMenu,
  type PhoneTree,
  type PhoneTreeLeaf,
  type PhoneTreeStep,
  type PhoneTreeWalk,
  type WalkPhoneTreeOptions,
  walkPhoneTree,
} from "../../eval-barrel.ts";
