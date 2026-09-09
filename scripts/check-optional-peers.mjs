#!/usr/bin/env node
// Copyright 2026 the AAI authors. MIT license.
/**
 * No module a PUBLISHED entry can reach may statically import an OPTIONAL PEER.
 *
 * ## The failure, twice
 *
 * A consumer bundles this repo's packages with `ssr: { noExternal: true }` and
 * `codeSplitting: false` — that is `aai build`'s worker, and every deployment
 * target's entry (`_target-bundle.ts`). Both settings together mean a dynamic
 * `import()` is INLINED, so a module that is only ever reached lazily still has
 * its own imports resolved AT BUILD TIME, against a project that installed only
 * what it needed. Vite answers an unresolvable optional peer with a
 * `__vite-optional-peer-dep:` stub that exports nothing, and rolldown then
 * checks every NAMED binding against it:
 *
 *     [MISSING_EXPORT] "ROOT_CONTEXT" is not exported by
 *       "__vite-optional-peer-dep:@opentelemetry/api:@alexkroman1/aai-runtime"
 *
 * Twelve of those failed a real `vercel deploy` of a scaffolded project —
 * `aai-runtime/_tracing-otel.ts`, reached from `@alexkroman1/aai-cli/start`.
 * The same file had failed the same way once before through a different
 * importer (`server.ts`, which is why `_request-trace.ts` exists), and the
 * remedy both times was to keep that module out of that bundle. That remedy
 * cannot hold: it is a property of the whole import graph, re-decided by every
 * new caller, and nothing failed when a caller re-decided it.
 *
 * ## What makes it impossible rather than fixed
 *
 * A DYNAMIC import has no export check — measured against vite 8 / rolldown,
 * both `(await import(p)).X` and `const { X } = await import(p)` build clean
 * and defer the missing peer to the moment the stub is evaluated. So the rule
 * is not about which bundle a module lands in, which no author can be asked to
 * know. It is about the IMPORT FORM, which is local and visible:
 *
 *   **an optional peer is reached through `await import(...)`, or through
 *   `import type` — never through a static value import.**
 *
 * `import type` is erased entirely, so it is free; a bare `import type` is the
 * only static form allowed. `import { type A, value }` is not, and neither is
 * `import { type A }` — with `verbatimModuleSyntax` that still emits an
 * `import {} from "..."`, which evaluates the stub and throws at load.
 *
 * ## Why REACHABILITY and not a file-name convention
 *
 * `vitest` is an optional peer of three packages and is statically imported by
 * a dozen test-helper modules, which is correct: nothing bundles them. What
 * distinguishes those from `_tracing-otel.ts` is not their names — it is that
 * no published RUNTIME entry reaches them. So the corpus is the transitive
 * graph (static AND dynamic edges, because a bundler inlines both) from each
 * package's `exports`, minus the entries declared test-only in
 * {@link TEST_ONLY_ENTRIES}. A helper that a runtime entry starts reaching
 * fails this gate, which is the true finding it looks like.
 *
 * ## The liveness floors
 *
 * A gate whose healthy output is zero has to prove it looked. Two counts do it:
 * the modules reached (a resolver that silently stops walking prints the same
 * zero as a clean tree) and the DYNAMIC imports of optional peers found in
 * them — six today, and they are the very calls the rule asks authors to write,
 * so a parse that stopped seeing specifiers cannot report a pass.
 *
 *   pnpm check:optional-peers
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { lineIndexOf, parseSource, walk } from "./_ast-scan.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGES = path.join(REPO_ROOT, "packages");

/**
 * Entries whose graph is TEST-ONLY, and therefore out of the corpus.
 *
 * Each one is a subpath a user imports from a spec file and a bundler never
 * follows. Naming them here rather than inferring them is the point: adding a
 * runtime entry to this list is a visible decision, and a subpath that stops
 * existing fails the staleness check below rather than silently widening the
 * exemption.
 */
const TEST_ONLY_ENTRIES = {
  "@alexkroman1/aai": {
    "./testing": "the SDK's test doubles — imported by a project's specs",
    "./testing/vitest": "installs/restores against vitest, by definition",
    "./testing/vite": "the vite plugin a project's specs load",
  },
  "@alexkroman1/aai-runtime": {
    "./testing": "runtime test doubles — imported by a project's specs",
    "./eval": "the eval tier's runner, run by vitest",
    "./eval/vitest": "the eval tier's vitest bindings",
  },
};

/**
 * Dynamic edges into a TEST-ONLY graph, not followed.
 *
 * Keyed by the module that names them, so an exemption is two lines of data
 * rather than a list of the dozen files behind them, and so a NEW edge out of
 * the same module is still checked.
 *
 * Both entries are the body of a loader on `@alexkroman1/aai-runtime/internal`
 * whose only callers are `aai-server`'s platform conformance arms: the case
 * modules on the far side `import { describe, expect, test } from "vitest"`,
 * an optional peer, and `internal.ts` reaches them through `await import()`
 * precisely so a static clause cannot put the runner in `dist/internal.js`
 * (measured there — the published CLI imports a VALUE from that module, and
 * `aai dev` would die on `ERR_MODULE_NOT_FOUND` in any install without vitest).
 *
 * A bundler inlines a dynamic import, which is why this gate follows one at
 * all — but it also tree-shakes an export nobody calls, and no runtime path
 * calls a conformance suite. Measured: `aai-guest/dist/harness.mjs` bundles
 * `/internal` with `codeSplitting: false` and contains no vitest module. The
 * exemption is those two edges and nothing else, so the OTel shape this gate
 * was written for — a loader a shipped feature really calls — is still caught
 * on the same subpath.
 */
const TEST_ONLY_EDGES = {
  "packages/aai-runtime/src/internal.ts": [
    "./workflow/journal/conformance.ts",
    "./session-state-conformance.ts",
  ],
};

/** Floors — see the module doc. Set ~20% under the measured counts. */
const MIN_MODULES = 400;
const MIN_DYNAMIC_PEER_IMPORTS = 4;

/** Every workspace package that declares at least one optional peer. */
function packagesWithOptionalPeers() {
  const found = [];
  for (const dir of readdirSync(PACKAGES)) {
    const manifestPath = path.join(PACKAGES, dir, "package.json");
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    } catch {
      continue;
    }
    const optional = Object.entries(manifest.peerDependenciesMeta ?? {})
      .filter(([, meta]) => meta?.optional === true)
      .map(([name]) => name);
    if (optional.length === 0) continue;
    found.push({ dir: path.join(PACKAGES, dir), manifest, optional });
  }
  return found;
}

/**
 * The `@dev/source` file behind every published subpath, minus the test-only
 * ones — and a hard failure if a declared exemption names a subpath that is
 * gone, since a stale exemption is an exemption nobody can see.
 */
function runtimeEntries({ dir, manifest }) {
  const declared = TEST_ONLY_ENTRIES[manifest.name] ?? {};
  const subpaths = Object.keys(manifest.exports ?? {});
  const stale = Object.keys(declared).filter((sub) => !subpaths.includes(sub));
  const entries = [];
  for (const [subpath, target] of Object.entries(manifest.exports ?? {})) {
    if (subpath in declared) continue;
    const source = typeof target === "object" ? target["@dev/source"] : undefined;
    if (typeof source !== "string") continue;
    entries.push(path.join(dir, source));
  }
  return { entries, stale };
}

/** Does `file` exist as a file? */
function isFile(file) {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/** Resolve a relative specifier the way this repo writes them: with the extension. */
function resolveRelative(from, specifier) {
  const base = path.resolve(path.dirname(from), specifier);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]) {
    if (isFile(candidate)) return candidate;
  }
}

/**
 * Every specifier one module names, split by what a bundler does with it.
 *
 * `TSImportType` — the `typeof import("...")` a type annotation uses — is NOT
 * an `ImportExpression` and never reaches this, which is what lets a module
 * type itself against a peer it only loads dynamically.
 */
/** The specifier a static import/export names, or nothing — type-only included. */
function staticSpecifierOf(node) {
  const isStatic =
    node.type === "ImportDeclaration" ||
    node.type === "ExportNamedDeclaration" ||
    node.type === "ExportAllDeclaration";
  if (!isStatic || typeof node.source?.value !== "string") return;
  // A type-only edge is ERASED, so it is neither a violation nor a way for a
  // bundler to reach the module on the other end — `internal.ts` names a type
  // off a conformance suite exactly that way, and following it would have put
  // every vitest-importing helper in the corpus.
  if (node.importKind === "type" || node.exportKind === "type") return;
  return node.source.value;
}

/** The specifier a dynamic `import()` names, or nothing. */
function dynamicSpecifierOf(node) {
  if (node.type !== "ImportExpression") return;
  return typeof node.source?.value === "string" ? node.source.value : undefined;
}

function specifiersOf(file) {
  const source = readFileSync(file, "utf-8");
  const index = lineIndexOf(source);
  const staticValue = [];
  const dynamic = [];
  const relative = [];
  walk(parseSource(file, source), (node) => {
    const asStatic = staticSpecifierOf(node);
    if (asStatic !== undefined) {
      if (asStatic.startsWith(".")) relative.push(asStatic);
      else staticValue.push({ spec: asStatic, line: index.lineAt(node.start) });
      return;
    }
    const asDynamic = dynamicSpecifierOf(node);
    if (asDynamic === undefined) return;
    if (asDynamic.startsWith(".")) relative.push(asDynamic);
    else dynamic.push(asDynamic);
  });
  return { staticValue, dynamic, relative };
}

/** Is `spec` this peer, or a subpath of it? */
const isPeer = (spec, peer) => spec === peer || spec.startsWith(`${peer}/`);

/** The import chain that put `file` in the corpus, entry first. */
function chainTo(file, reachedBy) {
  const chain = [file];
  for (let at = reachedBy.get(file); at !== undefined; at = reachedBy.get(at)) {
    if (chain.includes(at)) break;
    chain.unshift(at);
  }
  return chain.map((f) => path.basename(f));
}

/** Read one module: what it violates, what it loads lazily, where it leads. */
function visitFile(file, pkg, reachedBy) {
  const { staticValue, dynamic, relative } = specifiersOf(file);
  const violations = staticValue
    .filter(({ spec }) => pkg.optional.some((name) => isPeer(spec, name)))
    .map(({ spec, line }) => ({
      file: path.relative(REPO_ROOT, file),
      line,
      spec,
      via: chainTo(file, reachedBy),
    }));
  const dynamicPeerImports = dynamic.filter((spec) =>
    pkg.optional.some((name) => isPeer(spec, name)),
  ).length;
  const exempt = TEST_ONLY_EDGES[path.relative(REPO_ROOT, file)] ?? [];
  const next = relative
    .filter((spec) => !exempt.includes(spec))
    .map((spec) => resolveRelative(file, spec))
    .filter((resolved) => resolved !== undefined);
  return { violations, dynamicPeerImports, next };
}

/** Walk the graph from `entries`, staying inside the package. */
function scanPackage(pkg) {
  const { entries, stale } = runtimeEntries(pkg);
  const seen = new Set();
  const queue = entries.filter(isFile);
  // Who first reached each module, so a violation can print the CHAIN. The
  // remedy is often to cut an edge rather than to change the import, and the
  // edge is the half that is not in front of the reader.
  const reachedBy = new Map();
  const violations = [];
  let dynamicPeerImports = 0;
  while (queue.length > 0) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    const found = visitFile(file, pkg, reachedBy);
    violations.push(...found.violations);
    dynamicPeerImports += found.dynamicPeerImports;
    for (const resolved of found.next) {
      if (seen.has(resolved)) continue;
      if (!reachedBy.has(resolved)) reachedBy.set(resolved, file);
      queue.push(resolved);
    }
  }
  return { entries, stale, modules: seen.size, violations, dynamicPeerImports };
}

/**
 * Every declared exemption still names an edge that EXISTS.
 *
 * A dead exemption is the same defect as a stale test-only entry: it is an
 * unenforced line nobody can see, and the day the module grows a new dynamic
 * import with the old name, it would apply to that one instead.
 */
function staleExemptions() {
  const stale = [];
  for (const [file, specifiers] of Object.entries(TEST_ONLY_EDGES)) {
    const full = path.join(REPO_ROOT, file);
    // The PARSE, not a substring: Biome wraps `await import(\n "./x.ts"\n)`
    // the moment the destructuring in front of it is long enough, and a
    // matcher that could not see that shape would report every exemption dead.
    const named = isFile(full) ? specifiersOf(full).relative : [];
    for (const spec of specifiers) {
      if (!named.includes(spec)) stale.push(`${file} → ${spec}`);
    }
  }
  return stale;
}

console.log("check-optional-peers: static imports of an optional peer, from a published entry\n");

let failed = false;
for (const dead of staleExemptions()) {
  failed = true;
  console.error(
    `\ncheck-optional-peers: TEST_ONLY_EDGES exempts ${dead}, which no longer exists.\n` +
      "Delete the entry — an exemption nobody can see is one nobody re-decided.\n",
  );
}
let modules = 0;
let dynamicPeerImports = 0;
const allViolations = [];

for (const pkg of packagesWithOptionalPeers()) {
  const result = scanPackage(pkg);
  modules += result.modules;
  dynamicPeerImports += result.dynamicPeerImports;
  allViolations.push(...result.violations.map((v) => ({ ...v, pkg: pkg.manifest.name })));
  console.log(
    `  ${pkg.manifest.name.padEnd(26)} entries=${String(result.entries.length).padStart(2)} ` +
      `modules=${String(result.modules).padStart(4)} peers=${pkg.optional.length} ` +
      `dynamic=${result.dynamicPeerImports} static=${result.violations.length}`,
  );
  for (const subpath of result.stale) {
    failed = true;
    console.error(
      `\ncheck-optional-peers: ${pkg.manifest.name} has no "${subpath}" export, but ` +
        "TEST_ONLY_ENTRIES still exempts it.\nDelete the entry — a stale exemption is one " +
        "nobody can see.\n",
    );
  }
}

if (allViolations.length > 0) {
  failed = true;
  console.error(
    "\ncheck-optional-peers: a published entry reaches a static import of an optional peer:\n",
  );
  for (const { pkg, file, line, spec, via } of allViolations) {
    console.error(`  ${file}:${line}  imports ${spec}  (optional peer of ${pkg})`);
    console.error(`      reached by  ${via.join(" → ")}`);
  }
  console.error(
    [
      "",
      "A consumer bundles these packages with `noExternal` and no code splitting, which",
      "inlines dynamic imports — so this static import has to RESOLVE at their build time,",
      "against a project that never installed the peer. Vite substitutes a stub that exports",
      "nothing and every named binding becomes a [MISSING_EXPORT] build failure.",
      "",
      "Destructure it off an `await import(...)` of the same specifier instead.",
      "A dynamic import is not export-checked, so the missing peer surfaces where it",
      "belongs: when the feature is switched on. Or use `import type`, if the types",
      "are all that is wanted.",
      "See `aai-runtime/_tracing-otel.ts` for the worked shape.",
      "",
    ].join("\n"),
  );
}

if (modules < MIN_MODULES) {
  failed = true;
  console.error(
    `\ncheck-optional-peers: reached only ${modules} modules, under the floor of ${MIN_MODULES}.\n` +
      "That is not a pass — the entries or the relative-import resolution stopped working, so\n" +
      "a violation count of zero means nothing. Check the `@dev/source` conditions.\n",
  );
}

if (dynamicPeerImports < MIN_DYNAMIC_PEER_IMPORTS) {
  failed = true;
  console.error(
    `\ncheck-optional-peers: found ${dynamicPeerImports} dynamic imports of an optional peer, ` +
      `under the floor of ${MIN_DYNAMIC_PEER_IMPORTS}.\nThose are the calls this gate asks ` +
      "authors to write; seeing none means the parse stopped seeing specifiers.\n",
  );
}

if (failed) process.exit(1);
console.log(
  `\n  ok — ${modules} modules reached, ${dynamicPeerImports} optional peers loaded dynamically, 0 statically\n`,
);
