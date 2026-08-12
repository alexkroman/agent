// Copyright 2026 the AAI authors. MIT license.
/**
 * Resolving `start`/`find`'s first argument to a declared workflow NAME.
 *
 * Split out of `workflow-engine.ts` at the 500-line cap. It is the whole of the
 * "pass the workflow, not its name" affordance: `agent({ workflows })` stays the
 * single source of the name the journal records, and this is only the reverse
 * direction of that same record — which is what keeps a rename a one-place edit.
 */

import type { WorkflowDef } from "../sdk/workflow.ts";

/** Build the def -> name resolver for one engine's workflow record. */
export function createNameResolver(workflows: Readonly<Record<string, WorkflowDef>>) {
  /**
   * Declared name(s) for each workflow OBJECT.
   *
   * Built once per engine because the record is fixed for the life of a bundle.
   */
  const namesOf = new Map<WorkflowDef, string[]>();
  for (const [name, def] of Object.entries(workflows)) {
    const existing = namesOf.get(def);
    if (existing) existing.push(name);
    else namesOf.set(def, [name]);
  }

  /** The declared names, for an error message that can be acted on. */
  function declaredNames(): string {
    const known = Object.keys(workflows);
    return known.length > 0 ? known.join(", ") : "none";
  }

  /**
   * Resolve `start`/`find`'s first argument to a declared workflow name.
   *
   * Both spellings fail at the same boundary and say the same kind of thing: a
   * name that is not declared, or a def that is not in the record (an author who
   * built a workflow and forgot to declare it — the one mistake the typed
   * overload cannot catch, since nothing links a bare `workflow()` result to an
   * agent).
   */
  function resolveName(workflow: WorkflowDef | string): string {
    if (typeof workflow === "string") {
      if (!workflows[workflow]) {
        throw new Error(`Unknown workflow "${workflow}". Declared workflows: ${declaredNames()}`);
      }
      return workflow;
    }
    const names = namesOf.get(workflow);
    if (names === undefined || names[0] === undefined) {
      throw new Error(
        "This workflow is not declared on this agent — add it to `agent({ workflows })`. " +
          `Declared workflows: ${declaredNames()}`,
      );
    }
    // Two keys pointing at one object: the journal records ONE name, and picking
    // either would make which one arbitrary. The author has to say.
    if (names.length > 1) {
      throw new Error(
        `This workflow is declared under ${names.length} names (${names.join(", ")}). ` +
          "Start it by name so the journal records which one, or declare it once.",
      );
    }
    return names[0];
  }

  return resolveName;
}
