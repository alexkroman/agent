// Copyright 2025 the AAI authors. MIT license.
import fs from "node:fs/promises";
import { consola } from "consola";

/** Resolve the working directory from INIT_CWD or process.cwd(). */
export function resolveCwd(): string {
  return process.env.INIT_CWD || process.cwd();
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
  } catch (error) {
    consola.debug(`File access check failed for ${p}:`, error);
    return false;
  }
}
