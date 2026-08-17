/**
 * Rule 20 — a changeset names a real workspace package and a real bump type.
 *
 * Its own module rather than a sixth scanner in `guard-invariants-scanners.mjs`,
 * on that file's own stated seam: the scanners there read source (git's index,
 * the workflow files, two dispatch tables, import specifiers, fixture paths),
 * and this reads RELEASE METADATA. Adding it there also took the file to 531
 * lines against the 500-line cap, which is `check:file-length` asking for the
 * split at the point the subject changed anyway.
 *
 * It returns the same `{ file, line, text }[]` every other rule produces, so the
 * gate's reporting and its `::error` annotations do not care where it came from.
 */

import { readdirSync } from "node:fs";

import { git } from "./_ratchet.mjs";
import { readRepoFile } from "./guard-invariants-scanners.mjs";

/**
 * A changeset whose package key is a typo is IGNORED, silently, by every gate.
 *
 * Verified against this repo before the rule existed: adding
 * `"@alexkroman1/aai-typo": patch` and running the pre-push hook's own
 * `pnpm changeset status --since=origin/main` printed "Packages to be bumped:"
 * with an empty list and exited 0. So the intended release simply does not
 * happen, and nothing says so until somebody notices the version did not move —
 * after merge, in the release workflow, on a branch that is already gone.
 *
 * The fixed release group is what makes this easy to get wrong. AGENTS.md says
 * "you only need to list one" of `@alexkroman1/aai`, `/aai-ui`, `/aai-cli`, so
 * the name is typed from memory rather than copied, and the three differ by a
 * suffix. `pnpm changeset:create --pkg <name>` does not validate it either.
 *
 * Stolen from vercel/eve's rule 29, whose rationale is the same one sentence:
 * release metadata is consumed before `pnpm release`, so a bad package name
 * must fail in PR CI rather than in the post-merge release workflow.
 */

const BUMP_TYPES = new Set(["patch", "minor", "major"]);

/**
 * The floor under `workspacePackageNames()`.
 *
 * Every other name in a changeset is checked by MEMBERSHIP in that set, so a
 * derivation that stopped finding packages would report every changeset in the
 * tree as a violation — loud, and not the failure to guard against. The one
 * that IS silent runs the other way: this rule is enforced absolutely, so a
 * scan finding no changesets prints `0 ✓`, and an empty `.changeset/` is
 * legitimate right after a release. The floor therefore sits on the corpus the
 * comparison is made against, which is never legitimately small.
 */
const MIN_WORKSPACE_PACKAGES = 9; // measured: 10 (packages/* is 9, plus docs)

/**
 * Every package name pnpm treats as a workspace member.
 *
 * Derived from `pnpm-workspace.yaml`'s two globs — `packages/*` and `docs` —
 * by listing ONE level under `packages/` rather than by handing
 * `packages/*\/package.json` to git. A git pathspec is fnmatch without
 * `FNM_PATHNAME`, so its `*` crosses `/`: that spelling also matches
 * `packages/aai-templates/scaffold/package.json` and every template's manifest,
 * none of which is a workspace member, and a changeset naming one would then
 * pass. AGENTS.md records this same trap costing `check-file-length` its entire
 * top-level `scripts/` corpus.
 *
 * @returns {Set<string>}
 */
export function workspacePackageNames() {
  const dirs = readdirSync(new URL("../packages", import.meta.url), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `packages/${entry.name}`);

  const names = new Set();
  for (const dir of [...dirs, "docs"]) {
    const source = readRepoFile(`${dir}/package.json`);
    if (source === undefined) continue;
    const { name } = JSON.parse(source);
    if (typeof name === "string" && name.length > 0) names.add(name);
  }

  if (names.size < MIN_WORKSPACE_PACKAGES) {
    throw new Error(
      `guard-invariants: rule 20 resolved only ${names.size} workspace package name(s), ` +
        `below the floor of ${MIN_WORKSPACE_PACKAGES}. Every changeset is checked for ` +
        "membership in this set, so a derivation that has gone blind must fail rather " +
        "than pass everything. Check pnpm-workspace.yaml's globs against this function.",
    );
  }
  return names;
}

/**
 * The `package: bump` pairs a changeset's YAML frontmatter declares.
 *
 * Hand-parsed rather than run through a YAML library, because the frontmatter
 * changesets writes is one flat block of `"<name>": <bump>` and a dependency in
 * a plain-node gate is a cost this does not earn. An EMPTY block is legitimate
 * and common — `pnpm changeset add --empty` is the documented way to say a
 * change needs no release — so it parses to zero entries, not to an error.
 *
 * @param {string} source
 * @returns {{ entries: {name: string, bump: string, line: number}[] } | { error: string }}
 */
export function parseChangesetFrontmatter(source) {
  const lines = source.split("\n");
  if (lines[0]?.trim() !== "---") {
    return { error: "no YAML frontmatter — a changeset must open with `---`" };
  }
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (end === -1) return { error: "unterminated YAML frontmatter — no closing `---`" };

  const entries = [];
  for (let index = 1; index < end; index++) {
    const text = lines[index].trim();
    if (text === "" || text.startsWith("#")) continue;
    const match = /^(?<quote>["']?)(?<name>.+?)\k<quote>\s*:\s*(?<bump>\S+)\s*$/.exec(text);
    if (match?.groups === undefined) {
      return { error: `frontmatter line ${index + 1} is not \`"<package>": <bump>\`: ${text}` };
    }
    entries.push({ ...match.groups, line: index + 1 });
  }
  return { entries };
}

/**
 * One changeset's violations. Split from the scan so the gate's own spec can
 * feed it a positive and a negative sample — a scanner that reads the real tree
 * and finds nothing prints the same checkmark as an invariant being upheld.
 *
 * @param {string} file
 * @param {string} source
 * @param {Set<string>} known
 * @returns {{file: string, line: number, text: string}[]}
 */
export function checkChangeset(file, source, known) {
  const parsed = parseChangesetFrontmatter(source);
  if ("error" in parsed) return [{ file, line: 1, text: parsed.error }];

  const found = [];
  for (const { name, bump, line } of parsed.entries) {
    if (!known.has(name)) {
      found.push({ file, line, text: `"${name}" is not a workspace package` });
    } else if (!BUMP_TYPES.has(bump)) {
      found.push({ file, line, text: `"${name}" has bump type "${bump}"` });
    }
  }
  return found;
}

/**
 * @returns {{file: string, line: number, text: string}[]}
 */
export function scanChangesetPackageNames() {
  const known = workspacePackageNames();
  const files = git(["ls-files", "--", ".changeset"])
    .split("\n")
    .filter((file) => file.endsWith(".md") && !file.endsWith("/README.md"));

  const found = [];
  for (const file of files) {
    const source = readRepoFile(file);
    if (source === undefined) continue;
    found.push(...checkChangeset(file, source, known));
  }
  return found;
}
