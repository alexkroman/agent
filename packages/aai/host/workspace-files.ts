// Copyright 2026 the AAI authors. MIT license.
/**
 * What a workspace IS on disk — the walk, the skip rules, the caps, and the
 * strict decode — shared by every side that snapshots one.
 *
 * A studio project's file map is written from two ends: `aai push` walks a
 * local project (`aai-cli/_studio.ts`) and the guest's coding agent syncs its
 * scratch tree back at end of turn (`aai-guest/studio-workspace-fs.ts`),
 * while the platform validates what arrives (`aai-studio-server`). All three
 * had their own copy of the same rules, and the guest's carried a comment
 * saying the copies "must agree" — which is the whole problem: when they
 * disagree the symptom is not an error but a file silently dropped on one
 * path and resurrected on the other.
 *
 * It lives in the SDK rather than the CLI because the guest bundles the SDK
 * into `harness.mjs` while the CLI toolchain is resolved at runtime from the
 * baked image: importing the CLI here would make a workspace sync depend on
 * the toolchain being present, which it otherwise need not be.
 *
 * @internal Not part of the published API surface — see the `./workspace-files`
 * subpath, which exists for the workspace packages rather than for SDK users.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

/**
 * Max bytes for a single workspace file. Both ends check it before the row
 * write, so an oversized file is a named warning where the user (or the
 * agent) can act on it rather than a rejected upload after the fact.
 */
export const MAX_WORKSPACE_FILE_BYTES = 256_000;

/** Max files in one workspace. */
export const MAX_WORKSPACE_FILES = 100;

/** Directories never walked — never listed, grepped, or synced. */
export const IGNORED_WORKSPACE_DIRS: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  "dist",
  ".aai",
  // The local workflow world's run state under `aai dev` (`WORKFLOW_LOCAL_DATA_DIR`
  // — see `host/workflow-world.ts`). It is a journal of runs, one file per event:
  // machine state, unbounded, and meaningless anywhere but the machine that
  // wrote it. Pushed, it would spend the 100-file workspace cap on it.
  ".workflow-data",
  // @swc/core's plugin cache, written into the project by the workflow builder.
  // Same class: a build artifact of whoever last ran a build, not source.
  ".swc",
]);

/**
 * Package-manager lockfiles — a resolved tree, not source.
 *
 * They are their own list because BOTH ends of the round trip have to drop
 * them, for the same reason and by different routes: the CLI's push, via
 * {@link LOCAL_ONLY_FILES}, and the guest's end-of-turn sync, which otherwise
 * uploads one it wrote itself. `add_dependency` runs `npm install`, which
 * reifies the whole manifest — SDK, React, Tailwind and their transitive
 * trees — so the lockfile it leaves is ~100 KB after three ordinary
 * dependencies and dwarfs the source it rides with. Kept, it would be most of
 * every turn's sync payload, ~40% of the 256 KB per-file cap, a file the
 * coding agent's `list_files`/`read_file` can spend context on, and — since
 * `aai pull` materializes whatever the row holds — an npm lockfile landing in
 * a project whose package.json declares pnpm.
 *
 * Nothing is lost by dropping it: package.json is the durable declaration,
 * and any install regenerates the tree from it.
 */
export const LOCKFILES: readonly RegExp[] = [
  /^pnpm-lock\.yaml$/,
  /^package-lock\.json$/,
  /^npm-shrinkwrap\.json$/,
  /^yarn\.lock$/,
  /^bun\.lockb?$/,
];

/** True when `name` is a package-manager lockfile. */
export function isLockfile(name: string): boolean {
  return LOCKFILES.some((re) => re.test(name));
}

/**
 * Files that exist only on a developer's machine and must never reach a
 * workspace row: secrets (`.env` rides the secret routes) and lockfiles.
 *
 * Applied WHOLE by the CLI's push only. The guest applies just the lockfile
 * half ({@link isLockfile}) — its walk also backs the coding agent's
 * `list_files`/`grep`, and hiding a `.env` the agent itself wrote would make
 * it invisible to the tool that needs to read it, whereas a lockfile is one
 * the agent has no reason to read and did not author.
 *
 * **`.env.example` is EXCLUDED, because it is the opposite of a secret.** The
 * scaffold ships one and its `.gitignore` un-ignores it by name
 * (`.env`/`.env.*` then `!.env.example`), so the project's own declaration is
 * that this file is committed source — the single place an author writes down
 * which secrets their agent needs. Caught by `^\.env(\..+)?$` it was dropped
 * from every `aai push` with no warning (the skip rule is silent, correctly,
 * for a real `.env`) and then re-supplied from the scaffold by the next
 * `aai pull`, so a user's documentation round-tripped back to boilerplate.
 * It is also what makes {@link isLocalOnlyFile} usable as the filter for a
 * template COPY, where dropping the scaffold's copy would leave a scaffolded
 * project with no `.env` at all.
 */
export const LOCAL_ONLY_FILES: readonly RegExp[] = [
  /^\.env(?!\.example$)(\..+)?$/,
  ...LOCKFILES,
  /^\.DS_Store$/,
];

/** True when `name` matches {@link LOCAL_ONLY_FILES}. */
export function isLocalOnlyFile(name: string): boolean {
  return LOCAL_ONLY_FILES.some((re) => re.test(name));
}

/**
 * Decode `buf` as UTF-8, or null when it isn't valid UTF-8.
 *
 * `fatal` makes an invalid sequence throw instead of becoming U+FFFD, which
 * is the whole point: a workspace is a JSON path→string map and cannot carry
 * arbitrary bytes, so a lossy read turned a pushed PNG into replacement
 * characters while reporting success — and a later `aai pull` wrote the
 * mangled version back over the local original. `ignoreBOM` keeps a leading
 * U+FEFF in the string; without it the decoder strips the BOM and the check
 * meant to stop corruption would quietly perform some of its own.
 */
const UTF8_STRICT = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
export function decodeWorkspaceText(buf: Uint8Array): string | null {
  try {
    return UTF8_STRICT.decode(buf);
  } catch {
    return null;
  }
}

/** Options shared by the walk and the snapshot. */
export type WorkspaceWalkOptions = {
  /** Extra per-FILE skip, by basename. Directories use {@link IGNORED_WORKSPACE_DIRS}. */
  skipFile?: ((name: string) => boolean) | undefined;
};

/**
 * Workspace-relative paths of every non-ignored file under `dir`, sorted.
 * Symlinks are skipped entirely — a workspace is a file map, and following
 * one would let a link escape the tree it claims to describe.
 */
export async function walkWorkspaceFiles(
  dir: string,
  opts: WorkspaceWalkOptions = {},
): Promise<string[]> {
  const out: string[] = [];
  await walkInto(dir, dir, opts.skipFile, out);
  return out.sort((a, b) => a.localeCompare(b));
}

/**
 * One directory level of {@link walkWorkspaceFiles}, appending into `out`.
 *
 * Sibling directories are descended CONCURRENTLY, for the same reason
 * {@link snapshotWorkspaceFiles} reads its files that way: each `readdir` is
 * independent I/O, and awaiting them one at a time made the walk's cost the SUM
 * of every directory's latency down every branch. Interleaving cannot disturb
 * the result — `walkWorkspaceFiles` sorts, so `out`'s order was never load
 * bearing — and the fan-out is bounded in practice by
 * {@link IGNORED_WORKSPACE_DIRS} keeping `node_modules` and friends out of the
 * tree entirely.
 */
async function walkInto(
  root: string,
  current: string,
  skipFile: ((name: string) => boolean) | undefined,
  out: string[],
): Promise<void> {
  const descend: Promise<void>[] = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const abs = path.join(current, entry.name);
    if (entry.isDirectory()) {
      if (!IGNORED_WORKSPACE_DIRS.has(entry.name)) descend.push(walkInto(root, abs, skipFile, out));
    } else if (entry.isFile() && !skipFile?.(entry.name)) {
      out.push(path.relative(root, abs));
    }
  }
  await Promise.all(descend);
}

export type WorkspaceSnapshot = {
  files: Record<string, string>;
  /** Named, per-file reasons something was left out. Never silent. */
  warnings: string[];
};

/**
 * Read `dir` into a workspace file map, skipping (and NAMING) what cannot be
 * carried: too many files, an oversized one, or bytes that aren't UTF-8.
 *
 * Files are read concurrently — they are independent, and a snapshot reads up
 * to {@link MAX_WORKSPACE_FILES} of them — but results are consumed in path
 * order so the map and the warning list stay deterministic.
 */
export async function snapshotWorkspaceFiles(
  dir: string,
  opts: WorkspaceWalkOptions & {
    /** What the warnings call this tree ("Project" for a push). */
    subject?: string | undefined;
  } = {},
): Promise<WorkspaceSnapshot> {
  const subject = opts.subject ?? "Workspace";
  const paths = await walkWorkspaceFiles(dir, opts);
  const warnings: string[] = [];
  if (paths.length > MAX_WORKSPACE_FILES) {
    warnings.push(
      `${subject} has ${paths.length} files; only the first ${MAX_WORKSPACE_FILES} sync.`,
    );
  }
  type Read = { ok: true; rel: string; content: string } | { ok: false; warning: string };
  const read = await Promise.all(
    paths.slice(0, MAX_WORKSPACE_FILES).map(async (rel): Promise<Read> => {
      const abs = path.join(dir, rel);
      const { size } = await stat(abs);
      if (size > MAX_WORKSPACE_FILE_BYTES) {
        return {
          ok: false,
          warning: `${rel} is ${size} bytes (max ${MAX_WORKSPACE_FILE_BYTES}) — not synced.`,
        };
      }
      const content = decodeWorkspaceText(await readFile(abs));
      return content === null
        ? { ok: false, warning: `${rel} is not valid UTF-8 (binary file?) — not synced.` }
        : { ok: true, rel, content };
    }),
  );

  const files: Record<string, string> = {};
  for (const entry of read) {
    if (entry.ok) files[entry.rel] = entry.content;
    else warnings.push(entry.warning);
  }
  return { files, warnings };
}
