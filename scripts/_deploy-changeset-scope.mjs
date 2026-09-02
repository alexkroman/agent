// Copyright 2026 the AAI authors. MIT license.
/**
 * What `check-deploy-changeset.mjs` DECIDES, with no I/O in it.
 *
 * Its own module for the reason `guard-invariants-rules.mjs` is:
 * `packages/aai-templates/deploy-changeset-gate.test.ts` value-imports these,
 * so a positive and a negative sample are fed to the real predicate rather than
 * to a regex scraped out of the gate's source. That spec's own third draft is
 * the argument — it scraped `re: "…"` out of a gate, the rules moved into a
 * module, and every per-rule assertion went vacuous while still printing green.
 *
 * Nothing here imports anything, which is the property that makes the import
 * legal from a package whose tsconfig has no node types. The gate script owns
 * every read: git, the changeset files, and the floors.
 */

/**
 * Every package whose content reaches production ONLY through a platform
 * deploy.
 *
 * - `aai-server`, `aai-studio-server` — the platform itself.
 * - `aai-studio-client` — its `dist/` is baked into the one Modal app's image.
 * - `aai-guest` — its harness is baked into the guest image, whose tag the
 *   server PINS at deploy time, so publishing a new image is not enough: an
 *   already-deployed server keeps asking for the tag it pinned.
 *
 * The last two are the rows `guard-invariants` rule 20's `SHIPS_VIA` table
 * already carries, and for the same reason.
 */
export const DEPLOY_CARRIED = ["aai-server", "aai-studio-server", "aai-studio-client", "aai-guest"];

/**
 * The packages whose VERSION BUMP arms `ship.yml`'s deploy job.
 *
 * Both, not one: there is a single Modal app serving both surfaces from the
 * `aai-studio-server` entry, and `ship.yml`'s own comment records that gating
 * on `aai-server` alone strands every studio-only release.
 */
export const DEPLOY_CARRIERS = ["aai-server", "aai-studio-server"];

/**
 * Does this path hold bytes a deploy actually ships?
 *
 * The exclusions are the things that unambiguously never reach a container:
 * tests and their helpers, markdown, coverage output, and the config files that
 * configure only the test and build tooling. Everything else counts — INCLUDING
 * `package.json`, `tsconfig.json`, `guest-image.Dockerfile`, `modal_deploy.py`,
 * `index.html`, `styles.css` and the `.woff2` fonts.
 *
 * Inclusive on purpose, because the two errors do not cost the same: a false
 * trigger costs one line in a changeset, and a miss costs a merge that shipped
 * nothing — which is the entire failure this gate exists for. So a path is
 * shipped unless there is a stated reason it is not.
 *
 * @param {string} path Repo-relative, forward slashes.
 * @returns {boolean}
 */
export function isShippedSource(path) {
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (path.includes("/coverage/")) return false;
  if (name.endsWith(".md")) return false;
  // `.test-d.ts` is checked by tsc and never executed; both are test files.
  if (/\.test\.tsx?$|\.test-d\.ts$/.test(name)) return false;
  // `test-utils.ts`, `_test-utils.ts` and the ten `_<area>-test-utils.ts` in
  // these four packages. Matched on the infix rather than listed, for the same
  // reason the test tiers are: a new one lands correctly with no edit here.
  if (name.includes("test-utils.")) return false;
  if (name === "_test-setup.ts" || name === "_jsdom-setup.ts") return false;
  if (name === "turbo.json") return false;
  if (/^vitest(\..+)?\.config\.ts$/.test(name)) return false;
  if (name === ".gitignore" || name === ".gitkeep") return false;
  if (name === ".env.example" || name === ".node-version") return false;
  return true;
}

/**
 * The changed files a deploy carries, grouped by their package.
 *
 * @param {readonly string[]} changed Repo-relative paths.
 * @returns {Map<string, string[]>} Keyed by `DEPLOY_CARRIED` entry, empty when
 *   nothing a deploy carries changed.
 */
export function triggeringFiles(changed) {
  /** @type {Map<string, string[]>} */
  const byPackage = new Map();
  for (const path of changed) {
    const pkg = DEPLOY_CARRIED.find((name) => path.startsWith(`packages/${name}/`));
    if (pkg === undefined || !isShippedSource(path)) continue;
    const bucket = byPackage.get(pkg);
    if (bucket === undefined) byPackage.set(pkg, [path]);
    else bucket.push(path);
  }
  return byPackage;
}

/**
 * The carriers a branch's changesets name.
 *
 * Takes PARSED frontmatter entries rather than sources, so this module stays
 * import-free and the gate keeps the one parser — rule 20's
 * `parseChangesetFrontmatter`. A gate that read the block differently from the
 * rule policing the block would be two answers to one question.
 *
 * @param {readonly {name: string}[]} entries Every `package: bump` pair the
 *   branch's changesets declare, from any number of files.
 * @returns {string[]} Sorted, deduplicated.
 */
export function namedCarriers(entries) {
  const named = new Set();
  for (const { name } of entries) {
    if (DEPLOY_CARRIERS.includes(name)) named.add(name);
  }
  return [...named].sort();
}
