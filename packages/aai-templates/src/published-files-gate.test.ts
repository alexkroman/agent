// Copyright 2026 the AAI authors. MIT license.
/// <reference types="vite/client" />
/**
 * A published package ships what its `files` field names — so every publishable
 * package has to declare one, and it has to cover every `exports` target.
 *
 * `@alexkroman1/aai` did not. With no `files` field npm packs everything a
 * `.npmignore` does not exclude, and that file excludes only repo artifacts
 * (`etc/`, `coverage/`, `.turbo/`, `contracts/`) — so the tarball carried the
 * whole `host/` and `sdk/` TypeScript source and **219 test files**: 961
 * entries, 2,049 kB packed, 7,632 kB unpacked, against 209/505/1,476 with a
 * `files` field. Every consumer downloaded the SDK's test suite.
 *
 * Nothing caught it, and the two things that look like they should are worth
 * naming. `scripts/artifact-size-report.mjs` compares against the PR base, so a
 * package that has ALWAYS shipped its source never trips a delta gate — the
 * same blind spot a ratchet has for debt that predates it. `publint` does see
 * it, and files it as a *suggestion* ("The package publishes internal tests or
 * config files"), which `check:publint` passes over; a suggestion is not a
 * gate. So this is the third instance in this repo of a packaging fact that is
 * invisible to a diff, invisible to a build, and only observable by packing.
 *
 * Two things the assertions have to know about this workspace:
 *
 * - **`@dev/source` targets are deliberately absent from the tarball.** That
 *   condition resolves to `.ts` source and is activated only by a tsconfig
 *   setting `customConditions: ["@dev/source"]`, which is this monorepo and
 *   nobody's install. Requiring `files` to cover it would put the source back.
 * - **npm always packs `package.json`, `README*` and `LICENSE*`** regardless of
 *   `files`, so an export naming one of those needs no entry. Verified against
 *   the `aai-ui` tarball, whose non-`dist/` entries are exactly `README.md`,
 *   `package.json` and its declared `styles.css`.
 *
 * Like the other repo-wide gate specs here, it reads the manifests as raw text
 * through `import.meta.glob` rather than `node:fs` — this package's tsconfig
 * pulls in no node types.
 */

import { isRecord } from "@alexkroman1/aai/utils";
import { describe, expect, test } from "vitest";

/** Every package manifest in the workspace, keyed by path relative to this file. */
const manifests: Record<string, string> = import.meta.glob("../../*/package.json", {
  query: "?raw",
  import: "default",
  eager: true,
});

/** Files npm packs whether or not `files` names them. */
const ALWAYS_PACKED = /^(package\.json|readme|licence|license)/i;

/**
 * The floor. Four packages publish today (`aai`, `aai-runtime`, `aai-ui`,
 * `aai-cli`); the whole output of this suite is otherwise a count, so a glob
 * that stopped matching would assert nothing over an empty set and pass.
 */
const MIN_PUBLISHABLE = 4;

interface Manifest {
  name?: string;
  private?: boolean;
  files?: unknown;
  exports?: unknown;
}

const parsed: { path: string; manifest: Manifest }[] = Object.entries(manifests)
  .map(([path, raw]) => ({ path, manifest: JSON.parse(raw) as Manifest }))
  .sort((a, b) => (a.path < b.path ? -1 : 1));

const publishable = parsed.filter(({ manifest }) => manifest.private !== true);

/** The declared `files` list, narrowed rather than asserted. */
const filesOf = (manifest: Manifest): string[] =>
  Array.isArray(manifest.files)
    ? manifest.files.filter((entry): entry is string => typeof entry === "string")
    : [];

/**
 * Every relative target in an `exports` map, minus the dev-only condition.
 *
 * Walked with an explicit stack rather than a recursive closure — a conditions
 * map nests arbitrarily and the iterative form keeps this one branch per node
 * kind. Order does not matter; every caller asks about membership.
 */
const exportTargets = (exports: unknown): string[] => {
  const found: string[] = [];
  const pending: unknown[] = [exports];
  while (pending.length > 0) {
    const node = pending.pop();
    if (typeof node === "string") {
      if (node.startsWith("./")) found.push(node.slice(2));
      continue;
    }
    // An array is a fallback list (`{".": ["./a.js", "./b.js"]}`) — no package
    // here uses one, and skipping it silently would under-report.
    if (Array.isArray(node)) {
      pending.push(...node);
      continue;
    }
    if (!isRecord(node)) continue;
    for (const [key, value] of Object.entries(node)) {
      // `@dev/source` resolves to `.ts` source, deliberately absent from the
      // tarball; requiring `files` to cover it would put the source back.
      if (key !== "@dev/source") pending.push(value);
    }
  }
  return found;
};

describe("publishable packages declare what they ship", () => {
  test("the manifest glob still finds the workspace", () => {
    expect(parsed.length).toBeGreaterThanOrEqual(MIN_PUBLISHABLE);
    expect(publishable.length).toBeGreaterThanOrEqual(MIN_PUBLISHABLE);
  });

  test.each(publishable.map(({ path, manifest }) => [manifest.name ?? path, manifest] as const))(
    "%s declares a non-empty files field",
    (_name, manifest) => {
      expect(Array.isArray(manifest.files)).toBe(true);
      expect(filesOf(manifest).length).toBeGreaterThan(0);
    },
  );

  test.each(publishable.map(({ path, manifest }) => [manifest.name ?? path, manifest] as const))(
    "%s covers every exports target with files",
    (_name, manifest) => {
      const declared = filesOf(manifest);
      const targets = exportTargets(manifest.exports);
      expect(targets.length).toBeGreaterThan(0);
      const uncovered = targets.filter((target) => {
        if (ALWAYS_PACKED.test(target)) return false;
        return !declared.some((entry) => target === entry || target.startsWith(`${entry}/`));
      });
      expect(uncovered, `${_name} exports paths no files entry packs`).toEqual([]);
    },
  );
});
