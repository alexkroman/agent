// Copyright 2025 the AAI authors. MIT license.
import { accessSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { humanId } from "human-id";
import { askPassword } from "./_prompts.tsx";

/** Resolve the working directory from INIT_CWD or process.cwd(). */
export function resolveCwd(): string {
  return process.env.INIT_CWD || process.cwd();
}

/**
 * Whether the CLI is running from the dev monorepo (via tsx/node)
 * vs a compiled binary.
 */
export function isDevMode(): boolean {
  // Dev mode when running raw TS source (via tsx) OR when running the
  // built dist/aai.js directly from the monorepo (e.g. via aai-dev alias).
  const script = process.argv[1] ?? "";
  if (script.endsWith(".ts") || script.endsWith(".tsx")) return true;
  // Check if running from the monorepo dist/ (not a global npm install)
  if (script.includes("/dist/") && !script.includes("node_modules")) {
    const dir = path.dirname(path.dirname(script));
    try {
      accessSync(path.join(dir, "sdk"));
      accessSync(path.join(dir, "cli"));
      return true;
    } catch {
      return false;
    }
  }
  return false;
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

type AuthConfig = {
  assemblyai_api_key?: string;
};

async function readAuthConfig(): Promise<AuthConfig> {
  try {
    return JSON.parse(await fs.readFile(CONFIG_FILE, "utf-8"));
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
 * Retrieves the AssemblyAI API key from `~/.config/aai/config.json`.
 * If not found, interactively prompts the user and persists it.
 */
export async function getApiKey(): Promise<string> {
  const config = await readAuthConfig();
  if (config.assemblyai_api_key) {
    process.env.ASSEMBLYAI_API_KEY = config.assemblyai_api_key;
    return config.assemblyai_api_key;
  }

  let key: string | undefined;
  while (!key) {
    key = await askPassword("ASSEMBLYAI_API_KEY");
  }

  config.assemblyai_api_key = key;
  process.env.ASSEMBLYAI_API_KEY = key;
  await writeAuthConfig(config);
  return key;
}

// --- Project-local config (.aai/project.json) ---
// Like .vercel/project.json — stores slug, server URL

/** Project-level deployment metadata stored in `.aai/project.json`. */
export type ProjectConfig = {
  slug: string;
  serverUrl: string;
};

/**
 * Reads `.aai/project.json` from an agent directory.
 * Returns null if the file doesn't exist.
 */
export async function readProjectConfig(agentDir: string): Promise<ProjectConfig | null> {
  try {
    return JSON.parse(await fs.readFile(path.join(agentDir, ".aai", "project.json"), "utf-8"));
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
 * Env vars are NOT read from `.env` — they're managed on the server
 * via `aai env add` (like `vercel env add`).
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
