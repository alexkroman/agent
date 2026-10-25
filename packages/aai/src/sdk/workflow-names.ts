// Copyright 2026 the AAI authors. MIT license.
/**
 * The name a workflow def was DECLARED under, read back by the def's identity.
 *
 * A workflow's name is the key in `agent({ workflows })` (or the file name a
 * `workflows/<name>.ts` default export is registered as), recorded nowhere on
 * the def: `workflow()` returns its argument. So the one thing that can connect
 * a def a spec or a tool holds to the name a run carries is the lowering that
 * paired them, and this is where that pairing is kept — `withWorkflows` and
 * `workflowRegistry` record each name as they build the map, the way
 * `_testing-tool-names.ts` records a tool's file name, and a reader handed the
 * def asks here.
 *
 * Two readers, for two situations:
 *
 * - {@link workflowNameOf} — the def alone. For a fixture or a driver with no
 *   agent in hand (`createRunSnapshot(def)`, `runWorkflow(def, input)`), which
 *   otherwise fall back to a placeholder name.
 * - {@link declaredWorkflowName} — the def against a DECLARED map. For the
 *   runtime's client and the eval's recorder, which hold the agent's map and
 *   must answer only a name that map declares: a def the agent never declared
 *   cannot be started, whatever another agent once called it.
 *
 * A `WeakMap`, so a def is never kept alive by this module. Within ONE
 * lowering the FIRST key wins — a def declared under two keys is legitimate
 * (if odd), and `Object.entries` order is the deterministic choice the
 * runtime's client has always made; across lowerings the LAST wins, which is
 * the agent most recently built, as the tool names do.
 *
 * @module workflow-names
 */

import type { AnyWorkflowDef } from "./workflow.ts";

/** Def → the name a lowering registered it under. */
const NAMES = new WeakMap<object, string>();

/**
 * Record the name each def of a lowered `workflows` map is declared under.
 * Called by the lowering funnels (`withWorkflows`, `workflowRegistry`).
 *
 * @internal
 */
export function recordWorkflowNames(workflows: Readonly<Record<string, AnyWorkflowDef>>): void {
  // First key of THIS lowering wins; a def already named by an earlier
  // lowering is renamed by this one (see the module doc).
  const seen = new Set<object>();
  for (const [name, def] of Object.entries(workflows)) {
    if (seen.has(def)) continue;
    seen.add(def);
    NAMES.set(def, name);
  }
}

/**
 * The name `def` was declared under — the key of `agent({ workflows })`, or
 * the `workflows/<name>.ts` file it was discovered from — or `undefined` for a
 * def no lowering has registered (one built inline in a spec and never handed
 * to an agent).
 *
 * Recorded when the agent is lowered: import it as `virtual:aai/agent` under
 * vitest, build it with `aai build`/`aai dev`, or pass the map through
 * `withWorkflows` or `workflowRegistry` (`@alexkroman1/aai/manifest`).
 *
 * @example
 * ```ts
 * import { agent, workflow } from "@alexkroman1/aai";
 * import { workflowNameOf } from "@alexkroman1/aai/workflow-api";
 * import { z } from "zod";
 *
 * const digest = workflow({
 *   description: "Summarise a page",
 *   input: z.object({ url: z.string() }),
 *   run: async (input) => ({ url: input.url }),
 * });
 * // Lowering the map is what records the names; a build or
 * // `virtual:aai/agent` does the same for a discovered `workflows/digest.ts`.
 * agent({ name: "Digest", workflows: { digest } });
 * workflowNameOf(digest); // "digest"
 * ```
 *
 * @public
 */
export function workflowNameOf(def: AnyWorkflowDef): string | undefined {
  return NAMES.get(def);
}

/**
 * The name `declared` maps `def` under, by IDENTITY — or `undefined` when the
 * map does not hold it.
 *
 * The recorded name is tried first and only trusted when `declared` agrees
 * with it; otherwise the map is scanned, first key wins. So a stale record
 * (the def lowered again under another agent) can never answer a name this
 * map does not declare, and an unlowered map (a bare `agent({ workflows })`
 * object in a spec) still answers.
 *
 * @internal
 */
export function declaredWorkflowName(
  declared: Readonly<Record<string, AnyWorkflowDef>>,
  def: AnyWorkflowDef,
): string | undefined {
  const recorded = NAMES.get(def);
  if (recorded !== undefined && declared[recorded] === def) return recorded;
  for (const [name, candidate] of Object.entries(declared)) {
    if (candidate === def) return name;
  }
  return undefined;
}
