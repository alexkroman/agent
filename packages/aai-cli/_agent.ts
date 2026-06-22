// Copyright 2025 the AAI authors. MIT license.
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureApiKey, readProjectConfig } from "./_config.ts";

export const DEFAULT_SERVER = "https://aai-agent.fly.dev";
export const DEFAULT_DEV_SERVER = "http://localhost:8080";

/** Marker file that identifies the monorepo root. */
const WORKSPACE_MARKER = "pnpm-workspace.yaml";
/** Env var that forces production mode even inside the monorepo. */
const DISABLE_DEV_ENV = "AAI_NO_DEV";

let _cachedMonorepoRoot: string | null | undefined;

export function getMonorepoRoot(): string | null {
  if (_cachedMonorepoRoot !== undefined) return _cachedMonorepoRoot;
  const cliDir = path.dirname(fileURLToPath(import.meta.url));
  // Probe each candidate ancestor in order (handles both the .ts source
  // layout and the compiled dist/.js layout), keeping the nearest match.
  const candidates = ["../..", "../../.."].map((rel) => path.resolve(cliDir, rel));
  _cachedMonorepoRoot =
    candidates.find((root) => existsSync(path.join(root, WORKSPACE_MARKER))) ?? null;
  return _cachedMonorepoRoot;
}

export function isDevMode(): boolean {
  if (process.env[DISABLE_DEV_ENV] === "1") return false;
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
  const apiKey = explicitApiKey ?? (await ensureApiKey());
  const serverUrl = resolveServerUrl(explicitServer, config.serverUrl);
  return { serverUrl, slug: config.slug, apiKey };
}
