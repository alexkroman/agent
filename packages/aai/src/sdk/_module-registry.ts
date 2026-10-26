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
 * extension set, the spec suffixes, the name a path declares, and the "is a
 * workflow def" test are therefore declared ONCE here — and the two directory
 * SCANS (the CLI's generated worker entry, `virtual:aai/agent`) share
 * {@link isRegistryModuleFile}, so a spec sees exactly the files a build ships:
 * a `tools/echo.mts` the build deployed was invisible to `virtual:aai/agent`,
 * which read `.ts` only.
 *
 * Internal (`_`-prefixed): the registries and `host/testing-vite.ts` read it;
 * the CLI reaches {@link isRegistryModuleFile} through `/internal`.
 *
 * @module _module-registry
 */

import { readBrand } from "./_boundary.ts";
import { isRecord } from "./is-record.ts";
import type { WorkflowDef } from "./workflow.ts";

/** Extensions a registry module may be authored in. */
export const MODULE_EXT_RE: RegExp = /\.(?:m?[jt]s|tsx)$/;

/**
 * A co-located spec or type test is never a registry module, whatever tier
 * it is in: `foo.test`, `foo.spec`, `foo.test-d`, and the tiered
 * `foo.integration.test` / `foo.scenario.test` / `foo.eval.test` all end in one
 * of the three. Tested against the name with {@link MODULE_EXT_RE} stripped.
 */
export const SPEC_RE: RegExp = /\.(?:test|spec|test-d)$/;

/**
 * Whether a file of a registry directory is a MODULE of it — one of the
 * extensions, and not a co-located spec or type test. The one rule both
 * directory scans apply, to a path or a bare file name, so the CLI's build and
 * `virtual:aai/agent` enumerate the same set; both read the directory
 * recursively, and a nested file is then refused by the registry that owns
 * the name rule (a tool by its name, a workflow DEF by its nesting) rather
 * than skipped by one reader and shipped by the other.
 */
export function isRegistryModuleFile(name: string): boolean {
  return MODULE_EXT_RE.test(name) && !SPEC_RE.test(name.replace(MODULE_EXT_RE, ""));
}

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
 * A workflow def as recognized at RUNTIME: one `workflow()` (or a
 * declaration's `.body()`) answered, read by the brand it set (`_boundary.ts`,
 * so a def the bundle's SDK copy made is recognized by the host's), and
 * carrying the `run` every def has. Structural acceptance was dropped on
 * purpose: a plain `{ description, run }` helper default-exported from
 * `workflows/` registered as a workflow with no input schema and no
 * validation, and ran.
 */
export function isWorkflowDef(value: unknown): value is WorkflowDef {
  return (
    isRecord(value) && typeof value.run === "function" && readBrand(value, "workflowDef") === true
  );
}
