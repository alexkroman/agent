// Copyright 2026 the AAI authors. MIT license.
/**
 * The studio workspace's filesystem primitives — walking, snapshotting, and
 * materializing the session's scratch tree. Split from studio-tools.ts,
 * which defines the coding agent's tool set over these; the harness and the
 * chat surface use them directly (session init, mid-turn checkpoints, the
 * end-of-turn sync).
 */

import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { MAX_STUDIO_FILE_BYTES, MAX_STUDIO_FILES } from "./limits.ts";

/** Directories never listed, grepped, or synced back to the workspace. */
const IGNORED_DIRS = new Set(["node_modules", ".git", "dist", ".aai"]);

/** Resolve a workspace-relative path, refusing escapes from the root. */
export function resolveInside(dir: string, rel: string): string {
  const abs = path.resolve(dir, rel);
  if (abs !== dir && !abs.startsWith(dir + path.sep)) {
    throw new Error(`Path escapes the workspace: ${rel}`);
  }
  return abs;
}

/** Workspace-relative paths of all non-ignored files under `dir`. */
export async function walkWorkspace(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) await walk(path.join(current, entry.name));
        continue;
      }
      if (entry.isFile()) out.push(path.relative(dir, path.join(current, entry.name)));
    }
  }
  await walk(dir);
  return out.sort((a, b) => a.localeCompare(b));
}

/**
 * Decode `buf` as UTF-8, or null when it isn't valid UTF-8.
 *
 * `fatal` turns an invalid sequence into a throw rather than U+FFFD: the
 * workspace row is a JSON path→string map, so a lossy read would sync a
 * mangled copy of a real binary back as the project's own source. `bash`
 * makes that reachable (a curl'd image, a stray build artifact).
 * `ignoreBOM` keeps a leading U+FEFF instead of silently dropping it.
 *
 * Mirrors `decodeUtf8` in aai-cli/_studio.ts — the two snapshot the same
 * shape from opposite ends and their skip rules must agree.
 */
const UTF8_STRICT = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
function decodeUtf8(buf: Buffer): string | null {
  try {
    return UTF8_STRICT.decode(buf);
  } catch {
    return null;
  }
}

/**
 * Snapshot the workspace as a path→content record — the shape builds and
 * the host sync speak. Files over the store's byte cap, and files that
 * aren't valid UTF-8, are skipped with a warning entry so a
 * `bash`-generated artifact can't wedge every sync or corrupt the project.
 */
export async function snapshotWorkspace(
  dir: string,
): Promise<{ files: Record<string, string>; warnings: string[] }> {
  const files: Record<string, string> = {};
  const warnings: string[] = [];
  const paths = await walkWorkspace(dir);
  if (paths.length > MAX_STUDIO_FILES) {
    warnings.push(
      `Workspace has ${paths.length} files; only the first ${MAX_STUDIO_FILES} sync to the project ` +
        "(delete extras, and keep generated artifacts out of the workspace root).",
    );
  }
  // Concurrent reads, order-stable results: this runs after every mutating
  // tool step and at every turn settle, so serial stat+read round trips are
  // hot-path latency.
  const read = await Promise.all(
    paths.slice(0, MAX_STUDIO_FILES).map(async (rel) => {
      const st = await stat(path.join(dir, rel));
      if (st.size > MAX_STUDIO_FILE_BYTES) {
        return {
          rel,
          content: null,
          warning: `${rel} is ${st.size} bytes (max ${MAX_STUDIO_FILE_BYTES}) — not synced.`,
        };
      }
      const content = decodeUtf8(await readFile(path.join(dir, rel)));
      if (content === null) {
        return {
          rel,
          content: null,
          warning: `${rel} is not valid UTF-8 (binary file?) — not synced.`,
        };
      }
      return { rel, content, warning: null };
    }),
  );
  for (const entry of read) {
    if (entry.content === null) warnings.push(entry.warning ?? "");
    else files[entry.rel] = entry.content;
  }
  return { files, warnings };
}

/** Materialize a files record into `dir`, replacing whatever was there. */
export async function materializeWorkspace(
  dir: string,
  files: Record<string, string>,
): Promise<void> {
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  await Promise.all(
    Object.entries(files).map(async ([rel, content]) => {
      const abs = resolveInside(dir, rel);
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, content, "utf-8");
    }),
  );
}
