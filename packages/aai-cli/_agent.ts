// Copyright 2025 the AAI authors. MIT license.
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureApiKey, readProjectConfig } from "./_config.ts";

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
  if (process.env.AAI_NO_DEV === "1") return false;
  return getMonorepoRoot() !== null;
}

// Callers join paths with `${serverUrl}/...` — strip trailing slashes once at
// resolution time so a hand-typed `--server https://x.dev/` can't produce `//deploy`.
function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

export function resolveServerUrl(explicit?: string, configUrl?: string): string {
  if (explicit) return stripTrailingSlash(explicit);
  if (isDevMode()) return DEFAULT_DEV_SERVER;
  return stripTrailingSlash(configUrl ?? DEFAULT_SERVER);
}

/**
 * Resolve everything needed to talk to the platform: project config (null if
 * the project has never been deployed), server URL, and API key.
 */
export async function resolveDeployTarget(cwd: string, explicitServer?: string) {
  const config = await readProjectConfig(cwd);
  const apiKey = await ensureApiKey();
  const serverUrl = resolveServerUrl(explicitServer, config?.serverUrl);
  return { config, serverUrl, apiKey };
}

/** Like resolveDeployTarget, but requires an existing deployment (project config). */
export async function getServerInfo(cwd: string, explicitServer?: string) {
  const { config, serverUrl, apiKey } = await resolveDeployTarget(cwd, explicitServer);
  if (!config) {
    throw new Error("No .aai/project.json found — run `aai deploy` first");
  }
  return { serverUrl, slug: config.slug, apiKey };
}
