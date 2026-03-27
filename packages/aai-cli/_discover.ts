// Copyright 2025 the AAI authors. MIT license.
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { humanId } from "human-id";
import { z } from "zod";
import { askPassword } from "./_prompts.ts";

const AuthConfigSchema = z.object({
  assemblyai_api_key: z.string().optional(),
});

const ProjectConfigSchema = z.object({
  slug: z.string(),
  serverUrl: z.string(),
  sessionId: z.string().optional(),
});

/** Resolve the working directory from INIT_CWD or process.cwd(). */
export function resolveCwd(): string {
  return process.env.INIT_CWD || process.cwd();
}

/**
 * Generates a human-readable slug using human-id.
 */
export function generateSlug(): string {
  return humanId({ separator: "-", capitalize: false });
}

// --- Global auth config (~/.config/aai/config.json) ---
// Only stores the AssemblyAI API key, like Vercel stores auth in ~/.vercel/auth.json

const CONFIG_DIR = path.join(process.env.HOME ?? process.env.USERPROFILE ?? ".", ".config", "aai");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

type AuthConfig = z.infer<typeof AuthConfigSchema>;

async function readAuthConfig(): Promise<AuthConfig> {
  try {
    return AuthConfigSchema.parse(JSON.parse(await fs.readFile(CONFIG_FILE, "utf-8")));
  } catch {
    return {};
  }
}

async function writeAuthConfig(config: AuthConfig): Promise<void> {
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  await fs.writeFile(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`);
  if (process.platform !== "win32") {
    await fs.chmod(CONFIG_FILE, 0o600);
  }
}

/**
 * Retrieves the AssemblyAI API key from `process.env`, `~/.config/aai/config.json`,
 * or by interactively prompting the user (persisting it to config).
 *
 * Does NOT mutate `process.env`. Callers that need the key available in the
 * environment for child processes should use {@link ensureApiKeyInEnv} instead.
 */
export async function getApiKey(): Promise<string> {
  // Check env var first (allows CI/test usage without interactive prompt)
  if (process.env.ASSEMBLYAI_API_KEY) {
    return process.env.ASSEMBLYAI_API_KEY;
  }

  const config = await readAuthConfig();
  if (config.assemblyai_api_key) {
    return config.assemblyai_api_key;
  }

  console.log("  Get your API key at https://www.assemblyai.com/dashboard/signup");
  console.log("  Or set the ASSEMBLYAI_API_KEY environment variable to skip this prompt.\n");

  let key: string | undefined;
  while (!key) {
    key = await askPassword("ASSEMBLYAI_API_KEY");
  }

  config.assemblyai_api_key = key;
  await writeAuthConfig(config);
  return key;
}

/**
 * Resolves the API key via {@link getApiKey} and sets it on `process.env.ASSEMBLYAI_API_KEY`
 * so that child processes and downstream code can read it from the environment.
 */
export async function ensureApiKeyInEnv(): Promise<string> {
  const key = await getApiKey();
  process.env.ASSEMBLYAI_API_KEY = key;
  return key;
}

// --- Project-local config (.aai/project.json) ---
// Like .vercel/project.json — stores slug, server URL

/** Project-level deployment metadata stored in `.aai/project.json`. */
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

/**
 * Reads `.aai/project.json` from an agent directory.
 * Returns null if the file doesn't exist.
 */
export async function readProjectConfig(agentDir: string): Promise<ProjectConfig | null> {
  try {
    return ProjectConfigSchema.parse(
      JSON.parse(await fs.readFile(path.join(agentDir, ".aai", "project.json"), "utf-8")),
    );
  } catch {
    return null;
  }
}

/**
 * Writes `.aai/project.json` to an agent directory.
 */
export async function writeProjectConfig(agentDir: string, data: ProjectConfig): Promise<void> {
  const aaiDir = path.join(agentDir, ".aai");
  await fs.mkdir(aaiDir, { recursive: true });
  await fs.writeFile(path.join(aaiDir, "project.json"), `${JSON.stringify(data, null, 2)}\n`);
}

/**
 * Read project config (throws if missing), resolve API key and server URL.
 * Shared by secret and rag commands.
 */
export async function getServerInfo(cwd: string, explicitServer?: string, explicitApiKey?: string) {
  const config = await readProjectConfig(cwd);
  if (!config) {
    throw new Error("No .aai/project.json found — deploy first with `aai deploy`");
  }
  const apiKey = explicitApiKey ?? (await getApiKey());
  const serverUrl = resolveServerUrl(explicitServer, config.serverUrl);
  return { serverUrl, slug: config.slug, apiKey };
}

// --- Agent discovery ---

/** Discovered agent metadata extracted from an agent directory. */
export type AgentEntry = {
  /** URL-safe identifier from project config or generated. */
  slug: string;
  /** Absolute path to the agent directory. */
  dir: string;
  /** Absolute path to the `agent.ts` entry point. */
  entryPoint: string;
  /** Absolute path to the client entry point (`client.ts` or empty). */
  clientEntry: string;
};

/** Default production server URL for agent deployments. */
export const DEFAULT_SERVER = "https://aai-agent.fly.dev";

/** Default local dev server URL. */
export const DEFAULT_DEV_SERVER = "http://localhost:8787";

/** Check if the CLI is running from the monorepo (dev mode). */
export function isDevMode(): boolean {
  const cliDir = path.dirname(fileURLToPath(import.meta.url));
  // From source: cliDir is packages/aai-cli/, workspace root is ../..
  // From dist:   cliDir is packages/aai-cli/dist/, workspace root is ../../..
  const root1 = path.resolve(cliDir, "../..");
  const root2 = path.resolve(cliDir, "../../..");
  return (
    existsSync(path.join(root1, "pnpm-workspace.yaml")) ||
    existsSync(path.join(root2, "pnpm-workspace.yaml"))
  );
}

/** Resolve the server URL from an explicit value, project config, or default. */
export function resolveServerUrl(explicit?: string, configUrl?: string): string {
  return explicit ?? configUrl ?? (isDevMode() ? DEFAULT_DEV_SERVER : DEFAULT_SERVER);
}

export async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Loads agent metadata from a directory by checking for `agent.ts` and
 * resolving the client entry point.
 *
 * Env vars for deployed agents are managed on the server via
 * `aai secret put`. For local dev, `.env` is loaded by `resolveServerEnv`.
 */
export async function loadAgent(dir: string): Promise<AgentEntry | null> {
  const hasAgentTs = await fileExists(path.join(dir, "agent.ts"));
  if (!hasAgentTs) return null;

  const config = await readProjectConfig(dir);
  const slug = config?.slug ?? generateSlug();

  const clientEntry = (await fileExists(path.join(dir, "client.tsx")))
    ? path.join(dir, "client.tsx")
    : "";

  return {
    slug,
    dir,
    entryPoint: path.join(dir, "agent.ts"),
    clientEntry,
  };
}
