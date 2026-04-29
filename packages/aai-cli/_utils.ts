// Copyright 2025 the AAI authors. MIT license.
import fs from "node:fs/promises";

export function resolveCwd(): string {
  return process.env.INIT_CWD || process.cwd();
}

// biome-ignore lint/suspicious/noExplicitAny: agent state type varies per agent
export function validateAgentExport(mod: any): void {
  if (typeof mod?.name !== "string" || mod.name.length === 0) {
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
