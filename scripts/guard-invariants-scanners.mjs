/**
 * The invariants that are not a line scan.
 *
 * Rules 1, 7, 12, 13 and 14 each read a different shape — git's index, the
 * workflow files, two dispatch tables as text, import specifiers, and resolved
 * fixture paths — so none of them fits the
 * `git grep -E` pattern every other rule uses. Split out of
 * `guard-invariants.mjs` at that seam because the gate was 34 lines under the
 * 500-line cap, and `check:file-length` warns before the cap precisely so the
 * split lands in its own commit rather than inside whatever change would have
 * forced it.
 *
 * All of them are at ZERO in the tree and enforced absolutely — they have no
 * entry in `guard-invariants-baseline.json`, which is deliberate: "this is at
 * zero" should be visible rather than implied by an empty JSON object.
 *
 * Each scanner returns `{ file, line, text }[]`, the same shape the line rules
 * produce, so the reporting and the `::error` annotations in the gate do not
 * care which kind of rule they came from.
 */

import { existsSync, readFileSync } from "node:fs";

import { git } from "./_ratchet.mjs";
import {
  GUEST_SURFACE_PATHSPECS,
  RUNTIME_ROUTE_SOURCES,
  TEMPLATE_PATHSPECS,
} from "./guard-invariants-scopes.mjs";

/**
 * Read a repo-relative file listed by git, or `undefined` when it is not there.
 *
 * **The list comes from the INDEX and the read is of the WORKING TREE**, so a
 * file deleted-but-not-yet-staged is listed and absent. Reading it blind throws
 * an uncaught ENOENT out of the gate, which kills every OTHER rule with it and
 * names a file the author already deleted — a failure that reads as a bug in the
 * gate rather than as a dirty tree. The retired rule 10's scanner had guarded
 * this, with a comment recording having been bitten; its sibling scanners had
 * not, so they all go through here now.
 *
 * Skipping is the right answer rather than a silent pass: a deleted file has no
 * content to check, and `git ls-files` stops listing it the moment the deletion
 * is staged.
 */
export function readRepoFile(file) {
  const path = new URL(`../${file}`, import.meta.url);
  if (!existsSync(path)) return;
  return readFileSync(path, "utf8");
}

export function scanSymlinks() {
  // Mode 120000 is git's symlink mode. Read from the index rather than
  // lstat-walking the tree: that is what actually gets archived.
  return git(["ls-files", "-s"])
    .split("\n")
    .filter((line) => line.startsWith("120000"))
    .map((line) => ({ file: line.split("\t")[1], line: 0, text: "symlink" }))
    .filter((m) => m.file !== undefined);
}

const SHA_PINNED = /^[0-9a-f]{40}$/;

export function scanUnpinnedActions() {
  const files = git(["ls-files", "--", ".github/workflows"])
    .split("\n")
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));
  const found = [];
  for (const file of files) {
    const source = readRepoFile(file);
    if (source === undefined) continue;
    const lines = source.split("\n");
    lines.forEach((text, index) => {
      const match = /^\s*(?:-\s*)?uses:\s*(\S+)/.exec(text);
      if (match === null) return;
      const spec = match[1];
      // A local action (`./.github/actions/x`) or a docker ref has no SHA to pin.
      if (spec.startsWith("./") || spec.startsWith("docker://")) return;
      const ref = spec.split("@")[1];
      if (ref !== undefined && SHA_PINNED.test(ref)) return;
      found.push({ file, line: index + 1, text: text.trim() });
    });
  }
  return found;
}

// ---------------------------------------------------------------------------
// Rule 12 — every guest route literal is declared in GUEST_ROUTES
// ---------------------------------------------------------------------------

/**
 * `GUEST_ROUTE_EXPOSURE` is verified against the PLATFORM and not against the
 * guest.
 *
 * `guest-routes.test.ts` introspects the real orchestrator app and asserts
 * every `proxied` method is registered under `/:slug`, plus the reverse. That
 * half is genuinely checked. The other half — that `GUEST_ROUTES` still
 * describes what the guest actually serves — is transcribed BY HAND, and by
 * construction nothing verifies it: `aai-server` must never import guest
 * source, so the table cannot be derived from the thing it mirrors.
 *
 * It had already drifted. `GET /studio/tools` is a real guest route
 * (`studio-chat.ts`) that was in neither table, so the `satisfies` could not
 * catch it — that compile error only fires for a KEY with no exposure entry,
 * never for a route nobody wrote down. The studio client reached it by doing
 * URL surgery on another route's URL (`sessionUrl.replace(/\/chat$/, "/tools")`),
 * which is verbatim the anti-pattern `guest-routes.ts`'s own module doc says
 * the table was written to eliminate.
 *
 * This is the cheap 80%: scan the guest's own source for route literals and
 * require each to be declared. It respects the boundary by reading both trees
 * as TEXT from the repo root, so neither package imports the other — the same
 * move `sync-agent-guide.mjs` uses to materialize a file across that line.
 *
 * What it does NOT do is derive METHODS, which stay declarative until the
 * harness's `if (url === X)` dispatch becomes a table. So a route can still be
 * declared with the wrong verbs; it can no longer be absent.
 */

/** Literals that are not routes: the default case, and query/fragment noise. */
const NOT_A_ROUTE = new Set(["/"]);

/**
 * The pure half, so the gate's spec can exercise it on synthetic input.
 *
 * A literal ending in `/` is a PREFIX GATE (`url.startsWith("/manage/")`) and
 * is accepted only when at least one declared route lives under it — which is
 * the property that matters, since a prefix dispatch is exactly how the guest's
 * real surface gets wider than the table without any single literal being new.
 *
 * @param {{ file: string, line: number, literal: string }[]} literals
 * @param {Set<string>} declared
 */
export function findUndeclaredGuestRoutes(literals, declared) {
  const undeclared = [];
  for (const { file, line, literal } of literals) {
    if (NOT_A_ROUTE.has(literal)) continue;
    if (literal.endsWith("/")) {
      // A declared route UNDER the prefix, or the prefix itself minus the
      // slash: `WORKFLOW_WEBHOOK_PREFIX` is `…/webhook/` and the table declares
      // `…/webhook`, which is the same route with its trailing segment taken by
      // a token rather than by a path. A `startsWith` alone reads that as an
      // undeclared prefix gate.
      if (declared.has(literal.slice(0, -1))) continue;
      if ([...declared].some((route) => route.startsWith(literal))) continue;
      undeclared.push({
        file,
        line,
        text: `${literal} — prefix dispatch with no declared route under it`,
      });
      continue;
    }
    if (declared.has(literal)) continue;
    undeclared.push({ file, line, text: `${literal} — not in GUEST_ROUTES` });
  }
  return undeclared;
}

/**
 * Route-shaped string literals in the guest's HTTP surface.
 *
 * Whole LINES rather than `-o` fragments, so a comment-only line can be
 * dropped. That is not cosmetic: widening the scan into `packages/aai/src/host`
 * and `sdk/` immediately picked up `new URL("/x", base)` from a JSDoc
 * paragraph in `workflow-api-client.ts` explaining why an absolute URL is
 * wrong — prose scored as a route, which is the same code-versus-prose
 * confusion the escape-hatch gate's comment filter exists for.
 */
function guestRouteLiterals() {
  const out = git(["grep", "-nIE", '"/[A-Za-z0-9._/-]*"', "--", ...GUEST_SURFACE_PATHSPECS], {
    allowNoMatch: true,
  });
  const literals = [];
  for (const row of out.split("\n").filter(Boolean)) {
    const fileEnd = row.indexOf(":");
    const lineEnd = row.indexOf(":", fileEnd + 1);
    const file = row.slice(0, fileEnd);
    const line = Number(row.slice(fileEnd + 1, lineEnd));
    const text = row.slice(lineEnd + 1).trim();
    if (text.startsWith("//") || text.startsWith("*") || text.startsWith("/*")) continue;
    for (const [, literal] of text.matchAll(/"(\/[A-Za-z0-9._/-]*)"/g)) {
      literals.push({ file, line, literal });
    }
  }
  return literals;
}

/**
 * The paths the RUNTIME's route table names, resolved through the constants it
 * references.
 *
 * Ten of `GUEST_ROUTES`' entries are no longer literals — they compose
 * `SERVER_ROUTES` / `WORKFLOW_CALLBACK_ROUTES` from
 * `packages/aai-runtime/src/server-routes.ts`, so the text read below finds seven
 * strings where it used to find seventeen and would report the runtime's own
 * declarations as undeclared. That is the reader being right about the text and
 * wrong about the program.
 *
 * The division of labour this restores is the point of the table:
 *
 * - A literal that a TABLE ENTRY names is declared here, because
 *   `guest-routes.test.ts` then asserts it really reaches `GUEST_ROUTES` — a
 *   comparison of values, which is strictly stronger than this grep.
 * - An INLINE literal is still undeclared, which is the gap this rule was
 *   written for: `if (url === "/metrics")` added to `server.ts` is served by
 *   every guest and joins no table.
 *
 * A constant that exists but no table entry references is therefore NOT
 * declared — resolution runs through `path: NAME` in the table, never over the
 * `export const` declarations alone, so adding a constant is not a way to opt a
 * route out of both checks.
 */
function tableDeclaredRoutes() {
  const tableUrl = new URL("../packages/aai-runtime/src/server-routes.ts", import.meta.url);
  const table = readFileSync(tableUrl, "utf8");

  // Every `path: <IDENT>` in the two tables, plus the paths this module declares
  // itself (`HEALTH_PATH`, `SESSION_PATH`, `ROOT_PATH`, `CLIENT_CONFIG_ROUTE`).
  const referenced = new Set(
    [...table.matchAll(/\bpath:\s*([A-Z][A-Z0-9_]*)\s*,/g)].map((m) => m[1]),
  );
  if (referenced.size === 0) {
    throw new Error(
      "guard-invariants rule 12: packages/aai-runtime/src/server-routes.ts named no " +
        "`path: CONSTANT` entries. The scan reads it as text, so a reshaped table " +
        "silently stops declaring the runtime's routes — fix the pattern.",
    );
  }

  // NAME -> "/path", over the modules the rule already scans. Only a QUOTED
  // declaration counts: the one template-literal path here is
  // `WORKFLOW_WEBHOOK_PREFIX`, which derives from the slash-less base and is not
  // itself a route, and resolving templates would mean evaluating them.
  const values = new Map();
  for (const file of RUNTIME_ROUTE_SOURCES) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    for (const [, name, path] of source.matchAll(
      /^export const ([A-Z][A-Z0-9_]*)(?::[^=]+)?\s*=\s*"(\/[^"]*)"/gm,
    )) {
      values.set(name, path);
    }
  }
  const resolved = new Set();
  for (const name of referenced) {
    const path = values.get(name);
    if (path !== undefined) resolved.add(path);
  }
  return resolved;
}

/** The paths `GUEST_ROUTES` declares, read as text — never imported. */
function declaredGuestRoutes() {
  const source = readFileSync(
    new URL("../packages/aai-server/src/guest-routes.ts", import.meta.url),
    "utf8",
  );
  const block = /export const GUEST_ROUTES = \{([\s\S]*?)\n\} as const;/.exec(source);
  if (block === null) {
    throw new Error(
      "guard-invariants rule 12: could not find `export const GUEST_ROUTES = { … } as const;` " +
        "in packages/aai-server/src/guest-routes.ts. The scan reads it as text (the boundary " +
        "forbids importing it), so a rename here silently empties the rule — fix the pattern.",
    );
  }
  const routes = new Set(
    [...block[1].matchAll(/^\s*[A-Za-z][A-Za-z0-9]*:\s*"([^"]+)",/gm)].map((m) => m[1]),
  );
  if (routes.size === 0) {
    throw new Error("guard-invariants rule 12: GUEST_ROUTES parsed to zero routes.");
  }
  return routes;
}

export function scanUndeclaredGuestRoutes() {
  const declared = new Set([...declaredGuestRoutes(), ...tableDeclaredRoutes()]);
  return findUndeclaredGuestRoutes(guestRouteLiterals(), declared);
}

/**
 * Rule 13: a template file may not import a path that ESCAPES its template.
 *
 * A template ships. `aai init` copies `templates/<name>/` into a user's project
 * and nothing above it comes along, so a relative import that climbs out of that
 * directory resolves in this repo and in nothing a user runs — and every gate we
 * have runs in this repo. Five shipped templates imported
 * `../../_tool-discovery.ts`, which broke `aai test`, `aai build` (it
 * type-checks) and `npm start` for all five, while `check:template-types`,
 * `templates.test.ts` and every template's own spec stayed green.
 *
 * It RESOLVES rather than pattern-matching `../../`, because depth is not the
 * question: `../shared.ts` from `tools/a.ts` is fine and `../../shared.ts` from
 * the same file is not, and both spell the same number of dots as a legal import
 * one directory up.
 */

/**
 * The pure half, split out for the same reason rule 12's is: the decision is a
 * path computation with several ways to go quietly wrong (an off-by-one in the
 * template-root slice, a `..` that pops past the root, a pathspec that stops
 * matching), and a scan that resolved everything to "inside" would report the
 * healthiest possible tree.
 *
 * @param {string} file - repo-relative path of the importing file
 * @param {string} specifier - the relative specifier it imports
 * @returns {boolean} true when the specifier leaves the file's own template
 */
export function importEscapesTemplate(file, specifier) {
  // packages/aai-templates/templates/<name>/… — the fourth segment is the
  // template, and its directory is the boundary a shipped file may not cross.
  const templateRoot = file.split("/").slice(0, 4).join("/");
  // The `.`/`..` walk is `resolveAgainstFile`'s, below — this used to be a
  // second copy of it, where one of the two was already the general form.
  return !resolveAgainstFile(file, specifier).startsWith(`${templateRoot}/`);
}

export function scanTemplateEscapingImports() {
  const files = git(["ls-files", "--", ...TEMPLATE_PATHSPECS])
    .split("\n")
    .filter((f) => /\.(?:m?[jt]s|tsx)$/.test(f));
  const found = [];
  for (const file of files) {
    const source = readRepoFile(file);
    if (source === undefined) continue;
    const lines = source.split("\n");
    lines.forEach((text, index) => {
      const match = /(?:from|import)\s*\(?\s*["'](\.\.?\/[^"']+)["']/.exec(text);
      if (match === null) return;
      if (importEscapesTemplate(file, match[1])) {
        found.push({ file, line: index + 1, text: text.trim() });
      }
    });
  }
  return found;
}

// --- rule 14: a fixture directory nothing reads ----------------------------

/** Files that can READ a fixture. Markdown is prose ABOUT one, never a reader. */
const CODE_FILE = /\.(?:m?[jt]s|tsx|json|ya?ml)$/;

/** Only these are candidates — a directory whose name says what it holds. */
const FIXTURE_DIR_SEGMENT = /fixtures/i;

/**
 * Files whose CONTENT describes this rule, and which therefore "read" whatever
 * fixture directory they name — including a DEAD one, since the worked example in
 * `scanUnreadFixtureDirs`'s doc below is
 * `packages/aai-server/` + `compat-fixtures/` spelled in backticks. Left in, the
 * gate's own explanation of the bug would mark that bug as fixed.
 *
 * `guard-invariants.mjs` carries a `SELF_REFERENTIAL` set for exactly this reason
 * and applies it to the LINE rules only, so an absolute scanner needs its own.
 * Fourth time this trap has been paid for here.
 */
const SELF_REFERENTIAL_READERS = new Set([
  "scripts/guard-invariants-scanners.mjs",
  "scripts/guard-invariants.mjs",
  "packages/aai-gates/src/guard-invariants-gate.test.ts",
]);

/**
 * Resolve a `/`-separated specifier against the DIRECTORY of the file holding it.
 *
 * The one form that matters is `join(import.meta.dirname, "compat-fixtures")` and
 * its relatives, so a reference is interpreted exactly as the module system would
 * interpret it. Paths come from git, so they are `/`-separated on every OS.
 *
 * @param {string} readerFile - repo-relative path of the file holding the string
 * @param {string} specifier  - the string literal found in it
 * @returns {string} the repo-relative path it names
 */
export function resolveAgainstFile(readerFile, specifier) {
  const segments = [...readerFile.split("/").slice(0, -1), ...specifier.split("/")];
  const resolved = [];
  for (const segment of segments) {
    if (segment === "." || segment === "") continue;
    if (segment === "..") resolved.pop();
    else resolved.push(segment);
  }
  return resolved.join("/");
}

/**
 * Every directory under `packages/` whose name contains "fixtures".
 *
 * Derived from git's index rather than a walk, and nested candidates are kept
 * separately (`host/fixtures` and `host/integration/fixtures` are two).
 *
 * @returns {string[]} repo-relative directory paths
 */
export function fixtureDirs() {
  const dirs = new Set();
  for (const file of git(["ls-files", "--", "packages"]).split("\n").filter(Boolean)) {
    const parts = file.split("/");
    // Skip the filename; a candidate is a DIRECTORY on the path.
    for (let i = 1; i < parts.length - 1; i++) {
      if (FIXTURE_DIR_SEGMENT.test(parts[i])) dirs.add(parts.slice(0, i + 1).join("/"));
    }
  }
  return [...dirs].sort();
}

/**
 * Fixture directories no code file resolves a path to.
 *
 * **A reference must RESOLVE, not merely match the name** — that is the whole
 * design, and matching the basename would have missed the case this rule exists
 * for. `packages/aai-server/src/compat-fixtures/` outlived its only reader
 * (`sandbox-compat.test.ts`, deleted in 30914c9b) by five commits while
 * `packages/aai/src/sdk/protocol-compat.test.ts` held the string
 * `"compat-fixtures"` all along — pointing at its OWN sibling. A name-only scan
 * finds that string and reports the dead directory as read.
 *
 * Erring toward "found a reader" is deliberate: this rule is enforced absolutely
 * with no baseline, so a false positive blocks a push while a false negative
 * merely leaves the status quo. Hence a candidate passes on ANY resolving
 * reference from anywhere in `packages/` or `scripts/`, including a
 * cross-package one — `packages/aai-ui/src/fixtures/` is read by
 * `packages/aai-cli/src/e2e.test.ts`, so a package-scoped scan would flag a live
 * directory.
 *
 * @returns {{file: string, line: number, text: string}[]}
 */
export function scanUnreadFixtureDirs() {
  const readers = git(["ls-files", "--", "packages", "scripts"])
    .split("\n")
    .filter((f) => CODE_FILE.test(f) && !SELF_REFERENTIAL_READERS.has(f));

  /** Every path any code file resolves a fixture-ish string literal to. */
  const referenced = new Set();
  for (const file of readers) {
    const source = readRepoFile(file);
    if (source === undefined) continue;
    for (const [, specifier] of source.matchAll(/["'`]([^"'`\n]*fixtures[^"'`\n]*)["'`]/gi)) {
      const resolved = resolveAgainstFile(file, specifier);
      // Record every ancestor too: `join(here, "fixtures/a/b.json")` reads the
      // directory, not only that one file.
      const parts = resolved.split("/");
      for (let i = 1; i <= parts.length; i++) referenced.add(parts.slice(0, i).join("/"));
    }
  }

  return fixtureDirs()
    .filter((dir) => !referenced.has(dir))
    .map((dir) => ({ file: dir, line: 0, text: "fixture directory no code file reads" }));
}
