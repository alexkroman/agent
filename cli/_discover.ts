// Copyright 2025 the AAI authors. MIT license.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { humanId } from "human-id";
import { execFileAsync } from "./_exec.ts";
import { step } from "./_output.ts";
import { askPassword } from "./_prompts.tsx";

/**
 * Whether the CLI is running from the dev monorepo (via tsx/node)
 * vs a compiled binary.
 */
export function isDevMode(): boolean {
  return path.basename(process.argv[0] ?? "") !== "aai";
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

  step("Setup", "AssemblyAI API key required for speech-to-text");
  console.log("Get one at https://www.assemblyai.com/dashboard/signup\n");

  let key: string | undefined;
  while (!key) {
    key = await askPassword("ASSEMBLYAI_API_KEY");
  }

  config.assemblyai_api_key = key;
  process.env.ASSEMBLYAI_API_KEY = key;
  await writeAuthConfig(config);
  step("Saved", CONFIG_FILE);
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
  /** Environment variables loaded from `.env` (includes `ASSEMBLYAI_API_KEY`). */
  env: Record<string, string>;
  /** Absolute path to the client entry point (`client.ts` or empty). */
  clientEntry: string;
  /** Transport protocols the agent supports. */
  transport: readonly "websocket"[];
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
    env: {},
    clientEntry,
    transport: ["websocket"],
  };
}

/**
 * Copies `templates/_shared/CLAUDE.md` into the agent directory as `CLAUDE.md`.
 * Creates the file if missing or updates it if the content has changed.
 */
export async function ensureClaudeMd(targetDir: string): Promise<void> {
  const claudePath = path.join(targetDir, "CLAUDE.md");
  const cliDir = path.dirname(fileURLToPath(import.meta.url));
  const srcPath = path.join(cliDir, "..", "templates", "_shared", "CLAUDE.md");
  const srcContent = await fs.readFile(srcPath, "utf-8");
  let existing = "";
  try {
    existing = await fs.readFile(claudePath, "utf-8");
  } catch {
    /* file doesn't exist */
  }
  if (existing !== srcContent) {
    await fs.writeFile(claudePath, srcContent);
    step(existing ? "Updated" : "Wrote", "CLAUDE.md — aai agent API reference");
  }
}

/**
 * Install dependencies if `node_modules/` doesn't exist.
 * Uses `npm install` which reads package.json and installs from npm.
 */
export async function ensureDependencies(targetDir: string): Promise<void> {
  if (!(await fileExists(path.join(targetDir, "node_modules")))) {
    step("Install", "dependencies");
    try {
      await execFileAsync("npm", ["install"], { cwd: targetDir });
    } catch {
      step("Skip", "npm install failed");
    }
  }
}
