// Copyright 2025 the AAI authors. MIT license.
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readProjectConfig } from "./_config.ts";
import { resolveServerEnv } from "./_server-common.ts";

export const DEFAULT_SERVER = "https://aai-agent.fly.dev";
export const DEFAULT_DEV_SERVER = "http://localhost:8080";

let _cachedMonorepoRoot: string | null | undefined;

export function getMonorepoRoot(): string | null {
  if (_cachedMonorepoRoot !== undefined) return _cachedMonorepoRoot;
  const cliDir = path.dirname(fileURLToPath(import.meta.url));
  const root1 = path.resolve(cliDir, "../..");
  const root2 = path.resolve(cliDir, "../../..");
  if (existsSync(path.join(root1, "pnpm-workspace.yaml"))) _cachedMonorepoRoot = root1;
  else if (existsSync(path.join(root2, "pnpm-workspace.yaml"))) _cachedMonorepoRoot = root2;
  else _cachedMonorepoRoot = null;
  return _cachedMonorepoRoot;
}

export function isDevMode(): boolean {
  return getMonorepoRoot() !== null;
}

export function resolveServerUrl(explicit?: string, configUrl?: string): string {
  if (explicit) return explicit;
  if (isDevMode()) return DEFAULT_DEV_SERVER;
  return configUrl ?? DEFAULT_SERVER;
}

export async function getServerInfo(cwd: string, explicitServer?: string, explicitApiKey?: string) {
  const config = await readProjectConfig(cwd);
  if (!config) {
    throw new Error("No .aai/project.json found — run `aai deploy` first");
  }
  let apiKey = explicitApiKey;
  if (!apiKey) {
    const env = await resolveServerEnv(cwd);
    apiKey = env.ASSEMBLYAI_API_KEY;
  }
  if (!apiKey) {
    throw new Error(
      "No ASSEMBLYAI_API_KEY found in .env file. Add it to your agent's .env:\n\n" +
        "  ASSEMBLYAI_API_KEY=your-key-here",
    );
  }
  const serverUrl = resolveServerUrl(explicitServer, config.serverUrl);
  return { serverUrl, slug: config.slug, apiKey };
}
