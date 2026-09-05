// Copyright 2026 the AAI authors. MIT license.
/**
 * Every contracted authoring capability is NAMED in the guide that ships to
 * users.
 *
 *   pnpm check:authoring-guide
 *
 * `packages/aai-templates/scaffold/CLAUDE.md` is the one source of truth for
 * how to write an aai agent. `sync-agent-guide.mjs` materializes it as
 * `packages/aai/AGENT_GUIDE.md` so it ships inside the SDK tarball, which is
 * where a scaffolded project's `CLAUDE.md` points and where an agent reads it. `check:agent-guide` already asserts
 * those two copies agree — that the guide is CURRENT. Nothing asserted it was
 * COMPLETE, and it was not: eleven of `aai`'s twenty-six capabilities and two
 * of `aai-ui`'s nine appeared in it nowhere, including `/step-errors` (twelve
 * exports, imported by nineteen template files), both remaining top-level
 * declaration verbs (`procedure()`, `dialog()`), and the whole `forms` surface.
 *
 * That is the third definition of "the authoring surface" this repo carried,
 * and the only one an author actually reads. `check:api-contracts` versions a
 * capability, `template-api-coverage.test.ts` demands a worked example for its
 * exports, and this demands that the guide say it exists — the three now read
 * the same tree.
 *
 * ## What counts as named
 *
 * At least one of the capability's CURRENT-EPOCH export names, appearing as a
 * whole word in the guide's CODE — a fenced block or an inline `span`. Prose is
 * deliberately excluded: half these capability names are ordinary English
 * (`agent`, `state`, `tools`, `channels`), so a prose match would let a
 * capability pass on a sentence that is not about it. A guide that shows the
 * name in code is a guide an author can act on.
 *
 * It is a FLOOR, not a quality bar. One name is enough to pass, which will
 * sometimes be one line where a section is owed — but a floor that fails when a
 * capability is wholly absent is the failure worth catching, and grading prose
 * is not something a gate can do.
 *
 * ## Scope is derived, and so is its edge
 *
 * A capability is in scope when at least one of its names is published on an
 * EXAMPLE-FACING subpath (`exampleFacingSubpaths`, `_api-contracts-tree.mjs`) —
 * the same set the template coverage ratchet uses. That is what keeps the
 * fourteen host-embedding capabilities of `aai-runtime` out without a list:
 * this guide is written for someone authoring an agent, not for someone
 * embedding the runtime, and `eval` is in scope precisely because every
 * template ships an `agent.eval.test.ts`.
 *
 * The scope test reads the committed `API-EXPORTS.json`, which is what makes
 * this a pure fs check with no build behind it. `check:api-report --check`
 * separately guarantees that file is current, and `check.mjs` and the CI check
 * job both run this after it for that reason.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  capabilities,
  capabilityId,
  contractPackages,
  exampleFacingSubpaths,
  ROOT,
  readEpoch,
  readTable,
  rel,
} from "./_api-contracts-tree.mjs";

/** The guide this gate is about — the one `aai init` puts in a user's project. */
const GUIDE_PATH = join(ROOT, "packages/aai-templates/scaffold/CLAUDE.md");

/** The committed export surface, keyed by module specifier. */
const EXPORTS_PATH = join(ROOT, "API-EXPORTS.json");

/** Where the workspace packages live — the corpus `publishedSpecifiers` reads. */
const PACKAGES_ROOT = join(ROOT, "packages");

/**
 * Capabilities that reach the example-facing surface but are NOT the shipped
 * guide's job, and why.
 *
 * A DENY-list, keyed `<package>:<capability>`, for the reason both lists in
 * `_api-contracts-tree.mjs` are: a new capability defaults into needing a
 * mention, and an entry here is a decision somebody wrote down. A stale entry
 * is a hard failure below.
 */
const UNDOCUMENTED_CAPABILITIES = {
  "aai-runtime:logging":
    "the HOST logging surface — the buffer/page/line constants a deployment tunes and " +
    "`consoleLogger`. It reaches the example-facing set the same way `aai-runtime:runtime` " +
    "below does and through the same subpath: `@alexkroman1/aai-runtime/eval` re-publishes " +
    "`Logger` and its three companions because `EvalSessionOptions.logger` takes one, so a " +
    "case can collect lines and assert on them. Nothing else in it is written from an " +
    "`agent.ts` — an agent author never sizes a log buffer — and its own documentation is " +
    "`packages/aai-runtime/CLAUDE.md`.",
  "aai-runtime:runtime":
    "the host embedding surface — `createRuntime`, `Runtime`, `SessionRuntime`. It reaches " +
    "the example-facing set through exactly one name, `RunCodeExecutor`, which " +
    "`@alexkroman1/aai-runtime/eval` re-publishes so an eval can supply a code executor. " +
    "Nothing in it is written from an `agent.ts`, and its own documentation is " +
    "`packages/aai-runtime/CLAUDE.md` plus the compatibility example that package keeps as a " +
    "starter for a host to copy.",
};

/**
 * Floors, set under the measured actuals.
 *
 * This gate's whole success output is a count, which is the shape this repo
 * keeps paying for: an extractor that stopped matching would find zero
 * capabilities, zero code spans, and print a checkmark. Measured at the time of
 * writing: 37 in-scope capabilities, 1,043 code spans.
 */
const MIN_CAPABILITIES = 30;
const MIN_CODE_SPANS = 600;
/**
 * Distinct `@alexkroman1/…` specifiers named in the guide's code. Measured at
 * the time of writing: 22.
 */
const MIN_CITED_SPECIFIERS = 15;

/**
 * The guide's CODE, as one string: every fenced block plus every inline span.
 *
 * Both, because the guide teaches in both — a subpath is usually an inline
 * `@alexkroman1/aai/step-errors` and a call is usually a fence — and a rule
 * that took only fences would fail a capability the guide names perfectly well.
 */
function codeSpans(markdown) {
  const fences = [...markdown.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map((match) => match[1]);
  // Inline spans are matched AFTER fences are removed, so a backtick pair
  // inside a code block cannot be counted twice or straddle its edges.
  const withoutFences = markdown.replace(/```[^\n]*\n[\s\S]*?```/g, "\n");
  const inline = [...withoutFences.matchAll(/`([^`\n]+)`/g)].map((match) => match[1]);
  return { spans: [...fences, ...inline], text: [...fences, ...inline].join("\n") };
}

/** Whether `name` appears in `text` as a whole identifier. */
function namesIdentifier(text, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9_$])${escaped}([^A-Za-z0-9_$]|$)`).test(text);
}

/** Every export name reachable from a package's example-facing subpaths. */
function exampleFacingNames(pkg, exportsByPath) {
  const names = new Set();
  for (const specifier of Object.keys(exampleFacingSubpaths(pkg))) {
    for (const name of exportsByPath[specifier] ?? []) names.add(name);
  }
  return names;
}

/**
 * Every specifier any workspace package actually exports, read from the
 * `exports` maps themselves rather than from `API-EXPORTS.json`.
 *
 * The export map is the thing Node resolves against, and it is strictly wider
 * than the typed entry points: `@alexkroman1/aai-ui/styles` is a stylesheet and
 * `@alexkroman1/aai-cli` has no API report at all, yet the guide names both
 * correctly. Checking against the reports would have failed all three.
 */
function publishedSpecifiers() {
  const specifiers = new Set();
  for (const dir of readdirSync(PACKAGES_ROOT)) {
    const manifest = join(PACKAGES_ROOT, dir, "package.json");
    if (!existsSync(manifest)) continue;
    const { name, exports } = JSON.parse(readFileSync(manifest, "utf8"));
    if (!name) continue;
    for (const key of Object.keys(exports ?? { ".": true })) {
      if (key.includes("*")) continue;
      specifiers.add(key === "." ? name : `${name}/${key.replace(/^\.\//, "")}`);
    }
  }
  return specifiers;
}

/** Every in-scope capability, with the names that would satisfy it. */
function inScopeCapabilities(exportsByPath) {
  const found = [];
  for (const pkg of contractPackages()) {
    const facing = exampleFacingNames(pkg, exportsByPath);
    const table = readTable(pkg);
    for (const capability of capabilities(pkg)) {
      const entry = table[capability];
      if (!entry) continue;
      const names = readEpoch(pkg, capability, entry.current).exports ?? [];
      if (!names.some((name) => facing.has(name))) continue;
      found.push({ id: capabilityId(pkg, capability), names });
    }
  }
  return found;
}

const exportsByPath = JSON.parse(readFileSync(EXPORTS_PATH, "utf8"));
const guide = readFileSync(GUIDE_PATH, "utf8");
const { spans, text } = codeSpans(guide);
const scoped = inScopeCapabilities(exportsByPath);

const problems = [];

if (scoped.length < MIN_CAPABILITIES) {
  problems.push(
    `Only ${scoped.length} in-scope capabilities found (floor ${MIN_CAPABILITIES}). The ` +
      "contract tree or API-EXPORTS.json stopped resolving — this gate cannot report anything " +
      "useful until that is fixed.",
  );
}
if (spans.length < MIN_CODE_SPANS) {
  problems.push(
    `Only ${spans.length} code spans found in ${rel(GUIDE_PATH)} (floor ${MIN_CODE_SPANS}). ` +
      "The fence/inline extractor stopped matching, so every capability below would report as " +
      "undocumented for the wrong reason.",
  );
}

// Every `@alexkroman1/…` specifier the guide's CODE names must be a real
// subpath. The guide sent authors to `@alexkroman1/aai/transcribe` for months:
// `package.json` has no such key and no wildcard, so the import throws
// `ERR_PACKAGE_PATH_NOT_EXPORTED`. It survived because it is PROSE-adjacent —
// `check-doc-examples` only compiles fenced `ts` blocks, and 28 of this guide's
// 47 fences are `no-check` — while every generated artifact in the repo
// (`etc/*.api.md`, the epochs, API-EXPORTS.json) knew the true list all along.
const KNOWN_SPECIFIERS = publishedSpecifiers();
// Only specifiers in an IMPORT position. A bare package name is also how the
// guide spells `npx @alexkroman1/aai-cli init` and a `node_modules/...` path,
// neither of which Node ever resolves as a subpath — scoping to what an author
// would copy into an import is what keeps this gate from reporting those three.
const citedSpecifiers = [
  ...new Set(
    [...text.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)["'](@alexkroman1\/[^"']+)["']/g)].map(
      (match) => match[1],
    ),
  ),
];
if (citedSpecifiers.length < MIN_CITED_SPECIFIERS) {
  problems.push(
    `Only ${citedSpecifiers.length} package specifiers found in the guide's code (floor ` +
      `${MIN_CITED_SPECIFIERS}). The extractor stopped matching, so no unresolvable subpath ` +
      "below could be reported.",
  );
}
const unresolvable = citedSpecifiers.filter((one) => !KNOWN_SPECIFIERS.has(one));
if (unresolvable.length > 0) {
  problems.push(
    `${unresolvable.length} specifier(s) the guide names in code are not exported by any ` +
      "package, so the import an author copies throws ERR_PACKAGE_PATH_NOT_EXPORTED:\n" +
      unresolvable.map((one) => `  ${one}`).join("\n") +
      "\n\nUse a specifier the owning package's `exports` map actually declares.",
  );
}

const scopedIds = new Set(scoped.map((one) => one.id));
const staleExemptions = Object.keys(UNDOCUMENTED_CAPABILITIES).filter((id) => !scopedIds.has(id));
if (staleExemptions.length > 0) {
  problems.push(
    `UNDOCUMENTED_CAPABILITIES exempts ${staleExemptions.join(", ")}, which is no longer an ` +
      `in-scope capability. Remove the entry from ${rel(join(ROOT, "scripts/check-authoring-guide.mjs"))} — ` +
      "a stale exemption silently keeps a live capability out of this gate.",
  );
}

const undocumented = scoped
  .filter((one) => !Object.hasOwn(UNDOCUMENTED_CAPABILITIES, one.id))
  .filter((one) => !one.names.some((name) => namesIdentifier(text, name)));

if (undocumented.length > 0) {
  problems.push(
    `${undocumented.length} contracted authoring capability(ies) are named nowhere in the code ` +
      `of ${rel(GUIDE_PATH)}. That guide ships inside every \`aai init\` project and inside the ` +
      "SDK tarball, so a capability absent from it is one an author cannot find:\n" +
      undocumented
        .map((one) => `  ${one.id} — e.g. ${one.names.slice(0, 4).join(", ")}`)
        .join("\n") +
      "\n\nDocument it, or record it in UNDOCUMENTED_CAPABILITIES with a reason.",
  );
}

if (problems.length > 0) {
  console.error(`check-authoring-guide: ${problems.length} problem(s).\n`);
  for (const problem of problems) console.error(`${problem}\n`);
  process.exit(1);
}

const exempt = Object.keys(UNDOCUMENTED_CAPABILITIES).length;
console.log(
  `check-authoring-guide: all ${scoped.length - exempt} in-scope capability(ies) are named in ` +
    `${rel(GUIDE_PATH)}${exempt > 0 ? ` (${exempt} exempt)` : ""}. ✓`,
);
