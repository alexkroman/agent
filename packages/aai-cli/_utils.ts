// Copyright 2025 the AAI authors. MIT license.
import fs from "node:fs/promises";
import { consola } from "consola";

/** Resolve the working directory from INIT_CWD or process.cwd(). */
export function resolveCwd(): string {
  return process.env.INIT_CWD || process.env.PWD || process.cwd();
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
