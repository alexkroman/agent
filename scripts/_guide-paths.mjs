// Copyright 2026 the AAI authors. MIT license.
/**
 * Dangling-path detection for the agent guides, run by `check-claude-md.mjs`.
 *
 * A guide that names a file which no longer exists sends an agent hunting, so
 * every backticked span in a guide that LOOKS like a repo path must resolve to
 * a tracked (or new, unignored) file or directory.
 *
 * ## What counts as a path
 *
 * An inline code span outside fenced blocks (those hold commands and code),
 * with no whitespace, after stripping a `:12` / `:12-30` / `#L12` suffix and a
 * trailing `()`, that EITHER contains a `/` and ends in `/` or a file extension
 * ({@link EXTENSIONS}) or starts with a top-level repo directory or a package
 * directory name, OR has no `/` and ends in a file extension.
 *
 * Never checked:
 *
 *   - URLs, `node:` builtins, `@`-scoped npm specifiers, and spans starting
 *     with `/` (routes and subpath exports such as `/testing`), `.` alone, or
 *     a bare `-…` / `.…` fragment (`.tsx`, `.test-d.ts`, `-base.mjs`);
 *   - globs and placeholders: any of `* ? { } < > [ ] $ … |`, or a segment
 *     from {@link PLACEHOLDERS}, extension and a leading `_` ignored
 *     (`foo.test.ts`, `_foo.ts`, `my_agent/`);
 *   - build output and user-machine state: a segment from {@link GENERATED}
 *     (`dist/`, `.aai/`, `node_modules/`, …);
 *   - every span in a SECTION (from the marker to the next heading) holding
 *     the line `<!-- paths: external -->` — for prose describing another
 *     project's files (`PORTS-CLAUDE.md`'s source frameworks).
 *
 * ## Where a path may resolve (the shorthand rule)
 *
 * Any one of:
 *
 *   1. repo-root relative (`packages/aai/src/host/ssrf.ts`);
 *   2. relative to the guide's own directory, its package root or the
 *      package's `src/` (`src/foo.ts`, `host/ssrf.ts` in `packages/aai/…`);
 *   3. `<package-dir>/rest` as `packages/<package-dir>/rest`,
 *      `packages/<package-dir>/src/rest`, or a subpath in that package's
 *      `exports` (`aai/host/ssrf.ts`, `aai-guest/harness`);
 *   4. a path SUFFIX of some tracked path, on a segment boundary
 *      (`sandbox/vm.ts`, `templates/`) — a guide names a file by its tail once
 *      the surrounding prose has said which package it is in;
 *   5. a bare file name (no `/`) that some tracked file carries.
 *
 * Rules 4 and 5 are lenient on purpose: what this gate exists to catch is a
 * name that resolves NOWHERE — a renamed, moved or deleted file.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";

const EXTENSIONS =
  /\.(?:[cm]?[jt]sx?|json|jsonc|md|mdx|ya?ml|toml|sql|sh|css|html|py|txt|wasm|Dockerfile)$/;
const TOP_DIRS = new Set([
  ".agents",
  ".changeset",
  ".claude",
  ".github",
  "docs",
  "packages",
  "scripts",
  "supabase",
]);
const SKIP_CHARS = /[*?{}<>[\]$…|,;=()'"\\]/;
/** Segments that name an example, not a file (compared without extension). */
const PLACEHOLDERS = new Set(["foo", "foo-barrel", "bar", "x", "X", "pkg", "name", "my_agent"]);
/** Segments that are build output or per-machine state, never tracked. */
const GENERATED = new Set([
  "dist",
  ".aai",
  "node_modules",
  "reports",
  "coverage",
  ".eval-workspaces",
  ".turbo",
]);
const EXTERNAL_MARKER = "<!-- paths: external -->";

/** Every tracked or new unignored path, with what the shorthand rule needs. */
export function repoTree(root) {
  const files = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  )
    .split("\0")
    .filter(Boolean)
    .filter((path) => existsSync(join(root, path)));
  const entries = new Set();
  const suffixes = new Set();
  for (const file of files) {
    const segments = file.split("/");
    for (let end = segments.length; end > 0; end--) {
      const prefix = segments.slice(0, end).join("/");
      entries.add(prefix);
      for (let start = 1; start < end; start++) suffixes.add(segments.slice(start, end).join("/"));
    }
  }
  const packages = new Map();
  for (const file of files) {
    const dir = /^packages\/([^/]+)\/package\.json$/.exec(file)?.[1];
    if (dir === undefined) continue;
    const { exports } = JSON.parse(readFileSync(join(root, file), "utf8"));
    packages.set(dir, Object.keys(typeof exports === "object" && exports !== null ? exports : {}));
  }
  return { entries, suffixes, packages };
}

/** Inline code spans outside fenced blocks and external-marked sections. */
function codeSpans(text) {
  const spans = [];
  let fenced = false;
  let external = false;
  for (const [i, line] of text.split("\n").entries()) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    if (/^#{1,6} /.test(line)) external = false;
    if (line.trim() === EXTERNAL_MARKER) external = true;
    if (external) continue;
    for (const m of line.matchAll(/(`+)([^`]+?)\1(?!`)/g)) {
      spans.push({ span: (m[2] ?? "").trim(), line: i + 1 });
    }
  }
  return spans;
}

/** The candidate path a span names, or `undefined` when it is not path-shaped. */
function pathOf(span, tree) {
  if (/\s/.test(span) || span === "") return;
  if (/^(?:[a-z]+:\/\/|node:|@|\/|~|-|\.\.?$|\.[\w.-]+$)/.test(span)) return;
  const path = span
    .replace(/(?::\d+(?:-\d+)?|#L\d+(?:-L?\d+)?)$/, "")
    .replace(/\(\)$/, "")
    .replace(/^\.\//, "");
  if (SKIP_CHARS.test(path)) return;
  const segments = path.split("/").filter(Boolean);
  const stem = (s) => s.replace(/^_/, "").replace(/(?:\.test|\.test-d|\.d)?\.[\w]+$/, "");
  if (segments.some((s) => GENERATED.has(s) || PLACEHOLDERS.has(stem(s)))) return;
  if (!path.includes("/")) return EXTENSIONS.test(path) ? path : undefined;
  if (path.endsWith("/") || EXTENSIONS.test(path)) return path;
  const first = segments[0] ?? "";
  if (TOP_DIRS.has(first) || tree.packages.has(first)) return path;
}

/** Whether `path`, named in `guide`, resolves under the shorthand rule. */
function resolves(path, guide, tree) {
  const clean = path.replace(/\/$/, "");
  const has = (p) => tree.entries.has(posix.normalize(p));
  if (has(clean) || tree.suffixes.has(clean)) return true;
  const pkg = /^packages\/([^/]+)\//.exec(guide)?.[1];
  const bases = [dirname(guide)];
  if (pkg !== undefined) bases.push(`packages/${pkg}`, `packages/${pkg}/src`);
  if (bases.some((base) => base !== "." && has(posix.join(base, clean)))) return true;
  const [first = "", ...rest] = clean.split("/");
  const exports = tree.packages.get(first);
  if (exports !== undefined && rest.length > 0) {
    const tail = rest.join("/");
    if (has(`packages/${first}/${tail}`) || has(`packages/${first}/src/${tail}`)) return true;
    if (exports.includes(`./${tail}`)) return true;
  }
  return false;
}

/** Every dangling path in one guide, as `{ line, span }`. */
export function danglingPaths(root, guide, tree) {
  const text = readFileSync(join(root, guide), "utf8");
  const out = [];
  for (const { span, line } of codeSpans(text)) {
    const path = pathOf(span, tree);
    if (path !== undefined && !resolves(path, guide, tree)) out.push({ line, span });
  }
  return out;
}
