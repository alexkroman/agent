// Copyright 2026 the AAI authors. MIT license.
/**
 * Capability contract: `eval-assert`.
 *
 * The two newest per-turn CLAIMS over an eval turn: `expectCalled` (the agent
 * acted at all — it called the tool before it spoke, naming the sentence it
 * said instead) and `lastToolResultIn` (the most recent result a named tool
 * returned, throwing on none).
 *
 * Its own capability over `/eval` rather than part of `eval`: they are the
 * young half of the assertion vocabulary and still moving, and a claim's
 * message or overload changing is not a change to the harness that runs the
 * case. The readers `eval` has carried since its first epoch stay there.
 *
 * Re-exported from `@alexkroman1/aai-runtime/eval`. This file is not shipped
 * and nothing imports it — it exists so `pnpm check:api-contracts` can extract
 * a report for this capability alone, hash it, and hold it to a committed
 * epoch. See `scripts/api-contracts.mjs`.
 */

export { expectCalled, lastToolResultIn } from "../../eval-barrel.ts";
