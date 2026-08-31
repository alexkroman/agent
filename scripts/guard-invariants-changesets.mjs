/**
 * Rule 20 — a changeset names a real workspace package, a real bump type, and at
 * least one package changesets will actually VERSION.
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
 * Every workspace package, with whether its manifest marks it private.
 *
 * Separate from {@link workspacePackageNames} rather than folded into it: that
 * one answers "is this a real package", which is a question about the NAME, and
 * this one answers "will changesets version it", which is a question about the
 * manifest and the config together.
 *
 * @returns {{name: string, private: boolean}[]}
 */
function workspacePackages() {
  const dirs = readdirSync(new URL("../packages", import.meta.url), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `packages/${entry.name}`);

  const packages = [];
  for (const dir of [...dirs, "docs"]) {
    const source = readRepoFile(`${dir}/package.json`);
    if (source === undefined) continue;
    const { name, private: isPrivate } = JSON.parse(source);
    if (typeof name === "string" && name.length > 0) {
      packages.push({ name, private: isPrivate === true });
    }
  }
  return packages;
}

/**
 * The packages `changeset version` will actually bump, per `.changeset/config.json`.
 *
 * Two things take a package out of this set: membership in `ignore`, and being
 * PRIVATE while `privatePackages.version` is not enabled. Read from the config
 * rather than assumed, so the rule stays correct if either setting changes —
 * the point is to compare changesets against what versioning really does, and a
 * hardcoded answer here would be a second source of truth for it.
 *
 * @returns {Set<string>}
 */
export function versionablePackageNames() {
  const source = readRepoFile(".changeset/config.json");
  if (source === undefined)
    throw new Error("guard-invariants: rule 20 cannot read .changeset/config.json");
  const config = JSON.parse(source);
  const ignored = new Set(Array.isArray(config.ignore) ? config.ignore : []);
  // `privatePackages` may be `false`, absent, or `{version?, tag?}`. Absent and
  // `false` both mean private packages are NOT versioned.
  const privateVersion =
    config.privatePackages === true ||
    (config.privatePackages !== null &&
      typeof config.privatePackages === "object" &&
      config.privatePackages.version === true);

  const names = new Set();
  for (const { name, private: isPrivate } of workspacePackages()) {
    if (ignored.has(name)) continue;
    if (isPrivate && !privateVersion) continue;
    names.add(name);
  }
  return names;
}

/**
 * A changeset naming ONLY packages changesets will not version can never be
 * consumed, and it takes the whole release pipeline down with it.
 *
 * Measured on this repo, which is how the rule exists. Six changesets naming
 * only private packages sat on main with `privatePackages` unset. Every push
 * then ran `changesets/action`, which saw pending changesets and took the
 * VERSION path — where `changeset version` printed "All files have been updated"
 * and changed NOTHING: no bump, and the changeset files not even deleted. The
 * action committed nothing, force-pushed an empty `changeset-release/main`, and
 * died on
 *
 *     HttpError: Validation Failed: "No commits between main and
 *     changeset-release/main"
 *
 * Two consequences, and the second is the expensive one. The changesets can
 * never be consumed, so this repeats on every push to main forever. And because
 * the action only invokes `publish:` when there are NO pending changesets, the
 * already-bumped version is never published — while the guest snapshot image
 * installs the SDK from npm at exactly that version, so every sandbox spawn
 * fails `npm install @alexkroman1/aai@<version>` and no agent and no studio
 * session can start. A wedged release metadata file took production down.
 *
 * An EMPTY changeset is still legitimate and still spared: it names no package,
 * so it is consumed and bumps nothing, which is what `--empty` is for. What this
 * flags is a changeset that names packages and still cannot move any of them.
 *
 * @param {string} file
 * @param {string} source
 * @param {Set<string>} versionable
 * @returns {{file: string, line: number, text: string}[]}
 */
export function checkChangesetConsumable(file, source, versionable) {
  const parsed = parseChangesetFrontmatter(source);
  // A malformed changeset is checkChangeset's finding, not this one's — one
  // mistake should not be reported twice.
  if ("error" in parsed || parsed.entries.length === 0) return [];
  if (parsed.entries.some(({ name }) => versionable.has(name))) return [];

  const named = parsed.entries.map(({ name }) => name).join(", ");
  return [
    {
      file,
      line: parsed.entries[0].line,
      text:
        `names only packages changesets will not version (${named}), so it can never be ` +
        "consumed: `changeset version` changes nothing, the release action pushes an empty " +
        'branch and fails on "No commits between", and nothing is ever published again. ' +
        "Enable `privatePackages.version` in .changeset/config.json, or name a package it " +
        "will bump.",
    },
  ];
}

/**
 * Packages whose content reaches nobody on their OWN version bump, and what a
 * changeset must also name for the change to actually ship.
 *
 * Each of these is built into another package's artifact, so bumping it alone
 * writes a version and a CHANGELOG entry and ships nothing. The trap is that
 * every gate in the repo stays green: the pre-push hook's `changeset status`
 * only asks whether the changed packages have A changeset, so an author who
 * changes the studio front-end, is correctly told to write a changeset, and
 * names the package they changed, has satisfied every check and deployed
 * nothing.
 *
 * `packages/aai-studio-client/CLAUDE.md` states the studio case outright — "This
 * package ships only as a side effect of a SERVER release" — and it was guarded
 * by nothing.
 *
 * Two packages are deliberately absent. `aai-evals` ships nowhere by design, so
 * there is no delivery to strand. `docs` has its own path (`docs.yml` publishes
 * on a push to main, keyed to no version at all).
 */
const SHIPS_VIA = [
  {
    // The studio front-end's `dist/` is baked into the one Modal app's image,
    // and the deploy fires on a version bump to the server or the studio
    // server — never on this package's own.
    name: "aai-studio-client",
    carriers: ["aai-server", "aai-studio-server"],
    via: "its dist/ is baked into the one Modal app's image",
  },
  {
    // The harness is baked into the guest image, whose tag is content-addressed
    // and PINNED by the server at deploy time. Publishing a new image is not
    // enough: an already-deployed server keeps asking for the tag it pinned, so
    // a guest change reaches production only through a deploy.
    name: "aai-guest",
    carriers: ["aai-server", "aai-studio-server"],
    via: "its harness is baked into the guest image, whose tag the server pins at deploy time",
  },
  {
    // `aai-cli/bundle-templates.mjs` copies the templates and the scaffold into
    // the CLI's dist at build time, so they reach a user when the CLI
    // publishes. Any of the fixed four bumps all four.
    name: "aai-templates",
    carriers: [
      "@alexkroman1/aai",
      "@alexkroman1/aai-cli",
      "@alexkroman1/aai-runtime",
      "@alexkroman1/aai-ui",
    ],
    via: "its templates are copied into the @alexkroman1/aai-cli tarball at build time",
  },
];

/**
 * The floor under {@link SHIPS_VIA}'s own names.
 *
 * Every entry is matched by NAME against a changeset, so a table whose packages
 * had been renamed would silently match nothing and this rule would report `0 ✓`
 * over the exact hole it exists to close — the shape the whole gate is built
 * against. Checked against the real workspace rather than trusted.
 *
 * @param {Set<string>} known - every workspace package name
 */
function assertShipsViaResolves(known) {
  for (const { name, carriers } of SHIPS_VIA) {
    for (const entry of [name, ...carriers]) {
      if (!known.has(entry)) {
        throw new Error(
          `guard-invariants: rule 29's SHIPS_VIA names "${entry}", which is not a workspace ` +
            "package any more. Fix the table — a name that matches nothing makes this rule " +
            "report zero violations over the hole it exists to close.",
        );
      }
    }
  }
}

/**
 * A changeset that bumps a package with no ship path of its own, and names
 * nothing that carries it.
 *
 * The sibling of {@link checkChangesetConsumable}: that one catches a changeset
 * `changeset version` cannot CONSUME, and this one catches a changeset it
 * consumes happily whose content then reaches nothing. Both are release metadata
 * that looks like a release and is not.
 *
 * A changeset naming a carrier ALONGSIDE the built-in package is correct and
 * passes — that is the ordinary case and the remedy. An empty changeset is
 * spared for the same reason it is everywhere else: it names nothing, so it
 * claims nothing.
 *
 * @param {string} file
 * @param {string} source
 * @returns {{file: string, line: number, text: string}[]}
 */
export function checkChangesetShippable(file, source) {
  const parsed = parseChangesetFrontmatter(source);
  // A malformed changeset is checkChangeset's finding — not reported twice.
  if ("error" in parsed || parsed.entries.length === 0) return [];
  const named = new Set(parsed.entries.map(({ name }) => name));

  const found = [];
  for (const { name, carriers, via } of SHIPS_VIA) {
    if (!named.has(name)) continue;
    if (carriers.some((carrier) => named.has(carrier))) continue;
    const line = parsed.entries.find((entry) => entry.name === name)?.line ?? 1;
    found.push({
      file,
      line,
      text:
        `bumps ${name}, which reaches nobody on its own version: ${via}. ` +
        `Name one of ${carriers.join(", ")} as well, or make this an \`--empty\` changeset ` +
        "if the change really is not meant to ship.",
    });
  }
  return found;
}

/**
 * @returns {{file: string, line: number, text: string}[]}
 */
export function scanChangesetPackageNames() {
  const known = workspacePackageNames();
  assertShipsViaResolves(known);
  const versionable = versionablePackageNames();
  const files = git(["ls-files", "--", ".changeset"])
    .split("\n")
    .filter((file) => file.endsWith(".md") && !file.endsWith("/README.md"));

  const found = [];
  for (const file of files) {
    const source = readRepoFile(file);
    if (source === undefined) continue;
    found.push(...checkChangeset(file, source, known));
    found.push(...checkChangesetConsumable(file, source, versionable));
    found.push(...checkChangesetShippable(file, source));
  }
  return found;
}
