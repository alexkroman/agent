// Copyright 2026 the AAI authors. MIT license.
/**
 * The AssemblyAI key the repo's own scripts run on.
 *
 * These are developer tools, not the CLI: they spend the RUNNER's key, not an
 * end user's, so unlike `ensureApiKey` (see `packages/aai-cli/CLAUDE.md` for
 * why that one has exactly one source) an exported `ASSEMBLYAI_API_KEY` is a
 * legitimate way to point a script at a different account for one run.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/** The exported key if set, else the one `aai login` saved. Throws if neither. */
export function apiKey() {
  if (process.env.ASSEMBLYAI_API_KEY) return process.env.ASSEMBLYAI_API_KEY;
  const cfg = path.join(homedir(), ".config", "aai", "config.json");
  const key = JSON.parse(readFileSync(cfg, "utf-8")).apiKey;
  if (!key) throw new Error("no apiKey in ~/.config/aai/config.json");
  return key;
}
