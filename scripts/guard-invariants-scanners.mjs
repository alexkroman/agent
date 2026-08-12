/**
 * The three invariants that are not a line scan.
 *
 * Rules 1, 7 and 10 each read a different shape — git's index, the workflow
 * files, and YAML frontmatter — so none of them fits the `git grep -E` pattern
 * every other rule uses. Split out of `guard-invariants.mjs` at that seam
 * because the gate was 34 lines under the 500-line cap, and
 * `check:file-length` warns before the cap precisely so the split lands in its
 * own commit rather than inside whatever change would have forced it.
 *
 * All three are at ZERO in the tree and enforced absolutely — they have no
 * entry in `guard-invariants-baseline.json`, which is deliberate: "this is at
 * zero" should be visible rather than implied by an empty JSON object.
 *
 * Each scanner returns `{ file, line, text }[]`, the same shape the line rules
 * produce, so the reporting and the `::error` annotations in the gate do not
 * care which kind of rule they came from.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** Run git, returning stdout. */
function git(args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
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
    const lines = readFileSync(new URL(`../${file}`, import.meta.url), "utf8").split("\n");
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

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function scanResearchFrontmatter() {
  const files = git(["ls-files", "--", "research"])
    .split("\n")
    .filter((f) => f.endsWith(".md") && f !== "research/README.md");
  const found = [];
  for (const file of files) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    // Deliberately not a YAML parser: the three fields are scalars, and a
    // dependency here would be one more thing that can be absent when a gate
    // runs. A malformed block fails the shape check below, which is the answer
    // either way.
    const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source);
    if (block === null) {
      found.push({ file, line: 1, text: "no YAML frontmatter block" });
      continue;
    }
    const fields = new Map(
      block[1]
        .split(/\r?\n/)
        .map((line) => /^([A-Za-z_]+):\s*(.*)$/.exec(line))
        .filter((m) => m !== null)
        .map((m) => [m[1], m[2].trim().replace(/^["']|["']$/g, "")]),
    );
    for (const key of ["issue", "status"]) {
      if ((fields.get(key) ?? "") === "") {
        found.push({ file, line: 1, text: `frontmatter \`${key}\` is missing or empty` });
      }
    }
    const updated = fields.get("last_updated") ?? "";
    if (!ISO_DATE.test(updated)) {
      found.push({
        file,
        line: 1,
        text: `frontmatter \`last_updated\` is not an ISO date: ${updated || "(missing)"}`,
      });
    }
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

/** Route-shaped string literals in the guest's own non-test source. */
function guestRouteLiterals() {
  const out = git([
    "grep",
    "-nIoE",
    '"/[A-Za-z0-9._/-]*"',
    "--",
    "packages/aai-guest",
    ":!packages/aai-guest/dist/**",
    // Both spellings: the suites sit directly in the package root, which
    // `**/*.test.ts` does not match on its own.
    ":!packages/aai-guest/*.test.ts",
    ":!packages/aai-guest/**/*.test.ts",
  ]);
  return out
    .split("\n")
    .filter(Boolean)
    .map((row) => {
      const file = row.slice(0, row.indexOf(":"));
      const rest = row.slice(row.indexOf(":") + 1);
      const line = Number(rest.slice(0, rest.indexOf(":")));
      const literal = rest.slice(rest.indexOf(":") + 1).replaceAll('"', "");
      return { file, line, literal };
    });
}

/** The paths `GUEST_ROUTES` declares, read as text — never imported. */
function declaredGuestRoutes() {
  const source = readFileSync(
    new URL("../packages/aai-server/guest-routes.ts", import.meta.url),
    "utf8",
  );
  const block = /export const GUEST_ROUTES = \{([\s\S]*?)\n\} as const;/.exec(source);
  if (block === null) {
    throw new Error(
      "guard-invariants rule 12: could not find `export const GUEST_ROUTES = { … } as const;` " +
        "in packages/aai-server/guest-routes.ts. The scan reads it as text (the boundary " +
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
  return findUndeclaredGuestRoutes(guestRouteLiterals(), declaredGuestRoutes());
}
