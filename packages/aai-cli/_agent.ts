// Copyright 2025 the AAI authors. MIT license.
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getApiKey, readProjectConfig } from "./_config.ts";
import { fileExists } from "./_utils.ts";

export type AgentEntry = {
  slug: string;
  dir: string;
  entryPoint: string;
  clientEntry: string;
};

export const DEFAULT_SERVER = "https://aai-agent.fly.dev";
export const DEFAULT_DEV_SERVER = "http://localhost:8080";

export function getMonorepoRoot(): string | null {
  const cliDir = path.dirname(fileURLToPath(import.meta.url));
  const root1 = path.resolve(cliDir, "../..");
  const root2 = path.resolve(cliDir, "../../..");
  if (existsSync(path.join(root1, "pnpm-workspace.yaml"))) return root1;
  if (existsSync(path.join(root2, "pnpm-workspace.yaml"))) return root2;
  return null;
}

export function isDevMode(): boolean {
  return getMonorepoRoot() !== null;
}

export function resolveServerUrl(explicit?: string, configUrl?: string): string {
  if (explicit) return explicit;
  if (isDevMode()) return DEFAULT_DEV_SERVER;
  return configUrl ?? DEFAULT_SERVER;
}

export async function loadAgent(dir: string): Promise<AgentEntry | null> {
  const hasAgentTs = await fileExists(path.join(dir, "agent.ts"));
  if (!hasAgentTs) return null;

  const config = await readProjectConfig(dir);
  const slug = config?.slug ?? "";

  const clientEntry = (await fileExists(path.join(dir, "client.tsx")))
    ? path.join(dir, "client.tsx")
    : "";

  return { slug, dir, entryPoint: path.join(dir, "agent.ts"), clientEntry };
}

export async function getServerInfo(cwd: string, explicitServer?: string, explicitApiKey?: string) {
  const config = await readProjectConfig(cwd);
  if (!config) {
    throw new Error("No .aai/project.json found — run `aai deploy` first");
  }
  const apiKey = explicitApiKey ?? (await getApiKey());
  const serverUrl = resolveServerUrl(explicitServer, config.serverUrl);
  return { serverUrl, slug: config.slug, apiKey };
}
