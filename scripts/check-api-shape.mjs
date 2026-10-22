#!/usr/bin/env node
// Copyright 2026 the AAI authors. MIT license.
/**
 * `pnpm check:api-shape` — the shapes on the contracted surface that keep
 * producing breaking changes, held to a shrink-only baseline PER PACKAGE.
 *
 * What each guard measures, and why, is `_api-shape.mjs`'s header (G1–G5);
 * this is the reading of the tree and the ratchet around it. One more guard is
 * here because it needs a compiler rather than a report:
 *
 * - **isolatedDeclarations**: `dist/*.d.ts` is emitted by `tsc` 7, so a type it
 *   INFERS for an exported function is reprinted by whatever the next compiler
 *   prints — a contract move nobody wrote. `tsc --isolatedDeclarations` names
 *   every exported declaration without an explicit type; the count per file
 *   may only fall. (Turning the flag on in the three tsconfigs failed 531 times
 *   when this landed — 350 `aai`, 29 `aai-ui`, 152 `aai-runtime` — hence a
 *   ratchet rather than the flag.)
 *
 * Reads the COMMITTED `etc/*.api.md` (fresh by `check:api-report`) and the
 * contract entry points, so it needs no build and runs with the ratchets.
 *
 * The baseline is `packages/<pkg>/src/contracts/api-shape-baseline.json`, one
 * per package so the per-package follow-up PRs that shrink it cannot conflict.
 * Every list is one entry per line: paying an entry down is deleting its line.
 * `exhaustiveByDesign` is the one permanent list — a closed literal set the
 * author is MEANT to switch over exhaustively, each with a reason.
 *
 *   node scripts/check-api-shape.mjs            # the gate
 *   node scripts/check-api-shape.mjs --update   # lower the baselines (never raises)
 *   node scripts/check-api-shape.mjs --seed     # write a MISSING baseline from the tree
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { parseEntrypoint } from "./_api-contracts.mjs";
import { packageOf } from "./_api-contracts-imports.mjs";
import {
  authoringSubpaths,
  contractPackages,
  isMirror,
  nonAuthoringSubpaths,
  ROOT,
  readJson,
  readTable,
  rel,
  writeJson,
} from "./_api-contracts-tree.mjs";
import { DEFAULT_BUDGET, indexSurface, shapeFindings } from "./_api-shape.mjs";
import { reportSource, stripPackageDocumentationMarker } from "./_api-surface.mjs";
import { parseScriptArgs } from "./_args.mjs";

const { values: FLAGS } = parseScriptArgs({
  script: import.meta.url,
  options: { update: { type: "boolean" }, seed: { type: "boolean" } },
});

/** Each list guard: what a finding means, and the fix the message names. */
const GUARDS = {
  direction: {
    what: "G1 — exported object type with no direction tag",
    fix:
      "tag it `@input` (an author builds it, the SDK only reads it) or `@sealed` (the SDK " +
      "builds it, an author only reads it) in its doc comment, then `pnpm api-report`.",
  },
  positions: {
    what: "G1 — type reached as input AND output, or tagged against where it is reached",
    fix: "split it into an `@input` type and a `@sealed` one, or correct the tag.",
  },
  derived: {
    what: "G1 — exported alias cut from another object type (Omit/Pick/Partial/Required)",
    fix: "declare the shape on its own (tagged `@input` or `@sealed`) instead of deriving it.",
  },
  closedLiterals: {
    what: "G2 — closed literal set an author receives",
    fix:
      "type a const as its element (`readonly string[]`), open a union with `| (string & {})`, " +
      "or — only when an exhaustive switch is the point — list it in `exhaustiveByDesign` " +
      "with a reason.",
  },
  nonAuthoringImports: {
    what: "G3 — contracted signature reaching a non-authoring subpath",
    fix:
      "move the name to an authoring subpath (and a capability), or stop naming it in a " +
      "contracted signature — the hash sees only its name.",
  },
  thirdPartyTypes: {
    what: "G4 — third-party type in a contracted signature",
    fix:
      "wrap it in a type this package declares, or allow the module in THIRD_PARTY_ALLOWED " +
      "(`scripts/_api-shape.mjs`) with a reason.",
  },
  orphans: {
    what: "G4 — contracted type no contracted function/const/class reaches",
    fix: "move it to `/internal`, or drop it from its capability's entry point.",
  },
  unexportedShared: {
    what: "G5 — unexported declaration hashed into more than one capability",
    fix:
      "export it from the subpath of the capability that should own it and select it there " +
      "(then its siblings hash only its name), or inline it.",
  },
};

const COMMENT =
  "check:api-shape's shrink-only baseline (scripts/check-api-shape.mjs). Each list is one " +
  "finding per line — delete the line when it is fixed; `pnpm api-shape:update` drops fixed " +
  "entries and lowers numbers but never adds. `exhaustiveByDesign` is a permanent allowlist " +
  "(entry -> reason) for closed literal sets an author is meant to switch over exhaustively.";

/** One package's committed report bodies for its authoring subpaths. */
function readReports(pkg) {
  return Object.values(authoringSubpaths(pkg)).map((slug) => {
    const path = join(pkg.dir, "etc", `${slug}.api.md`);
    if (!existsSync(path)) {
      throw new Error(`${rel(path)} is missing — run \`pnpm api-report\` first.`);
    }
    const label = rel(path);
    return {
      slug,
      body: stripPackageDocumentationMarker(reportSource(readFileSync(path, "utf8"), label)),
    };
  });
}

/** Per-file counts of `tsc --isolatedDeclarations` findings for one package. */
function isolatedDeclarations(pkg) {
  let output = "";
  try {
    execFileSync(
      join(ROOT, "node_modules/.bin/tsc"),
      ["-p", "tsconfig.build.json", "--isolatedDeclarations", "--noEmit", "--pretty", "false"],
      { cwd: pkg.dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (error) {
    output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
  }
  const counts = {};
  for (const match of output.matchAll(/^(.+?)\(\d+,\d+\): error TS9\d{3}:/gm)) {
    const file = `packages/${pkg.key}/${match[1]}`;
    counts[file] = (counts[file] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort());
}

function measure(pkg) {
  const table = readTable(pkg);
  const capabilityNames = new Map(
    Object.entries(table)
      .filter(([, contract]) => !isMirror(contract))
      .map(([capability]) => [capability, parseEntrypoint(pkg, capability).names]),
  );
  const isWorkspace = (module) => module.startsWith("@alexkroman1/");
  const nonAuthoring = (module) => {
    if (!isWorkspace(module)) return false;
    const name = packageOf(module);
    const key = name.slice("@alexkroman1/".length);
    const sub = module === name ? "." : `.${module.slice(name.length)}`;
    return nonAuthoringSubpaths(key).includes(sub);
  };
  const surface = indexSurface(readReports(pkg));
  return {
    ...shapeFindings(surface, capabilityNames, { nonAuthoring, isWorkspace }),
    isolatedDeclarations: isolatedDeclarations(pkg),
  };
}

const readBaseline = (pkg) =>
  existsSync(pkg.shapeBaselinePath) ? readJson(pkg.shapeBaselinePath) : undefined;

function lowered(baseline, found) {
  const next = { ...baseline };
  for (const key of Object.keys(GUARDS)) {
    const live = new Set(found[key]);
    next[key] = (baseline[key] ?? []).filter((entry) => live.has(entry));
  }
  next.budgets = {};
  for (const [capability, budget] of Object.entries(baseline.budgets ?? {})) {
    const now = found.budgets[capability];
    if (now === undefined) continue;
    next.budgets[capability] = {
      exports: Math.min(budget.exports, Math.max(now.exports, DEFAULT_BUDGET.exports)),
      lines: Math.min(budget.lines, Math.max(now.lines, DEFAULT_BUDGET.lines)),
    };
  }
  next.isolatedDeclarations = {};
  for (const [file, count] of Object.entries(baseline.isolatedDeclarations ?? {})) {
    const now = found.isolatedDeclarations[file] ?? 0;
    if (now > 0) next.isolatedDeclarations[file] = Math.min(count, now);
  }
  const allowed = baseline.exhaustiveByDesign ?? {};
  const live = new Set(found.closedLiterals);
  next.exhaustiveByDesign = Object.fromEntries(
    Object.entries(allowed).filter(([entry]) => live.has(entry)),
  );
  return next;
}

function seeded(found) {
  const out = { comment: COMMENT, exhaustiveByDesign: {} };
  for (const key of Object.keys(GUARDS)) out[key] = found[key];
  out.budgets = found.budgets;
  out.isolatedDeclarations = found.isolatedDeclarations;
  return out;
}

/** The list guards: a finding not baselined (or allowed) fails; a fixed one warns. */
function compareLists(baseline, found, out) {
  const allowed = baseline.exhaustiveByDesign ?? {};
  for (const [key, guard] of Object.entries(GUARDS)) {
    const known = new Set(baseline[key] ?? []);
    const added = found[key].filter(
      (entry) => !(known.has(entry) || Object.hasOwn(allowed, entry)),
    );
    if (added.length > 0) {
      out.failures.push(
        `${guard.what} (${added.length} new):\n    ${added.join("\n    ")}\n  Fix: ${guard.fix}`,
      );
    }
    const live = new Set(found[key]);
    for (const entry of baseline[key] ?? [])
      if (!live.has(entry)) out.stale.push(`${key}: ${entry}`);
  }
  for (const entry of Object.keys(allowed)) {
    if (!found.closedLiterals.includes(entry)) out.stale.push(`exhaustiveByDesign: ${entry}`);
  }
}

/** G4 budgets: a capability over max(baseline, default) fails; one below its baseline warns. */
function compareBudgets(pkg, baseline, found, out) {
  for (const [capability, now] of Object.entries(found.budgets)) {
    const cap = baseline.budgets?.[capability] ?? DEFAULT_BUDGET;
    for (const measure of ["exports", "lines"]) {
      const limit = Math.max(cap[measure], DEFAULT_BUDGET[measure]);
      if (now[measure] > limit) {
        out.failures.push(
          `G4 — ${pkg.key}:${capability} has ${now[measure]} ${measure}, over its budget of ${limit}.\n` +
            "  Fix: split the capability, or move what an author does not write against to `/internal`.",
        );
      } else if (now[measure] < cap[measure] && cap[measure] > DEFAULT_BUDGET[measure]) {
        out.stale.push(`budgets: ${capability} ${measure} ${cap[measure]} -> ${now[measure]}`);
      }
    }
  }
  for (const capability of Object.keys(baseline.budgets ?? {})) {
    if (found.budgets[capability] === undefined) {
      out.stale.push(`budgets: ${capability} (within default)`);
    }
  }
}

/** isolatedDeclarations: a file over its count fails; one under it warns. */
function compareIsolated(baseline, found, out) {
  const budget = baseline.isolatedDeclarations ?? {};
  const grown = Object.entries(found.isolatedDeclarations).filter(
    ([file, count]) => count > (budget[file] ?? 0),
  );
  if (grown.length > 0) {
    out.failures.push(
      "isolatedDeclarations — exported declarations whose type tsc INFERS:\n    " +
        grown
          .map(([file, count]) => `${file}: ${count} (baseline ${budget[file] ?? 0})`)
          .join("\n    ") +
        "\n  Fix: give each exported function an explicit return type and each exported const " +
        "an explicit type; `tsc -p tsconfig.build.json --isolatedDeclarations --noEmit` in the " +
        "package names the lines.",
    );
  }
  for (const [file, count] of Object.entries(budget)) {
    const now = found.isolatedDeclarations[file] ?? 0;
    if (now < count) out.stale.push(`isolatedDeclarations: ${file} ${count} -> ${now}`);
  }
}

/** Growth (fails) and headroom (warns), for one package. */
function compare(pkg, baseline, found) {
  const out = { failures: [], stale: [] };
  compareLists(baseline, found, out);
  compareBudgets(pkg, baseline, found, out);
  compareIsolated(baseline, found, out);
  return out;
}

const packages = contractPackages();
if (packages.length === 0) {
  console.error("check-api-shape: no contract package found — has the tree moved?");
  process.exit(1);
}

let failed = false;
const summary = [];
for (const pkg of packages) {
  const found = measure(pkg);
  const baseline = readBaseline(pkg);
  if (FLAGS.seed === true) {
    if (baseline !== undefined) {
      console.error(
        `check-api-shape: ${rel(pkg.shapeBaselinePath)} exists; --seed only writes a MISSING ` +
          "baseline (raising one is a reviewed hand edit).",
      );
      process.exit(1);
    }
    writeJson(pkg.shapeBaselinePath, seeded(found));
    console.log(`check-api-shape: seeded ${rel(pkg.shapeBaselinePath)}`);
    continue;
  }
  if (baseline === undefined) {
    console.error(`check-api-shape: ${rel(pkg.shapeBaselinePath)} is missing.`);
    failed = true;
    continue;
  }
  if (FLAGS.update === true) {
    writeJson(pkg.shapeBaselinePath, lowered(baseline, found));
    console.log(`check-api-shape: lowered ${rel(pkg.shapeBaselinePath)}`);
    continue;
  }
  const { failures, stale } = compare(pkg, baseline, found);
  if (failures.length > 0) {
    failed = true;
    console.error(
      `\ncheck-api-shape: ${pkg.name} grew (baseline ${rel(pkg.shapeBaselinePath)}; findings ` +
        `name <capability>: <symbol>, declared in packages/${pkg.key}/etc/*.api.md):\n\n  ` +
        failures.join("\n\n  "),
    );
  }
  if (stale.length > 0) {
    console.warn(
      `\ncheck-api-shape: ${stale.length} baselined finding(s) in ${pkg.name} are fixed — give ` +
        `the headroom back with \`pnpm api-shape:update\`:\n  ${stale.join("\n  ")}`,
    );
  }
  const total =
    Object.keys(GUARDS).reduce((sum, key) => sum + found[key].length, 0) +
    Object.values(found.isolatedDeclarations).reduce((sum, n) => sum + n, 0);
  summary.push(`${pkg.name}: ${total} baselined finding(s)`);
}

if (failed) process.exit(1);
if (FLAGS.seed !== true && FLAGS.update !== true) {
  console.log(`check-api-shape: no shape grew. ✓\n  ${summary.join("\n  ")}`);
}
