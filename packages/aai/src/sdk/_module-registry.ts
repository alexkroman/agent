// Copyright 2026 the AAI authors. MIT license.
/**
 * What counts as a MODULE of a registry directory — `tools/` and
 * `workflows/` — in one place.
 *
 * Four readers decided it separately and had drifted: `toolRegistry` skipped
 * `.test`/`.spec`, `workflowRegistry` also `.test-d`, and the vitest plugin's
 * directory scan knew `.test`/`.test-d` and not `.spec`. A spec that one
 * reader skipped and another registered is a tool named `echo.test` in front
 * of the model, or a workflow a build lists and a spec cannot find. The
 * extension set, the spec suffixes, the name a path declares, and the
 * structural "is a workflow def" test are therefore declared ONCE here.
 *
 * Internal (`_`-prefixed): the registries and `host/testing-vite.ts` read it;
 * nothing outside this package may.
 *
 * @module _module-registry
 */

import { isRecord } from "./is-record.ts";
import type { WorkflowDef } from "./workflow.ts";

/** Extensions a registry module may be authored in. */
export const MODULE_EXT_RE = /\.(?:m?[jt]s|tsx)$/;

/**
 * A co-located spec or type test is never a registry module, whatever tier
 * it is in: `foo.test`, `foo.spec`, `foo.test-d`, and the tiered
 * `foo.integration.test` / `foo.scenario.test` / `foo.eval.test` all end in one
 * of the three. Tested against the name with {@link MODULE_EXT_RE} stripped.
 */
export const SPEC_RE = /\.(?:test|spec|test-d)$/;

/** The directories that are registries. */
export type RegistryDir = "tools" | "workflows";

/**
 * The name a path declares in `dir`: the part after the LAST `<dir>/` segment
 * with the extension dropped, and whether that part is nested.
 *
 * Paths arrive with whatever prefix their source used — `./tools/x.ts` from a
 * glob, `tools/x.ts` from the generated entry, an absolute path from a scan —
 * so only the part after the directory is read. A nested name keeps its `/`,
 * so the caller's message can quote the flat path to move it to.
 */
export function moduleNameOf(path: string, dir: RegistryDir): { name: string; nested: boolean } {
  const afterDir = path.split(new RegExp(`(?:^|/)${dir}/`)).pop() ?? path;
  return { name: afterDir.replace(MODULE_EXT_RE, ""), nested: afterDir.includes("/") };
}

/**
 * A workflow def as recognized at RUNTIME — structural, because `workflow()`
 * returns its argument and there is no brand to read. `run` is the one member
 * every def has, and no overrides bag or helper module has one.
 */
export function isWorkflowDef(value: unknown): value is WorkflowDef {
  return isRecord(value) && typeof value.run === "function";
}
