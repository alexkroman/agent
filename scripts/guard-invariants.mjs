#!/usr/bin/env node

/**
 * Mechanical enforcement of repo invariants.
 *
 * Most of AGENTS.md is a rule with a story attached — "use `p-timeout`, never a
 * hand-rolled `Promise.race`", "reach for `vi.stubEnv(name, undefined)` rather
 * than `delete process.env.X`" — and each story is there because the rule was
 * learned by getting it wrong. But prose is only enforcement while somebody
 * remembers it at review time, and the guide is 78k characters. Every rule here
 * is one that used to live only in that file.
 *
 * Each guard prints WHY the invariant exists and what to do instead, so a
 * violation is self-correcting and a reviewer never has to re-explain it. The
 * numeric IDs are stable identifiers: a rule that is deleted leaves its number
 * retired rather than letting a later rule inherit it, because the numbers show
 * up in commit messages and in `guard-invariants-baseline.json`.
 *
 *   rule 1  — No symlinks anywhere in the repo. They do not survive the paths
 *             this code takes: an npm tarball, `aai init`'s scaffold copy, and
 *             the Modal guest image are three different archivers with three
 *             different symlink behaviours, and a link that resolves in a
 *             checkout can arrive dangling or as a 12-byte text file. Use a
 *             real file, or a module that re-exports.
 *   rule 2  — No spread-ternary object composition
 *             (`...(x !== undefined ? { x } : {})`). Use `omitUndefined()`
 *             from `@alexkroman1/aai/utils`. It is the shape
 *             `exactOptionalPropertyTypes` forces, it was hand-written 44
 *             times, and each line names its key twice — so a mismatched pair
 *             (`x !== undefined ? { y: x }`) reads as noise rather than as the
 *             bug it is. Baselined where the GUARD IS NOT THE VALUE, which is
 *             the one case `omitUndefined` cannot express.
 *   rule 3  — No `Promise.race` against a `setTimeout`. Use `p-timeout`, a
 *             dependency of all four packages that need one. The losing
 *             branch's late rejection and the timer cleanup are exactly what
 *             gets re-derived wrong. A `Promise.race` with no timer in it is
 *             fine and common (`raceGuestExit` races a process exit) — this
 *             rule is about the hand-rolled timeout, not the race.
 *   rule 4  — No inline `new Promise(r => setTimeout(r, 0))` in a test. Use
 *             `flush()` (microtask) or `tick()` (macrotask) from
 *             `aai/host/_test-utils.ts`. Spelled inline it is ambiguous about
 *             which one it meant, and the repo has already had a LOCAL `flush`
 *             defined this way shadowing the shared export, so one name meant
 *             two different waits.
 *   rule 5  — No `delete process.env.X`. Use `vi.stubEnv(name, undefined)`,
 *             which `unstubEnvs` reverses before each test. Hand-rolled
 *             save-and-restore is what rots: `deepgram.test.ts` wrote back a
 *             captured `undefined`, which env coercion turns into the STRING
 *             "undefined" for every later test in the file.
 *   rule 6  — No `ctx.state as SomeType` cast inside a template. Use
 *             `sessionSlot()`, which is the typed seam that exists because all
 *             five stateful templates had taken this cast — `tool()` learns the
 *             state shape only from an annotated context, so every module
 *             either restates the annotation or casts. Host tests may cast:
 *             they drive an inline agent that has no slot.
 *   rule 7  — Every `uses:` in `.github/workflows` is pinned to a 40-character
 *             commit SHA. A tag is a mutable pointer, so `@v7` grants every
 *             future version of that code the permissions of the job it runs
 *             in — including the release job's npm token.
 *   rule 8  — No hand-rolled owned-map eviction
 *             (`if (m.get(k) === mine) m.delete(k)`). Use `createOwnedMap()`.
 *             The case it exists for is an async teardown settling after the
 *             key was re-claimed (reconnect resume, redeploy), which evicts the
 *             successor's entry.
 *   rule 9  — No hand-rolled per-key promise chain
 *             (`tails.get(k) ?? Promise.resolve()`). Use `createKeyedLock()`,
 *             or `slot.update` for the `ctx.state` case. The two parts that get
 *             missed are dropping the drained entry BY OWNERSHIP and resolving
 *             your own place in the chain when you abandon a timed-out acquire.
 *   rule 10 — Every Markdown file under `research/` has YAML frontmatter with
 *             non-empty `issue` and `status` and an ISO `last_updated`.
 *             Research documents are implementation plans attached to tracked
 *             work, not an unowned parallel backlog. *   rule 11 — No hardcoded `/tmp` path in shipped source. On Windows `/tmp/x` is
 *             DRIVE-RELATIVE and resolves to `D:\tmp\x`, which does not exist,
 *             so the write fails with ENOENT. Use `join(tmpdir(), …)`. Two
 *             shipped modules had it and both run on a developer's own machine
 *             under `aai dev`. Baselined only for `modal-agent-sandbox.ts`,
 *             whose paths name a location INSIDE the Linux sandbox.
 *   rule 12 — Every route literal in the guest's own dispatch is declared in
 *             `GUEST_ROUTES` (`packages/aai-server/guest-routes.ts`). The
 *             exposure table is verified against the PLATFORM; its upstream
 *             half is transcribed by hand and nothing checked it, which is how
 *             `GET /studio/tools` came to be a real guest route in neither
 *             table. `aai-server` may not import guest source, so this reads
 *             both trees as text.
 *   rule 13 — No import in a template escapes its own template directory. A
 *             template SHIPS: `aai init` copies `templates/<name>/` and nothing
 *             above it comes along, so the import resolves here and in nothing a
 *             user runs.
 *   rule 14 — No fixture directory that no code file resolves a path to. The
 *             pinned RPC fixtures in `aai-server` outlived their only reader by
 *             five commits, with a README telling the next reader never to delete
 *             them and a `turbo.json` comment citing them by name as a reason the
 *             test task must hash JSON. A reference has to RESOLVE rather than
 *             match the name — the string that made the dead directory look read
 *             belonged to a different package's sibling.
 *   rule 15 — reserved.
 *   rule 16 — No new `on*` callback on the SESSION's own surfaces. A transport
 *             reports a `TransportEventBody` and the session takes one, both in
 *             the protocol's own event vocabulary, so a new thing worth observing
 *             is a union member in `sdk/protocol-events.ts` rather than a name
 *             threaded through `session-core.ts`, `transports/types.ts`,
 *             `runtime-session-callbacks.ts` and four harnesses. That threading
 *             is what put 157 of these across eleven files, 78 of them in test
 *             doubles whose only job was to satisfy the shape. A name is
 *             legitimate exactly when there is NO EVENT for it — binary audio,
 *             `reply.started` (which the wire does not have), and the lifecycle
 *             hooks a caller must ACT on — and the baseline is those.
 *
 * Baselines for rules with pre-existing violations live in
 * `guard-invariants-baseline.json`. Counts there may only SHRINK. `--update`
 * lowers them for you and refuses to raise any, so recording a removal is one
 * command and blessing an addition needs a hand edit that shows up in review —
 * the same contract as `check-escape-hatches.mjs`.
 *
 * Wired up as `pnpm check:invariants`, in `scripts/check.sh` and the CI check
 * job (both — see AGENTS.md on ratchets that lived in only one).
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

import { LINE_RULES } from "./guard-invariants-rules.mjs";
import {
  scanResearchFrontmatter,
  scanSymlinks,
  scanTemplateEscapingImports,
  scanUndeclaredGuestRoutes,
  scanUnpinnedActions,
  scanUnreadFixtureDirs,
} from "./guard-invariants-scanners.mjs";

const BASELINE_PATH = new URL("guard-invariants-baseline.json", import.meta.url);

/**
 * Files whose CONTENT is a description of the thing being banned, and which
 * therefore match their own rule. Each is a primitive's implementation or its
 * doc comment; excluding them is not an exemption, it is the difference between
 * scanning call sites and scanning the definition every call site should use.
 *
 * This trap has already cost real time twice in this repo — the escape-hatch
 * gate counted its own pattern list, and then counted its own baseline file.
 *
 * **The exemption is PER RULE, not per file**, and that distinction was bought
 * rather than designed in. This was a flat `Set` of paths skipped by every rule,
 * which is a different and much broader claim: `host/_test-utils.ts` is on it
 * because rule 4's doc quotes the `setTimeout(r, 0)` shadowing bug, and that made
 * the file invisible to rule 16 as well — a rule whose whole subject is the four
 * test harnesses, one of which is that file. It would have reported `0 ✓` over a
 * harness free to grow its callback stub back, which is precisely the
 * silently-blind shape the set exists to prevent. `"*"` still means every rule,
 * and is right only for the gate's own machinery.
 */
const SELF_REFERENTIAL = new Map([
  ["scripts/guard-invariants.mjs", "*"],
  // The rule definitions. Every pattern's `label` and `re` is a description of
  // the thing it bans, so this file matches most of its own rules.
  ["scripts/guard-invariants-rules.mjs", "*"],
  ["scripts/guard-invariants-baseline.json", "*"],
  // The spec that proves each rule still matches. Its samples ARE the
  // anti-patterns, spelled out on purpose — it exists because a pattern
  // matching nothing prints the same checkmark as a rule being upheld.
  ["packages/aai-templates/guard-invariants-gate.test.ts", "*"],
  // The primitives the rules point AT — each exempt from ITS OWN rule only.
  ["packages/aai/sdk/omit-undefined.ts", ["rule2_spreadTernary"]], // its doc shows the banned spelling
  ["packages/aai/sdk/keyed-lock.ts", ["rule9_handRolledKeyedLock"]], // rule 9 IS this implementation
  ["packages/aai/sdk/owned-map.ts", ["rule8_handRolledOwnedMap"]], // rule 8 IS this implementation
  ["packages/aai/sdk/epoch.ts", "*"],
  ["packages/aai/sdk/session-slot.ts", "*"], // rule 6 (retired) named the cast it replaces
  ["packages/aai/host/_test-utils.ts", ["rule4_inlineTickPromise"]], // its doc quotes the shadowing bug
]);

/** Is `file` exempt from the rule keyed `ruleKey`? */
function isSelfReferential(file, ruleKey) {
  const scope = SELF_REFERENTIAL.get(file);
  if (scope === undefined) return false;
  return scope === "*" || scope.includes(ruleKey);
}

/** Run git, returning stdout. Throws on real failure (not "no matches"). */
function git(args, { allowNoMatch = false } = {}) {
  try {
    return execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } catch (err) {
    if (allowNoMatch && err.status === 1) return "";
    throw err;
  }
}

/**
 * Split one `git grep -n` line into `{ file, line, text }`.
 *
 * Sliced positionally rather than split on ":" — a matched source line very
 * often contains colons.
 */
function parseMatch(raw) {
  const fileEnd = raw.indexOf(":");
  const lineEnd = raw.indexOf(":", fileEnd + 1);
  return {
    file: raw.slice(0, fileEnd),
    line: Number(raw.slice(fileEnd + 1, lineEnd)),
    text: raw.slice(lineEnd + 1).trim(),
  };
}

/** True when the line carries only prose — a `//` or `*` comment. */
function isCommentOnly(text) {
  return text.startsWith("//") || text.startsWith("*") || text.startsWith("/*");
}

function scanLineRule({ key, re, paths, skipComments }) {
  const out = git(["grep", "-nIE", "--untracked", "-e", re, "--", ...paths], {
    allowNoMatch: true,
  });
  if (out === "") return [];
  return out
    .split("\n")
    .filter((line) => line.length > 0)
    .map(parseMatch)
    .filter((m) => !isSelfReferential(m.file, key))
    .filter((m) => !(skipComments && isCommentOnly(m.text)));
}

// ---------------------------------------------------------------------------
// Run every rule
// ---------------------------------------------------------------------------

/**
 * Rules with no baseline: enforced absolutely, because the tree holds zero
 * violations today and the whole point is that it stays that way. Listing them
 * separately from the baselined rules keeps "this is at zero" visible instead
 * of implied by an empty JSON object.
 */
const ABSOLUTE_RULES = [
  {
    id: 1,
    label: "symlink",
    scan: scanSymlinks,
    remedy:
      "Replace it with a real file, or a module that re-exports. Symlinks do\n" +
      "not survive an npm tarball, `aai init`'s scaffold copy, and the Modal\n" +
      "guest image identically — a link that resolves in a checkout can arrive\n" +
      "dangling or as a 12-byte text file.",
  },
  {
    id: 7,
    label: "unpinned GitHub Action",
    scan: scanUnpinnedActions,
    remedy:
      "Pin to a 40-character commit SHA with the release in a trailing comment:\n" +
      "  uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n" +
      "A tag is a mutable pointer, so `@v7` grants every future version of that\n" +
      "code the permissions of the job it runs in — including the release job's\n" +
      "npm token. Dependabot bumps the SHA and the comment together.",
  },
  {
    id: 12,
    label: "undeclared guest route",
    scan: scanUndeclaredGuestRoutes,
    remedy:
      "Add the path to `GUEST_ROUTES` in packages/aai-server/guest-routes.ts and\n" +
      "give it an exposure in `GUEST_ROUTE_EXPOSURE` (the `satisfies` makes the\n" +
      "second half a compile error once the first is done).\n\n" +
      "The exposure is decided by WHO CALLS IT: `direct-dial` when a browser or a\n" +
      "carrier dials the sandbox having been handed the URL, `proxied` when the\n" +
      "platform must serve `/:slug<path>` and forward it, `host-only` when only\n" +
      "the platform dials it holding a token, `guest-internal` when nothing\n" +
      "outside the container calls it at all.\n\n" +
      "A literal ending in `/` is a prefix gate and passes only while a declared\n" +
      "route lives under it — a prefix dispatch is how the guest's real surface\n" +
      "gets wider than the table without any one literal being new.",
  },
  {
    id: 10,
    label: "research/ frontmatter",
    scan: scanResearchFrontmatter,
    remedy:
      "Every research doc needs `issue`, `status`, and an ISO `last_updated`:\n" +
      "  ---\n" +
      "  issue: https://github.com/alexkroman/agent/issues/123\n" +
      "  status: proposed\n" +
      '  last_updated: "2026-08-12"\n' +
      "  ---\n" +
      "A plan with no issue is an unowned parallel backlog; a plan with no date\n" +
      "cannot be told from a stale one.",
  },
  {
    id: 14,
    label: "fixture directory nothing reads",
    scan: scanUnreadFixtureDirs,
    remedy:
      "Delete it, or add the test that reads it.\n\n" +
      "`packages/aai-server/` held a pinned RPC fixture set — with a README\n" +
      'instructing the reader to "never delete" a committed fixture — for five\n' +
      "commits after its only reader (`sandbox-compat.test.ts`) was deleted in\n" +
      "30914c9b. Nothing noticed, and the `turbo.json` comment justifying that\n" +
      "task's cache inputs cited it BY NAME as a reason tests need to hash JSON,\n" +
      "so the repo was hashing a fixture set no test read.\n\n" +
      "A reference has to RESOLVE, not just match the name: the surviving\n" +
      "`aai/sdk/compat-fixtures/` is reached as\n" +
      "`join(import.meta.dirname, …)` from its own sibling, and that string is why\n" +
      "a name-only scan called the dead directory read. A cross-package reader\n" +
      "counts — aai-cli's e2e suite reads aai-ui's fixtures.",
  },
  {
    id: 13,
    label: "template import escaping its template",
    scan: scanTemplateEscapingImports,
    remedy:
      "A template SHIPS. `aai init` copies `templates/<name>/` into a user's\n" +
      "project and nothing above it comes along, so this import resolves here\n" +
      "and in nothing a user runs.\n\n" +
      "Move what you need INTO the template, or publish it on the SDK and import\n" +
      "it by package name. A shared spec helper belongs on\n" +
      "`@alexkroman1/aai/testing` — that is where `withDiscoveredTools` went\n" +
      "when five templates were reaching up to `../../_tool-discovery.ts`.\n\n" +
      "This rule exists because every other gate runs IN THIS REPO, where the\n" +
      "relative path resolves: those five broke `aai test`, `aai build` and\n" +
      "`npm start` for their own users while `check:template-types`,\n" +
      "`templates.test.ts` and each template's own spec stayed green.",
  },
];

const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));

/** Per-baselined-rule `{ file: count }` in the current tree, plus the lines. */
const actual = new Map();
const occurrences = new Map();
for (const rule of LINE_RULES) {
  const byFile = new Map();
  const linesByFile = new Map();
  for (const match of scanLineRule(rule)) {
    byFile.set(match.file, (byFile.get(match.file) ?? 0) + 1);
    linesByFile.set(match.file, [...(linesByFile.get(match.file) ?? []), match]);
  }
  actual.set(rule.key, byFile);
  occurrences.set(rule.key, linesByFile);
}

// ---------------------------------------------------------------------------
// --update
// ---------------------------------------------------------------------------

if (process.argv.includes("--update")) {
  const next = { _description: baseline._description };
  const lowered = [];
  const refused = [];

  for (const rule of LINE_RULES) {
    const allowed = baseline[rule.key] ?? {};
    const current = actual.get(rule.key) ?? new Map();
    const merged = {};
    for (const file of new Set([...Object.keys(allowed), ...current.keys()])) {
      const was = allowed[file] ?? 0;
      const now = current.get(file) ?? 0;
      if (now > was) {
        refused.push({ label: `rule ${rule.id}`, file, was, now });
        if (was > 0) merged[file] = was;
        continue;
      }
      if (now < was) lowered.push({ label: `rule ${rule.id}`, file, was, now });
      if (now > 0) merged[file] = now;
    }
    if (Object.keys(merged).length > 0) {
      next[rule.key] = Object.fromEntries(
        Object.entries(merged).sort(([a], [b]) => a.localeCompare(b)),
      );
    }
  }

  if (refused.length > 0) {
    console.error(`\nguard-invariants --update: refusing to RAISE ${refused.length} entr(ies):\n`);
    for (const { label, file, was, now } of refused) {
      console.error(`  ${label}  ${file}  ${was} -> ${now}`);
    }
    console.error(
      "\nBaselines only ratchet down. Fix the violation. If an occurrence is\n" +
        "genuinely unavoidable, raise the number by hand and say why in the PR —\n" +
        "the increase then lands in a reviewable diff.\n",
    );
    process.exit(1);
  }

  writeFileSync(BASELINE_PATH, `${JSON.stringify(next, null, 2)}\n`);
  if (lowered.length === 0) {
    console.log("guard-invariants --update: baseline already matches the work tree.");
  } else {
    console.log(`guard-invariants --update: lowered ${lowered.length} entr(ies):\n`);
    for (const { label, file, was, now } of lowered) {
      console.log(`  ${label}  ${file}  ${was} -> ${now}`);
    }
  }
  process.exit(0);
}

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

const MAX_SHOWN = 20;
const MAX_TEXT = 100;
/** GitHub renders these inline on the PR diff. */
const ANNOTATE = process.env.GITHUB_ACTIONS === "true";

let failed = false;
const stale = [];

function annotate(file, line, message) {
  if (!ANNOTATE) return;
  const at = line > 0 ? `,line=${line}` : "";
  console.log(`::error file=${file}${at}::${message.replace(/\n/g, " ")}`);
}

for (const { id, label, scan, remedy } of ABSOLUTE_RULES) {
  const found = scan();
  if (found.length === 0) {
    console.log(`  rule ${String(id).padStart(2)}  ${label.padEnd(34)}  0 ✓`);
    continue;
  }
  failed = true;
  console.error(`\nguard-invariants: rule ${id} — ${found.length} ${label} violation(s):\n`);
  for (const { file, line, text } of found.slice(0, MAX_SHOWN)) {
    const where = line > 0 ? `${file}:${line}` : file;
    const shown = text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text;
    console.error(`  ${where}  ${shown}`);
    annotate(file, line, `rule ${id}: ${label} — ${text}`);
  }
  if (found.length > MAX_SHOWN) console.error(`  … and ${found.length - MAX_SHOWN} more`);
  console.error(`\n${remedy}\n`);
}

for (const rule of LINE_RULES) {
  const allowed = baseline[rule.key] ?? {};
  const current = actual.get(rule.key) ?? new Map();
  const allowedTotal = Object.values(allowed).reduce((sum, n) => sum + n, 0);
  const currentTotal = [...current.values()].reduce((sum, n) => sum + n, 0);

  const over = [];
  for (const [file, count] of current) {
    if (count > (allowed[file] ?? 0)) over.push({ file, budget: allowed[file] ?? 0, count });
  }
  for (const [file, budget] of Object.entries(allowed)) {
    const count = current.get(file) ?? 0;
    if (count < budget) stale.push({ label: `rule ${rule.id}`, file, budget, count });
  }

  const summary = `allowed=${allowedTotal} now=${currentTotal}`;
  if (over.length === 0) {
    console.log(`  rule ${String(rule.id).padStart(2)}  ${rule.label.padEnd(34)}  ${summary} ✓`);
    continue;
  }

  failed = true;
  console.error(
    `\nguard-invariants: rule ${rule.id} — ${over.length} file(s) over baseline ` +
      `(${rule.label}):\n`,
  );
  for (const { file, budget, count } of over) {
    console.error(`  ${file}  allowed ${budget}, found ${count}`);
    const lines = occurrences.get(rule.key)?.get(file) ?? [];
    for (const { line, text } of lines.slice(0, MAX_SHOWN)) {
      const shown = text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text;
      console.error(`      ${file}:${line}  ${shown}`);
      annotate(file, line, `rule ${rule.id}: ${rule.label} — ${text}`);
    }
    if (lines.length > MAX_SHOWN) console.error(`      … and ${lines.length - MAX_SHOWN} more`);
  }
  console.error(`\n${rule.remedy}\n`);
}

if (failed) {
  console.error(
    "guard-invariants: fix the violation(s) above rather than editing the\n" +
      "baseline. See the header of scripts/guard-invariants.mjs for each rule's\n" +
      "rationale.",
  );
  process.exit(1);
}

if (stale.length > 0) {
  console.warn(
    `\nguard-invariants: ${stale.length} baseline entr(ies) now sit above the real count — ` +
      "run `node scripts/guard-invariants.mjs --update` to give the headroom back:\n",
  );
  for (const { label, file, budget, count } of stale.slice(0, MAX_SHOWN)) {
    console.warn(`  ${label}  ${file}  ${budget} -> ${count}`);
  }
  if (stale.length > MAX_SHOWN) console.warn(`  … and ${stale.length - MAX_SHOWN} more`);
}

console.log(`\nguard-invariants: ${ABSOLUTE_RULES.length + LINE_RULES.length} rule(s) hold. ✓`);
