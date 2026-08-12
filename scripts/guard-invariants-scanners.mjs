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
