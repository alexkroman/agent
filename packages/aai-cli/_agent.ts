// Copyright 2025 the AAI authors. MIT license.
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureApiKey, readProjectConfig } from "./_config.ts";

export const DEFAULT_SERVER = "https://aai-agent.fly.dev";
export const DEFAULT_DEV_SERVER = "http://localhost:8080";

let cached: string | null | undefined;

export function getMonorepoRoot(): string | null {
  if (cached !== undefined) return cached;
  const cliDir = path.dirname(fileURLToPath(import.meta.url));
  for (const candidate of [path.resolve(cliDir, "../.."), path.resolve(cliDir, "../../..")]) {
    if (existsSync(path.join(candidate, "pnpm-workspace.yaml"))) {
      cached = candidate;
      return cached;
    }
  }
  cached = null;
  return cached;
}

export function isDevMode(): boolean {
  if (process.env.AAI_NO_DEV === "1") return false;
  return getMonorepoRoot() !== null;
}

export function resolveServerUrl(explicit?: string, configUrl?: string): string {
  if (explicit) return explicit;
  if (isDevMode()) return DEFAULT_DEV_SERVER;
  return configUrl ?? DEFAULT_SERVER;
}

export async function getServerInfo(
  cwd: string,
  explicitServer?: string,
  explicitApiKey?: string,
): Promise<{ serverUrl: string; slug: string; apiKey: string }> {
  const config = await readProjectConfig(cwd);
  if (!config) {
    throw new Error("No .aai/project.json found — run `aai deploy` first");
  }
  const apiKey = explicitApiKey ?? (await ensureApiKey());
  return {
    serverUrl: resolveServerUrl(explicitServer, config.serverUrl),
    slug: config.slug,
    apiKey,
  };
}
