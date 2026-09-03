// Copyright 2025 the AAI authors. MIT license.
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
// The `/utils` subpath is deliberately zod-free, so re-exporting from it
// keeps `aai --help` from paying zod's startup cost (the root barrel would).
import { errorMessage, omitUndefined } from "@alexkroman1/aai/utils";

export { errorDetail, errorMessage } from "@alexkroman1/aai/utils";

/**
 * The file that marks a directory as an agent project — the single source
 * for the entry filename every command checks or scaffolds.
 */
export const AGENT_ENTRY = "agent.ts";

/** Resolve the working directory from INIT_CWD or process.cwd(). */
export function resolveCwd(): string {
  return process.env.INIT_CWD || process.cwd();
}

/** The `code` of a Node errno-style error (`"ENOENT"`, `"EPIPE"`, …), or undefined. */
export function errorCode(err: unknown): string | undefined {
  return err instanceof Error && "code" in err && typeof err.code === "string"
    ? err.code
    : undefined;
}

/** True when `err` is a filesystem EEXIST error (target already exists). */
export function isEexist(err: unknown): boolean {
  return errorCode(err) === "EEXIST";
}

/** Validate that a module's default export is a valid agent definition. Throws if invalid. */
// biome-ignore lint/suspicious/noExplicitAny: agent state type varies per agent
export function validateAgentExport(mod: any): void {
  if (!mod?.name || typeof mod.name !== "string") {
    throw new Error("agent.ts must export default agent({ name: ... })");
  }
}

/** The fields of an installed package's manifest that this CLI reads. */
export type PackageManifest = {
  bin?: string | Record<string, string>;
  version?: string;
};

/**
 * Read and parse a package.json SYNCHRONOUSLY.
 *
 * Separate from {@link binFromPackageJson} so a caller that needs two fields
 * pays for one read and one parse. `resolveTsc` needed exactly that: it read
 * the TypeScript manifest for the bin and then again for the version, on a
 * path that runs after every settled write burst in the studio.
 */
export function readPackageJson(pkgJsonPath: string): PackageManifest {
  return JSON.parse(readFileSync(pkgJsonPath, "utf-8")) as PackageManifest;
}

/**
 * Absolute path of `binName`'s script declared by `manifest`, which was read
 * from `pkgJsonPath` — or undefined when the package declares no such bin.
 * Handles both `"bin": "script.js"` and `"bin": { name: "script.js" }`.
 */
export function binFromManifest(
  pkgJsonPath: string,
  manifest: PackageManifest,
  binName: string,
): string | undefined {
  const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.[binName];
  return bin ? path.join(path.dirname(pkgJsonPath), bin) : undefined;
}

/** {@link binFromManifest} for a caller that needs nothing else from the file. */
export function binFromPackageJson(pkgJsonPath: string, binName: string): string | undefined {
  return binFromManifest(pkgJsonPath, readPackageJson(pkgJsonPath), binName);
}

export async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read and parse a JSON file. Returns null only when the file does not exist
 * (ENOENT — the "optional file" case). A file that exists but cannot be read
 * (EACCES, …) or parsed throws instead: treating a corrupted file as absent
 * hides real problems — e.g. a corrupted `.aai/project.json` would silently
 * deploy under a NEW slug, orphaning the live deployment.
 */
export async function readJson(filePath: string): Promise<unknown> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch (err) {
    if (errorCode(err) === "ENOENT") return null;
    throw err;
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid JSON in ${filePath}: ${errorMessage(err)}`, { cause: err });
  }
}

/**
 * Write `data` as pretty-printed JSON (+ trailing newline), creating parent dirs.
 *
 * Writes to a temp file in the same directory, then renames it into place.
 * A plain `writeFile` can be observed (or left, on crash) half-written; a
 * torn config.json fails `JSON.parse`, reads back as `{}`, and the next
 * read-modify-write silently wipes fields like `approvedServers`. Rename on
 * the same filesystem is atomic, so readers only ever see a complete file.
 *
 * Atomic per WRITE is not atomic per read-modify-write: two concurrent CLI
 * processes still lose each other's *updates* (last rename wins). That was
 * long documented here as acceptable "for these small user-config files",
 * and it is — for `.aai/project.json`, which is per-directory. It is NOT
 * acceptable for the GLOBAL config, where it dropped the API key a
 * successful `aai login` had just reported saving. Every global-config
 * update therefore goes through `updateGlobalConfig` in `_config.ts`, which
 * holds a cross-process lock around the read and the write.
 *
 * `mode` restricts the file's permissions (the rename carries the temp
 * file's mode to the destination, so an existing world-readable file is
 * tightened on the next write). The parent directory is created 0o700 in
 * that case so a fresh config dir never goes through a readable window.
 */
export async function writeJson(
  filePath: string,
  data: unknown,
  opts: { mode?: number } = {},
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), {
    recursive: true,
    ...(opts.mode !== undefined ? { mode: 0o700 } : {}),
  });
  const tmpPath = `${filePath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await fs.writeFile(
    tmpPath,
    `${JSON.stringify(data, null, 2)}\n`,
    omitUndefined({ mode: opts.mode }),
  );
  try {
    await fs.rename(tmpPath, filePath);
  } catch (err) {
    await fs.rm(tmpPath, { force: true }).catch(() => undefined);
    throw err;
  }
}
