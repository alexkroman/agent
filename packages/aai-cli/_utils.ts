// Copyright 2025 the AAI authors. MIT license.
import fs from "node:fs/promises";
import path from "node:path";

/** Resolve the working directory from INIT_CWD or process.cwd(). */
export function resolveCwd(): string {
  return process.env.INIT_CWD || process.cwd();
}

/**
 * Extract a message from an unknown error. Local copy of `errorMessage` from
 * `@alexkroman1/aai` — importing the root barrel pulls zod into every CLI
 * invocation (including `aai --help`), so the one-liner lives here instead.
 */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Extract a stack (falling back to the message) from an unknown error. Local
 * copy of `errorDetail` from `@alexkroman1/aai` for the same reason as
 * {@link errorMessage} above.
 */
export function errorDetail(err: unknown): string {
  return err instanceof Error ? (err.stack ?? err.message) : String(err);
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
 * Two concurrent CLI processes can still lose each other's *updates*
 * (last rename wins) — acceptable for these small user-config files.
 */
export async function writeJson(filePath: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await fs.writeFile(tmpPath, `${JSON.stringify(data, null, 2)}\n`);
  try {
    await fs.rename(tmpPath, filePath);
  } catch (err) {
    await fs.rm(tmpPath, { force: true }).catch(() => undefined);
    throw err;
  }
}
