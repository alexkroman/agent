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

/** True when `err` is a filesystem EEXIST error (target already exists). */
export function isEexist(err: unknown): boolean {
  return err instanceof Error && "code" in err && err.code === "EEXIST";
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

/** Read and parse a JSON file. Returns null if the file is missing or malformed. */
export async function readJson(filePath: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf-8"));
  } catch {
    return null;
  }
}

/** Write `data` as pretty-printed JSON (+ trailing newline), creating parent dirs. */
export async function writeJson(filePath: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`);
}
