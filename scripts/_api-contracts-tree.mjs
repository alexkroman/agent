#!/usr/bin/env node

/**
 * WHERE a contract lives: which packages carry one, the paths inside it, and the
 * policy that decides which published subpaths it has to cover.
 *
 * The layer above this (`_api-contracts.mjs`) turns a capability's entry point
 * into an API Extractor report; the layer above that
 * (`_api-contracts-checks.mjs`) checks the results. Three files rather than one
 * because the paths-and-policy half is what a reader opens to answer "how does a
 * package opt in", and it should not be read past 250 lines of extractor
 * plumbing to get there.
 *
 * Everything here is parameterized by a PACKAGE. It was hardcoded to
 * `packages/aai` while that was the only package with contracts, which read as
 * "the SDK is the authoring surface" — and `@alexkroman1/aai-ui` is authored
 * code too: a `client.tsx` names `client()`, `useAgentState`, `<Form>` and
 * `useWorkflowRun` exactly the way an `agent.ts` names `agent()` and `tool()`,
 * and a signature change there breaks a user's page rather than their agent.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import { typedEntryPoints } from "./_api-surface.mjs";
import { readJson, readManifest, repoRoot } from "./_fs.mjs";

// `readJson` was defined here (silently) and twice more elsewhere; it is
// `_fs.mjs`'s now, re-exported so the ~20 call sites in this tree read as before.
// `readManifest` rides along for the same reason: `_api-contracts.mjs` reads a
// package manifest and takes everything else in this family from here.
export { readJson, readManifest } from "./_fs.mjs";

export const ROOT = repoRoot(import.meta.url).replace(/\/$/, "");
const PACKAGES_ROOT = join(ROOT, "packages");

/** Marker a scaffolded fixture carries until somebody writes the real example. */
export const FIXTURE_PLACEHOLDER = "REPLACE_WITH_A_REAL_AUTHORING_EXAMPLE";

/**
 * Published subpaths that are NOT authoring surface, and why.
 *
 * A DENY-list, keyed by package directory name, for the reason the config
 * schema is one (see "One canonical config schema, deny-list boundaries" in
 * `packages/aai/CLAUDE.md`): an allow-list of authoring subpaths is a second
 * list of the public surface, and the omission that goes stale is invisible —
 * a new subpath export simply never joins a contract, which is exactly the
 * shape of every dropped-field bug this repo has paid for. Denied, a new
 * subpath defaults INTO the authoring surface and its exports fail the
 * assignment check until somebody decides which capability they join, which is
 * the same decision as "is this something we promise an author".
 *
 * A package with no entry here therefore contracts every `.d.ts` subpath it
 * publishes, which is what makes opting a package in cost one directory rather
 * than one directory plus a list.
 */
const NON_AUTHORING_SUBPATHS = {
  aai: {
    "./protocol": "the wire format both ends of a session derive, not something an agent declares",
    "./manifest": "the config schema the CLI, the server and the runtime pass between them",
    "./slugify": "how a human name becomes a slug, for the CLI, the platform and the studio",
    "./workspace-files": "the studio's workspace layout, read by the platform and the CLI",
    "./internal": "cross-package infrastructure, explicitly not semver-covered",
    "./testing/vite":
      "a Vite plugin serving `virtual:aai/agent` — build tooling a `vitest.config.ts` registers, not something an agent.ts or a spec BODY writes against",
    "./host-internal":
      "the SDK internals the FRAMEWORK packages need across the package boundary — aai-runtime principally, plus the guest, the studio server and the template gate; not semver-covered",
  },
  "aai-ui": {
    "./internal":
      "the plumbing `client()` installs for itself — the providers, the URL chips, the pre-connection lookup; not something a `client.tsx` writes against",
  },
  "aai-runtime": {
    "./internal":
      "the same SDK internals passed on for aai-server, aai-cli and aai-guest — the re-export half of aai's own ./host-internal exemption, which is per SUBPATH and so did not survive being re-published on this package's root barrel",
  },
};

/**
 * Authoring subpaths that no SHIPPED EXAMPLE is expected to exercise, and why.
 *
 * The second deny-list, read by `exampleFacingSubpaths` and through it by
 * `packages/aai-templates/src/template-api-coverage.test.ts`. It exists because
 * "authoring" covers two audiences that the contract system deliberately does
 * not separate — an agent author writing `agent.ts` and `client.tsx`, and a
 * host embedding the runtime — while the shipped examples only demonstrate the
 * first. A ratchet whose failure message says "add or extend a template" has to
 * be scoped to the surface a template can legitimately demonstrate, or the
 * advice it gives is wrong.
 *
 * Same shape and same argument as {@link NON_AUTHORING_SUBPATHS}: DENY, so a
 * new subpath defaults into needing a worked example, and a stale entry is a
 * hard failure rather than a silent hole.
 */
const UNEXEMPLIFIED_SUBPATHS = {
  "aai-runtime": {
    ".":
      "the host embedding surface — `createRuntime`/`createAgentServer` and the transports. " +
      "Its consumer is a server, not an `agent.ts`, and its worked example is the scaffold's " +
      "own `server.mjs` plus this package's compatibility fixture, which is written as a " +
      "starter a host copies. `/eval` and `/eval/vitest` are NOT here: every template ships " +
      "an `agent.eval.test.ts` written against them.",
  },
};

export const rel = (path) => relative(ROOT, path);

/**
 * Write JSON that Biome already agrees with.
 *
 * `packages/**` is in Biome's file scope, and `JSON.stringify(x, null, 2)` always
 * expands an array while Biome collapses a short one onto its own line —
 * `"supported": [1]`. So every generated file failed `pnpm lint` the moment it was
 * written, and the only fixes available are to hand-edit a file the next run
 * overwrites or to reimplement Biome's formatter and watch it drift. Formatting
 * through Biome itself makes the two agree by construction, which is the same
 * trick eve uses on its own contract metadata (it pipes through `oxfmt`).
 *
 * A formatter failure is not fatal: the raw JSON is still correct and the lint
 * gate will say so in its own words, which is a better error than this one.
 */
const writeJson = (path, value) => {
  mkdirSync(dirname(path), { recursive: true });
  const raw = `${JSON.stringify(value, null, 2)}\n`;
  let formatted = raw;
  try {
    formatted = execFileSync(
      join(ROOT, "node_modules/.bin/biome"),
      ["format", `--stdin-file-path=${path}`],
      { cwd: ROOT, encoding: "utf8", input: raw, stdio: ["pipe", "pipe", "pipe"] },
    );
  } catch {
    // Fall through with the unformatted JSON.
  }
  writeFileSync(path, formatted);
};

/**
 * A fixture may use JSX exactly when the package's own tsconfig compiles it.
 *
 * DERIVED rather than declared, because the two cannot then disagree: a frozen
 * authoring example is only evidence if it is written the way that epoch was
 * authored, and for a React component library that means JSX — an example
 * spelled in `createElement` calls would compile while demonstrating an API
 * nobody uses. The tsconfig is read as text rather than parsed: these files
 * carry comments in this repo, and the question is only whether the key is
 * present.
 */
function fixtureExtension(packageDir) {
  const tsconfig = join(packageDir, "tsconfig.json");
  if (!existsSync(tsconfig)) return ".ts";
  return /^\s*"jsx"\s*:/m.test(readFileSync(tsconfig, "utf8")) ? ".tsx" : ".ts";
}

/**
 * One contract-carrying package, as paths and policy.
 *
 * `key` is the directory name and the CLI's qualifier: capability names are
 * only unique WITHIN a package (`workflow` is a capability of both `aai` and
 * `aai-ui`, and they are different contracts), so anything a human reads or
 * types is `aai-ui:workflow`. The epoch files stay unqualified — their path
 * already names the package, and qualifying them would have rewritten twenty
 * committed records to say what their own directory says.
 */
function contractPackage(key) {
  const dir = join(PACKAGES_ROOT, key);
  const contractRoot = join(dir, "src", "contracts");
  return {
    key,
    dir,
    contractRoot,
    name: readManifest(join(dir, "package.json")).name,
    entrypointRoot: join(contractRoot, "entrypoints"),
    /** Epoch metadata. NOT `reports/` — `.gitignore` has a bare `reports/` rule. */
    epochRoot: join(contractRoot, "epochs"),
    fixtureRoot: join(contractRoot, "compatibility"),
    tablePath: join(contractRoot, "contracts.json"),
    internalSurfacePath: join(contractRoot, "internal-surface.json"),
    cacheRoot: join(dir, ".api-contracts-cache"),
    fixtureExtension: fixtureExtension(dir),
  };
}

/**
 * The packages that carry contracts, discovered from the tree.
 *
 * Opting a package in is creating `src/contracts/entrypoints/` inside it; there is
 * no list to join, for the reason `api-report.mjs` derives its entry points
 * from `package.json#exports` and this file derives its capabilities from the
 * entry-point directory. A hand-kept list of what is versioned is the thing
 * that silently stops covering something.
 */
export function contractPackages() {
  return readdirSync(PACKAGES_ROOT)
    .filter((key) => existsSync(join(PACKAGES_ROOT, key, "src/contracts/entrypoints")))
    .sort()
    .map((key) => contractPackage(key));
}

/**
 * The three committed contract artifacts, as shapes.
 *
 * `readJson` rightly answers `unknown`, and every reader below was reaching
 * into that for `.current`, `.supported`, `.exports`. Declaring them here means
 * one narrowing per artifact instead of one per read, and — the part worth
 * having — a misspelled field in a gate that decides whether a BREAKING change
 * can land is a compile error rather than an `undefined` that compares equal to
 * nothing and reports no violation.
 *
 * @typedef {{ current: number, supported: number[], dropped: Record<string, string> }} CapabilityEpochs
 * @typedef {Record<string, CapabilityEpochs>} ContractTable
 * @typedef {{ comment?: string, total: number, surface: Record<string, string[]> }} InternalSurface
 * @typedef {{ kind: string, capability: string, epoch: number, sha256: string, exports: string[] }} EpochRecord
 */

/** @returns {ContractTable} */
export const readTable = (pkg) => /** @type {ContractTable} */ (readJson(pkg.tablePath));
export const writeTable = (pkg, table) => writeJson(pkg.tablePath, table);
/** @returns {InternalSurface} */
export const readInternalSurface = (pkg) =>
  /** @type {InternalSurface} */ (readJson(pkg.internalSurfacePath));
export const writeInternalSurface = (pkg, surface) => writeJson(pkg.internalSurfacePath, surface);

export const epochPath = (pkg, capability, version) =>
  join(pkg.epochRoot, capability, `v${version}.json`);
/** @returns {EpochRecord} */
export const readEpoch = (pkg, capability, version) =>
  /** @type {EpochRecord} */ (readJson(epochPath(pkg, capability, version)));
export const writeEpoch = (pkg, capability, version, value) =>
  writeJson(epochPath(pkg, capability, version), value);

/**
 * Where a capability's frozen example for one epoch lives.
 *
 * An existing file wins over the package's preferred extension, so a fixture
 * that was written as `.ts` and later needed JSX (or the reverse) is still the
 * one this reads — the alternative is a gate that reports a missing example
 * while looking straight at it.
 */
export function fixturePath(pkg, capability, version) {
  const base = join(pkg.fixtureRoot, capability, `v${version}`);
  for (const extension of [".ts", ".tsx"]) {
    if (existsSync(`${base}${extension}`)) return `${base}${extension}`;
  }
  return `${base}${pkg.fixtureExtension}`;
}

/** What a human reads and types: capability names repeat across packages. */
export const capabilityId = (pkg, capability) => `${pkg.key}:${capability}`;

/**
 * The capabilities that EXIST in one package, read off its entry-point
 * directory.
 *
 * Derived rather than listed, for the reason `api-report.mjs` derives its entry
 * points from `package.json#exports`: a hand-kept list of the surface is the
 * thing that goes stale. The gate separately asserts this set matches the
 * contract table, so adding a file without a table entry fails loudly instead
 * of being silently unversioned.
 */
export function capabilities(pkg) {
  return readdirSync(pkg.entrypointRoot)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => name.slice(0, -3))
    .sort();
}

/**
 * The subpaths of one package whose exports must belong to a capability, as
 * `{ subpath: reportSlug }`.
 *
 * Everything the package publishes with types, minus the deny-list above. A
 * denied subpath the package no longer exports is a FAILURE rather than a
 * no-op: a stale exemption is how a subpath quietly leaves the contracted set.
 *
 * Keys are the subpath as a consumer appends it — `/utils`, not `./utils` —
 * because they are what the `internal-surface.json` baselines and every message
 * here are keyed by.
 */
export function authoringSubpaths(pkg) {
  const manifest = readManifest(join(pkg.dir, "package.json"));
  const exports = manifest.exports ?? {};
  const denied = NON_AUTHORING_SUBPATHS[pkg.key] ?? {};

  const stale = Object.keys(denied).filter((subpath) => !Object.hasOwn(exports, subpath));
  if (stale.length > 0) {
    throw new Error(
      `${pkg.name} no longer exports ${stale.join(", ")}, but NON_AUTHORING_SUBPATHS in ` +
        `${rel(join(ROOT, "scripts/_api-contracts-tree.mjs"))} still exempts it. Remove the ` +
        "entry — a stale exemption silently keeps a live subpath out of the contracted surface.",
    );
  }

  // The scan AND the slug are `_api-surface.mjs`'s, shared with
  // `api-report.mjs`, because the two are coupled by the filename that slug
  // produces — this reads `etc/<slug>.api.md`, that writes it. Keys stay the
  // subpath as a CONSUMER appends it (`/utils`, not `./utils`), which is what
  // `internal-surface.json` and every message here is keyed by.
  return Object.fromEntries(
    typedEntryPoints(manifest)
      .filter(({ subpath }) => !Object.hasOwn(denied, subpath))
      .map(({ subpath, slug }) => [subpath === "." ? "." : subpath.replace(/^\./, ""), slug]),
  );
}

/**
 * The subpaths a SHIPPED EXAMPLE is expected to exercise, as
 * `{ specifier: subpath }` keyed by what an author types in an import.
 *
 * {@link authoringSubpaths} minus {@link UNEXEMPLIFIED_SUBPATHS}, so this and
 * the contracted surface cannot disagree about what the authoring API is —
 * which they did, for as long as the coverage ratchet carried its own
 * hand-written list of seven module specifiers. That list named `aai`'s root
 * and its four provider subpaths and stopped there, so eight contracted
 * authoring subpaths (`/step`, `/step-errors`, `/step-files`, `/testing`,
 * `/testing/vitest`, `/tools`, `/channels`, `/workflow-api`) plus `aai-ui`'s
 * `/client-dir` and both of `aai-runtime`'s eval subpaths were invisible to it.
 * Nine of those eleven are imported by the templates today.
 *
 * A stale exemption is a FAILURE for the same reason it is in
 * {@link authoringSubpaths}: an entry for a subpath that is no longer authoring
 * surface would silently keep a live one out of the examples' scope.
 */
export function exampleFacingSubpaths(pkg) {
  const authoring = authoringSubpaths(pkg);
  const exempt = UNEXEMPLIFIED_SUBPATHS[pkg.key] ?? {};

  const stale = Object.keys(exempt).filter((subpath) => !Object.hasOwn(authoring, subpath));
  if (stale.length > 0) {
    throw new Error(
      `${pkg.name} does not publish ${stale.join(", ")} as authoring surface, but ` +
        `UNEXEMPLIFIED_SUBPATHS in ${rel(join(ROOT, "scripts/_api-contracts-tree.mjs"))} still ` +
        "exempts it from needing a worked example. Remove the entry.",
    );
  }

  return Object.fromEntries(
    Object.keys(authoring)
      .filter((subpath) => !Object.hasOwn(exempt, subpath))
      .map((subpath) => [
        subpath === "." ? pkg.name : `${pkg.name}${subpath}`,
        subpath === "." ? "." : `.${subpath}`,
      ]),
  );
}

/**
 * Where an `@internal` name on a public subpath should go instead.
 *
 * `aai` has a private `./internal` subpath to name; `aai-ui` does not, and
 * telling its author to move a symbol to a subpath that does not exist is worse
 * than saying nothing.
 */
export function internalDestination(pkg) {
  const manifest = readManifest(join(pkg.dir, "package.json"));
  return Object.hasOwn(manifest.exports ?? {}, "./internal") ? `${pkg.name}/internal` : null;
}
