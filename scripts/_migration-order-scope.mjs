// Copyright 2026 the AAI authors. MIT license.
/**
 * What `check:migration-order` decides, with nothing that reads the world.
 *
 * Split out for the reason `_deploy-changeset-scope.mjs` is: the gate spec in
 * `packages/aai-templates/` VALUE-imports these, and that package's tsconfig
 * pulls in no node types, so anything reaching a `node:` builtin is unimportable
 * there. A spec that regex-scraped the rules out of the gate instead is the
 * failure `guard-invariants-gate.test.ts` records against its own third draft:
 * the rules moved into a module, every per-rule assertion went vacuous, and the
 * run stayed green.
 *
 * Every function here is total and side-effect-free. The gate supplies the two
 * facts about the world — what this branch adds, and what the base already has
 * — and does the reporting.
 */

/**
 * Code-unit ordering, spelled out.
 *
 * A bare `.sort()` compares by UTF-16 code unit anyway, but saying so is the
 * standing rule for anything a gate reads: an implicit comparator is one
 * refactor away from `localeCompare`, which answers to the runtime's ICU
 * default and would make a gate report a locale difference as a finding.
 *
 * @param {string} a @param {string} b @returns {number}
 */
export function byCodeUnit(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** Where `supabase db push` looks, and therefore the only directory that counts. */
export const MIGRATIONS_PREFIX = "supabase/migrations/";

/**
 * The width of a Supabase migration version, and the reason a STRING compare is
 * a NUMERIC compare here.
 *
 * `supabase db push` orders by this prefix, and lexicographic and numeric order
 * agree only while every version is the same width — `9` sorts after `10` as
 * text. So the shape check is not cosmetic: it is what licenses every
 * comparison below to be a `<` on strings. A file that does not match is
 * reported rather than skipped, because the CLI would order it somewhere nobody
 * predicted.
 */
export const VERSION_DIGITS = 14;

const MIGRATION_FILENAME = new RegExp(`^(\\d{${VERSION_DIGITS}})_([^/]+)\\.sql$`);

/** @param {string} path @returns {boolean} */
export function isMigrationPath(path) {
  return path.startsWith(MIGRATIONS_PREFIX) && path.endsWith(".sql");
}

/**
 * The version a migration path declares, or `null` when the name is not one
 * `supabase db push` can place.
 *
 * @param {string} path A repo-relative path under {@link MIGRATIONS_PREFIX}.
 * @returns {string | null}
 */
export function migrationVersion(path) {
  const base = path.slice(path.lastIndexOf("/") + 1);
  return MIGRATION_FILENAME.exec(base)?.[1] ?? null;
}

/**
 * The migration paths whose filename the CLI cannot place.
 *
 * @param {readonly string[]} paths
 * @returns {string[]}
 */
export function malformedNames(paths) {
  return paths
    .filter((path) => isMigrationPath(path) && migrationVersion(path) === null)
    .sort(byCodeUnit);
}

/**
 * Versions claimed by more than one file.
 *
 * A distinct failure from being out of order and a worse one: `db push` keys its
 * history table by version, so of two files sharing one, the second is
 * indistinguishable from the first having already been applied — it is skipped
 * in silence, forever, on every environment. Tree-scoped, so it needs no diff.
 *
 * @param {readonly string[]} paths
 * @returns {{ version: string, files: string[] }[]}
 */
export function duplicateVersions(paths) {
  /** @type {Map<string, string[]>} */
  const byVersion = new Map();
  for (const path of paths) {
    if (!isMigrationPath(path)) continue;
    const version = migrationVersion(path);
    if (version === null) continue;
    byVersion.set(version, [...(byVersion.get(version) ?? []), path]);
  }
  return [...byVersion]
    .filter(([, files]) => files.length > 1)
    .map(([version, files]) => ({ version, files: files.sort(byCodeUnit) }))
    .sort((a, b) => byCodeUnit(a.version, b.version));
}

/**
 * The highest version among a set of migration paths, or `null` for none.
 *
 * @param {readonly string[]} paths
 * @returns {string | null}
 */
export function highestVersion(paths) {
  let highest = null;
  for (const path of paths) {
    if (!isMigrationPath(path)) continue;
    const version = migrationVersion(path);
    if (version === null) continue;
    if (highest === null || highest < version) highest = version;
  }
  return highest;
}

/**
 * The additions `supabase db push` will refuse.
 *
 * The rule, measured against the CLI rather than read off its docs (see
 * `check-migration-order.mjs` for the transcript): a pending file whose version
 * is not strictly greater than the last version in the remote history table
 * fails the whole push. `<=` and not `<`, because a tie is the duplicate case
 * above arriving between two trees rather than within one.
 *
 * @param {object} args
 * @param {readonly string[]} args.added Migration paths this branch introduces.
 * @param {string | null} args.baseHighest {@link highestVersion} of the base.
 * @returns {{ file: string, version: string }[]}
 */
export function refusedAdditions({ added, baseHighest }) {
  if (baseHighest === null) return [];
  return added
    .filter(isMigrationPath)
    .map((file) => ({ file, version: migrationVersion(file) }))
    .filter((entry) => entry.version !== null && entry.version <= baseHighest)
    .sort((a, b) => byCodeUnit(a.file, b.file));
}

/**
 * A version that would sort last, for the message to suggest.
 *
 * Deliberately derived from the BLOCKING version rather than from the clock: a
 * wall-clock stamp is what the refused files already had, and on a branch cut
 * before the blocker landed it would produce another one. Rounding up to the
 * next hour keeps it a legible timestamp instead of `…120001`.
 *
 * @param {string} baseHighest
 * @returns {string}
 */
export function nextFreeVersion(baseHighest) {
  const hour = baseHighest.slice(0, 10);
  return `${String(BigInt(hour) + 1n).padStart(10, "0")}0000`;
}
