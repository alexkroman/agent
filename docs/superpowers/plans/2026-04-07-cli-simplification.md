# CLI Simplification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Simplify and refactor `packages/aai-cli/` by splitting the overloaded `_discover.ts`, consolidating duplicated API error handling, and replacing custom code with existing library features.

**Architecture:** Split `_discover.ts` (233 lines, 5 responsibilities) into `_utils.ts`, `_config.ts`, and `_agent.ts`. Replace custom password prompt with `@clack/prompts`. Add `apiRequestOrThrow` to consolidate error handling in `_deploy.ts`, `_delete.ts`, and `secret.ts`. Simplify `_ui.ts` from a pass-through wrapper to a re-export.

**Tech Stack:** TypeScript, citty (CLI framework), @clack/prompts (terminal UI), Zod (validation), Vite (bundling), vitest (testing)

**Spec:** `docs/superpowers/specs/2026-04-07-cli-simplification-design.md`

---

## File Structure

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `_utils.ts` | `resolveCwd`, `fileExists` (~15 lines) |
| Create | `_config.ts` | Auth config, project config, `getApiKey`, `ensureApiKeyInEnv` (~100 lines) |
| Create | `_agent.ts` | Agent discovery, dev mode, server URL, `getServerInfo` (~80 lines) |
| Delete | `_discover.ts` | Replaced by above three files |
| Delete | `_prompts.ts` | Replaced by `@clack/prompts` `p.password()` |
| Simplify | `_ui.ts` | Re-export `log` from `@clack/prompts`, keep `fmtUrl`/`parsePort` |
| Add | `_api-client.ts` | New `apiRequestOrThrow` function |
| Simplify | `_deploy.ts` | Use `apiRequestOrThrow` |
| Simplify | `_delete.ts` | Use `apiRequestOrThrow` |
| Simplify | `secret.ts` | Use `apiRequestOrThrow`, replace `askPassword` |
| Simplify | `_init.ts` | Extract README template function |
| Update | `cli.ts` | Import paths |
| Update | `init.ts` | Import paths |
| Update | `deploy.ts` | Import paths |
| Update | `delete.ts` | Import paths |
| Update | `_server-common.ts` | Import paths |
| Update | `_bundler.ts` | Import paths |
| Update | `_templates.ts` | Import paths |
| Create | `_utils.test.ts` | Tests for `resolveCwd`, `fileExists` |
| Create | `_config.test.ts` | Tests for project config, `ensureApiKeyInEnv` |
| Create | `_agent.test.ts` | Tests for `loadAgent`, `isDevMode`, `resolveServerUrl`, `getServerInfo` |
| Delete | `_discover.test.ts` | Replaced by above three test files |
| Update | `init.test.ts` | Import `fileExists` from `_utils.ts` |

**Dependency flow** (no circular imports):
- `_utils.ts` — no internal imports
- `_config.ts` — imports from `_utils.ts`
- `_agent.ts` — imports from `_config.ts` and `_utils.ts`

---

### Task 1: Create `_utils.ts`

**Files:**
- Create: `packages/aai-cli/_utils.ts`

- [ ] **Step 1: Create `_utils.ts`**

```ts
// Copyright 2025 the AAI authors. MIT license.
import fs from "node:fs/promises";
import { consola } from "consola";

/** Resolve the working directory from INIT_CWD or process.cwd(). */
export function resolveCwd(): string {
  return process.env.INIT_CWD || process.cwd();
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
```

- [ ] **Step 2: Verify no syntax errors**

Run: `npx tsc --noEmit packages/aai-cli/_utils.ts --skipLibCheck --moduleResolution bundler --module nodenext --target esnext`

This is a standalone file, so basic tsc check suffices. Full verification comes after all imports are wired up.

---

### Task 2: Create `_config.ts`

**Files:**
- Create: `packages/aai-cli/_config.ts`

This file extracts auth config and project config I/O from `_discover.ts`. It replaces `askPassword` from `_prompts.ts` with `@clack/prompts`'s `p.password()`.

- [ ] **Step 1: Create `_config.ts`**

```ts
// Copyright 2025 the AAI authors. MIT license.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ci from "ci-info";
import * as p from "@clack/prompts";
import { consola } from "consola";
import { z } from "zod";

const AuthConfigSchema = z.object({
  assemblyai_api_key: z.string().optional(),
});

const ProjectConfigSchema = z.object({
  slug: z.string(),
  serverUrl: z.string(),
  sessionId: z.string().optional(),
});

// --- Global auth config ---
// Only stores the AssemblyAI API key, like Vercel stores auth in ~/.vercel/auth.json.
// Uses platform-aware config directories: %APPDATA%\aai on Windows, ~/.config/aai on Unix.

export function getConfigDir(): string {
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), "aai");
  }
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), "aai");
}

const CONFIG_DIR = getConfigDir();
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

type AuthConfig = z.infer<typeof AuthConfigSchema>;

async function readAuthConfig(): Promise<AuthConfig> {
  try {
    return AuthConfigSchema.parse(JSON.parse(await fs.readFile(CONFIG_FILE, "utf-8")));
  } catch (error) {
    consola.debug(`Failed to read auth config from ${CONFIG_FILE}:`, error);
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
  if (process.env.ASSEMBLYAI_API_KEY) {
    return process.env.ASSEMBLYAI_API_KEY;
  }

  const config = await readAuthConfig();
  if (config.assemblyai_api_key) {
    return config.assemblyai_api_key;
  }

  if (ci.isCI || !process.stdin.isTTY) {
    throw new Error(
      "No ASSEMBLYAI_API_KEY found. Set the ASSEMBLYAI_API_KEY environment variable in CI or non-interactive environments.",
    );
  }

  p.log.info("Get your API key at https://www.assemblyai.com/dashboard/signup");
  p.log.info("Or set the ASSEMBLYAI_API_KEY environment variable to skip this prompt.");

  let key: string | undefined;
  while (!key) {
    const result = await p.password({ message: "ASSEMBLYAI_API_KEY" });
    if (p.isCancel(result)) process.exit(0);
    key = result;
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
  } catch (error) {
    consola.debug(
      `Failed to read project config from ${path.join(agentDir, ".aai", "project.json")}:`,
      error,
    );
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
```

---

### Task 3: Create `_agent.ts`

**Files:**
- Create: `packages/aai-cli/_agent.ts`

This file extracts agent discovery, dev mode detection, server URL resolution, and `getServerInfo` from `_discover.ts`. It imports from `_config.ts` (one-way dependency).

- [ ] **Step 1: Create `_agent.ts`**

```ts
// Copyright 2025 the AAI authors. MIT license.
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getApiKey, readProjectConfig } from "./_config.ts";
import { fileExists } from "./_utils.ts";

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

/** Return the monorepo root path when the CLI is running from within it, or null. */
export function getMonorepoRoot(): string | null {
  const cliDir = path.dirname(fileURLToPath(import.meta.url));
  // From source: cliDir is packages/aai-cli/, workspace root is ../..
  // From dist:   cliDir is packages/aai-cli/dist/, workspace root is ../../..
  const root1 = path.resolve(cliDir, "../..");
  const root2 = path.resolve(cliDir, "../../..");
  if (existsSync(path.join(root1, "pnpm-workspace.yaml"))) return root1;
  if (existsSync(path.join(root2, "pnpm-workspace.yaml"))) return root2;
  return null;
}

/** Check if the CLI is running from the monorepo (dev mode). */
export function isDevMode(): boolean {
  return getMonorepoRoot() !== null;
}

/** Resolve the server URL from an explicit value, project config, or default. */
export function resolveServerUrl(explicit?: string, configUrl?: string): string {
  if (explicit) return explicit;
  if (isDevMode()) return DEFAULT_DEV_SERVER;
  return configUrl ?? DEFAULT_SERVER;
}

/**
 * Loads agent metadata from a directory by checking for `agent.ts` and
 * resolving the client entry point.
 */
export async function loadAgent(dir: string): Promise<AgentEntry | null> {
  const hasAgentTs = await fileExists(path.join(dir, "agent.ts"));
  if (!hasAgentTs) return null;

  const config = await readProjectConfig(dir);
  const slug = config?.slug ?? "";

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

/**
 * Read project config (throws if missing), resolve API key and server URL.
 * Shared by deploy, delete, and secret commands.
 */
export async function getServerInfo(cwd: string, explicitServer?: string, explicitApiKey?: string) {
  const config = await readProjectConfig(cwd);
  if (!config) {
    throw new Error("No .aai/project.json found — run `aai deploy` first");
  }
  const apiKey = explicitApiKey ?? (await getApiKey());
  const serverUrl = resolveServerUrl(explicitServer, config.serverUrl);
  return { serverUrl, slug: config.slug, apiKey };
}
```

- [ ] **Step 2: Verify compilation of all three new files**

Run: `pnpm --filter @alexkroman1/aai-cli exec tsc --noEmit 2>&1 | head -20`

Expect: may show errors about duplicate exports (both `_discover.ts` and new files export the same names). That's expected — we'll delete `_discover.ts` in the next task.

---

### Task 4: Update all production imports, delete old files

**Files:**
- Modify: `packages/aai-cli/cli.ts`
- Modify: `packages/aai-cli/init.ts`
- Modify: `packages/aai-cli/deploy.ts`
- Modify: `packages/aai-cli/delete.ts`
- Modify: `packages/aai-cli/secret.ts`
- Modify: `packages/aai-cli/_server-common.ts`
- Modify: `packages/aai-cli/_bundler.ts`
- Modify: `packages/aai-cli/_templates.ts`
- Modify: `packages/aai-cli/_init.ts`
- Delete: `packages/aai-cli/_discover.ts`
- Delete: `packages/aai-cli/_prompts.ts`

- [ ] **Step 1: Update `cli.ts` imports**

Change line 7:
```ts
// Before:
import { ensureApiKeyInEnv, fileExists, resolveCwd } from "./_discover.ts";

// After:
import { ensureApiKeyInEnv } from "./_config.ts";
import { fileExists, resolveCwd } from "./_utils.ts";
```

- [ ] **Step 2: Update `init.ts` imports**

Change lines 10-17:
```ts
// Before:
import {
  DEFAULT_DEV_SERVER,
  ensureApiKeyInEnv,
  fileExists,
  getMonorepoRoot,
  isDevMode,
  resolveCwd,
} from "./_discover.ts";

// After:
import { DEFAULT_DEV_SERVER, getMonorepoRoot, isDevMode } from "./_agent.ts";
import { ensureApiKeyInEnv } from "./_config.ts";
import { fileExists, resolveCwd } from "./_utils.ts";
```

- [ ] **Step 3: Update `deploy.ts` imports**

Change line 5:
```ts
// Before:
import { getApiKey, readProjectConfig, resolveServerUrl, writeProjectConfig } from "./_discover.ts";

// After:
import { resolveServerUrl } from "./_agent.ts";
import { getApiKey, readProjectConfig, writeProjectConfig } from "./_config.ts";
```

- [ ] **Step 4: Update `delete.ts` imports**

Change line 4:
```ts
// Before:
import { getServerInfo } from "./_discover.ts";

// After:
import { getServerInfo } from "./_agent.ts";
```

- [ ] **Step 5: Update `secret.ts` imports — replace `askPassword` with `p.password()`**

Replace the imports and update `runSecretPut`:

```ts
// Before:
import { apiError, apiRequest, HINT_INVALID_API_KEY } from "./_api-client.ts";
import { getServerInfo } from "./_discover.ts";
import { askPassword } from "./_prompts.ts";
import { log } from "./_ui.ts";

// After:
import * as p from "@clack/prompts";
import ci from "ci-info";
import { apiError, apiRequest, HINT_INVALID_API_KEY } from "./_api-client.ts";
import { getServerInfo } from "./_agent.ts";
import { log } from "./_ui.ts";
```

Replace `runSecretPut` function body:
```ts
export async function runSecretPut(cwd: string, name: string, server?: string): Promise<void> {
  if (ci.isCI || !process.stdin.isTTY) {
    throw new Error("Interactive prompt requires a terminal. Set secrets as environment variables in CI.");
  }
  const result = await p.password({ message: `Enter value for ${name}` });
  if (p.isCancel(result)) process.exit(0);
  if (!result) throw new Error("No value provided");

  const { slug } = await secretRequest(
    cwd,
    "",
    { method: "PUT", body: JSON.stringify({ [name]: result }) },
    server,
  );
  log.success(`Set ${name} for ${slug}`);
}
```

- [ ] **Step 6: Update `_server-common.ts` imports**

Change line 7:
```ts
// Before:
import { getApiKey } from "./_discover.ts";

// After:
import { getApiKey } from "./_config.ts";
```

- [ ] **Step 7: Update `_bundler.ts` imports**

Change line 7:
```ts
// Before:
import type { AgentEntry } from "./_discover.ts";

// After:
import type { AgentEntry } from "./_agent.ts";
```

- [ ] **Step 8: Update `_templates.ts` imports**

Change line 8:
```ts
// Before:
import { isDevMode } from "./_discover.ts";

// After:
import { isDevMode } from "./_agent.ts";
```

- [ ] **Step 9: Update `_init.ts` imports**

Change line 4:
```ts
// Before:
import { isDevMode } from "./_discover.ts";

// After:
import { isDevMode } from "./_agent.ts";
```

- [ ] **Step 10: Delete `_discover.ts` and `_prompts.ts`**

```bash
rm packages/aai-cli/_discover.ts packages/aai-cli/_prompts.ts
```

- [ ] **Step 11: Typecheck**

Run: `pnpm typecheck`
Expected: PASS (no type errors)

- [ ] **Step 12: Commit**

```bash
git add packages/aai-cli/_utils.ts packages/aai-cli/_config.ts packages/aai-cli/_agent.ts \
  packages/aai-cli/cli.ts packages/aai-cli/init.ts packages/aai-cli/deploy.ts \
  packages/aai-cli/delete.ts packages/aai-cli/secret.ts packages/aai-cli/_server-common.ts \
  packages/aai-cli/_bundler.ts packages/aai-cli/_templates.ts packages/aai-cli/_init.ts \
  packages/aai-cli/_discover.ts packages/aai-cli/_prompts.ts
git commit -m "refactor(cli): split _discover.ts into _utils, _config, _agent

Replace custom askPassword with @clack/prompts p.password()."
```

---

### Task 5: Simplify `_ui.ts`

**Files:**
- Modify: `packages/aai-cli/_ui.ts`

- [ ] **Step 1: Simplify `_ui.ts`**

Replace the entire file with:

```ts
// Copyright 2025 the AAI authors. MIT license.

import { log } from "@clack/prompts";
import { colorize } from "consola/utils";

export { log };

/** Format a URL for display. */
export function fmtUrl(url: string): string {
  return colorize("cyanBright", url);
}

/** Parse and validate a port string. Returns the numeric port or throws. */
export function parsePort(raw: string): number {
  const port = Number.parseInt(raw, 10);
  if (Number.isNaN(port) || port < 0 || port > 65_535) {
    throw new Error(`Invalid port: ${raw}. Must be a number between 0 and 65535.`);
  }
  return port;
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 3: Run `_ui.test.ts`**

Run: `pnpm vitest run packages/aai-cli/_ui.test.ts`
Expected: PASS (parsePort tests still work)

- [ ] **Step 4: Commit**

```bash
git add packages/aai-cli/_ui.ts
git commit -m "refactor(cli): simplify _ui.ts to re-export @clack/prompts log"
```

---

### Task 6: Consolidate API error handling

**Files:**
- Modify: `packages/aai-cli/_api-client.ts`
- Modify: `packages/aai-cli/_deploy.ts`
- Modify: `packages/aai-cli/_delete.ts`
- Modify: `packages/aai-cli/secret.ts`

- [ ] **Step 1: Add `apiRequestOrThrow` to `_api-client.ts`**

Add after the existing `apiError` function:

```ts
/**
 * Like `apiRequest`, but throws on non-ok responses with status-specific hints.
 * The 401 hint is always included. Pass additional hints via `opts.hints`.
 */
export async function apiRequestOrThrow(
  url: string,
  init: RequestInit & { apiKey: string; action: string },
  opts?: { hints?: Record<number, string>; fetch?: typeof globalThis.fetch },
): Promise<Response> {
  const resp = await apiRequest(url, init, opts?.fetch);
  if (resp.ok) return resp;
  const text = await resp.text();
  const hint = resp.status === 401 ? HINT_INVALID_API_KEY : opts?.hints?.[resp.status];
  throw apiError(init.action, resp.status, text, hint);
}
```

- [ ] **Step 2: Simplify `_deploy.ts`**

Replace the entire file:

```ts
// Copyright 2025 the AAI authors. MIT license.

import { apiRequestOrThrow } from "./_api-client.ts";
import type { BundleOutput } from "./_bundler.ts";

export type DeployOpts = {
  url: string;
  bundle: BundleOutput;
  /** Env var values from .env to send to the server. */
  env: Record<string, string>;
  /** Existing slug for redeployment. Omit for first deploy — server generates one. */
  slug?: string;
  apiKey: string;
  /** Optional fetch implementation for testing. Defaults to globalThis.fetch. */
  fetch?: typeof globalThis.fetch;
};

export type DeployResult = {
  slug: string;
};

export async function runDeploy(opts: DeployOpts): Promise<DeployResult> {
  const body = JSON.stringify({
    ...(opts.slug ? { slug: opts.slug } : {}),
    env: opts.env,
    worker: opts.bundle.worker,
    clientFiles: opts.bundle.clientFiles,
  });

  const resp = await apiRequestOrThrow(
    `${opts.url}/deploy`,
    { method: "POST", body, apiKey: opts.apiKey, action: "deploy" },
    {
      hints: { 413: "Your bundle is too large. Try reducing dependencies or splitting your agent." },
      fetch: opts.fetch,
    },
  );

  const data = (await resp.json()) as { slug: string };
  return { slug: data.slug };
}
```

- [ ] **Step 3: Simplify `_delete.ts`**

Replace the entire file:

```ts
// Copyright 2025 the AAI authors. MIT license.

import { apiRequestOrThrow } from "./_api-client.ts";

export type DeleteOpts = {
  url: string;
  slug: string;
  apiKey: string;
  /** Optional fetch implementation for testing. Defaults to globalThis.fetch. */
  fetch?: typeof globalThis.fetch;
};

export async function runDelete(opts: DeleteOpts): Promise<void> {
  await apiRequestOrThrow(
    `${opts.url}/${opts.slug}`,
    { method: "DELETE", apiKey: opts.apiKey, action: "delete" },
    {
      hints: { 404: "The agent may not be deployed. Check `.aai/project.json` for the correct slug." },
      fetch: opts.fetch,
    },
  );
}
```

- [ ] **Step 4: Simplify `secret.ts` `secretRequest`**

Replace the `secretRequest` function:

```ts
// Before:
async function secretRequest(
  cwd: string,
  pathSuffix: string,
  init?: RequestInit,
  server?: string,
): Promise<{ resp: Response; slug: string }> {
  const { serverUrl, slug, apiKey } = await getServerInfo(cwd, server);
  const resp = await apiRequest(`${serverUrl}/${slug}/secret${pathSuffix}`, {
    ...init,
    apiKey,
    action: "secret",
  });
  if (!resp.ok) {
    const text = await resp.text();
    const hint = resp.status === 401 ? HINT_INVALID_API_KEY : undefined;
    throw apiError("secret", resp.status, text, hint);
  }
  return { resp, slug };
}

// After:
async function secretRequest(
  cwd: string,
  pathSuffix: string,
  init?: RequestInit,
  server?: string,
): Promise<{ resp: Response; slug: string }> {
  const { serverUrl, slug, apiKey } = await getServerInfo(cwd, server);
  const resp = await apiRequestOrThrow(`${serverUrl}/${slug}/secret${pathSuffix}`, {
    ...init,
    apiKey,
    action: "secret",
  });
  return { resp, slug };
}
```

Also update `secret.ts` imports — replace `apiError, apiRequest, HINT_INVALID_API_KEY` with `apiRequestOrThrow`:

```ts
// Before:
import { apiError, apiRequest, HINT_INVALID_API_KEY } from "./_api-client.ts";

// After:
import { apiRequestOrThrow } from "./_api-client.ts";
```

(Keep the other imports as updated in Task 4.)

- [ ] **Step 5: Run deploy and delete tests**

Run: `pnpm vitest run packages/aai-cli/deploy.test.ts packages/aai-cli/_delete.test.ts`
Expected: PASS — all error message assertions still match since `apiRequestOrThrow` uses the same `apiError` formatting.

- [ ] **Step 6: Commit**

```bash
git add packages/aai-cli/_api-client.ts packages/aai-cli/_deploy.ts \
  packages/aai-cli/_delete.ts packages/aai-cli/secret.ts
git commit -m "refactor(cli): consolidate API error handling into apiRequestOrThrow"
```

---

### Task 7: Extract README template in `_init.ts`

**Files:**
- Modify: `packages/aai-cli/_init.ts`

- [ ] **Step 1: Extract README content into a function**

Add a function near the top of `_init.ts` (after imports):

```ts
function readmeContent(slug: string): string {
  return `# ${slug}

A voice agent built with [aai](https://github.com/anthropics/aai).

## Getting started

\`\`\`sh
npm install        # Install dependencies
aai dev            # Run locally (opens browser)
aai deploy         # Deploy to production
\`\`\`

## Secrets

Access secrets in your agent via \`ctx.env.MY_KEY\`.

**Local development** — add secrets to \`.env\` (auto-loaded by \`aai dev\`):

\`\`\`sh
ALPHA_VANTAGE_KEY=sk-abc123
MY_API_KEY=secret-value
\`\`\`

**Production** — set secrets on the server:

\`\`\`sh
aai secret put MY_KEY    # Set a secret (prompts for value)
aai secret list          # List secret names
aai secret delete MY_KEY # Remove a secret
\`\`\`

## Learn more

See \`CLAUDE.md\` for the full agent API reference.
`;
}
```

Then replace the inline template in `runInit` (the block from `const readmePath = ...` through the `try/catch` that writes it):

```ts
  const readmePath = path.join(targetDir, "README.md");
  const slug = path.basename(path.resolve(targetDir));
  try {
    await fs.writeFile(readmePath, readmeContent(slug), { flag: "wx" });
  } catch (err: unknown) {
    if (!(err instanceof Error && "code" in err && err.code === "EEXIST")) throw err;
  }
```

- [ ] **Step 2: Run init tests**

Run: `pnpm vitest run packages/aai-cli/init.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/aai-cli/_init.ts
git commit -m "refactor(cli): extract README template into readmeContent function"
```

---

### Task 8: Split `_discover.test.ts` and update test imports

**Files:**
- Create: `packages/aai-cli/_utils.test.ts`
- Create: `packages/aai-cli/_config.test.ts`
- Create: `packages/aai-cli/_agent.test.ts`
- Delete: `packages/aai-cli/_discover.test.ts`
- Modify: `packages/aai-cli/init.test.ts`

- [ ] **Step 1: Create `_utils.test.ts`**

```ts
// Copyright 2025 the AAI authors. MIT license.
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { fileExists, resolveCwd } from "./_utils.ts";
import { withTempDir } from "./_test-utils.ts";

describe("resolveCwd", () => {
  test("returns INIT_CWD when set", () => {
    const orig = process.env.INIT_CWD;
    process.env.INIT_CWD = "/custom/path";
    try {
      expect(resolveCwd()).toBe("/custom/path");
    } finally {
      if (orig !== undefined) {
        process.env.INIT_CWD = orig;
      } else {
        delete process.env.INIT_CWD;
      }
    }
  });

  test("falls back to process.cwd() when INIT_CWD is not set", () => {
    const orig = process.env.INIT_CWD;
    delete process.env.INIT_CWD;
    try {
      expect(resolveCwd()).toBe(process.cwd());
    } finally {
      if (orig !== undefined) {
        process.env.INIT_CWD = orig;
      }
    }
  });
});

describe("fileExists", () => {
  test("returns true for existing file", async () => {
    await withTempDir(async (dir) => {
      const p = path.join(dir, "exists.txt");
      await fs.writeFile(p, "");
      expect(await fileExists(p)).toBe(true);
    });
  });

  test("returns false for missing file", async () => {
    expect(await fileExists("/tmp/does-not-exist-12345")).toBe(false);
  });

  test("returns true for existing directory", async () => {
    await withTempDir(async (dir) => {
      expect(await fileExists(dir)).toBe(true);
    });
  });
});
```

- [ ] **Step 2: Create `_config.test.ts`**

```ts
// Copyright 2025 the AAI authors. MIT license.
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  ensureApiKeyInEnv,
  readProjectConfig,
  writeProjectConfig,
} from "./_config.ts";
import { fileExists } from "./_utils.ts";
import { withTempDir } from "./_test-utils.ts";

describe("readProjectConfig / writeProjectConfig", () => {
  test("returns null when no config exists", async () => {
    await withTempDir(async (dir) => {
      const result = await readProjectConfig(dir);
      expect(result).toBeNull();
    });
  });

  test("round-trips config data", async () => {
    await withTempDir(async (dir) => {
      const config = { slug: "test-slug", serverUrl: "https://example.com" };
      await writeProjectConfig(dir, config);
      const result = await readProjectConfig(dir);
      expect(result).toEqual(config);
    });
  });

  test("creates .aai directory if missing", async () => {
    await withTempDir(async (dir) => {
      const config = { slug: "slug", serverUrl: "https://example.com" };
      await writeProjectConfig(dir, config);
      const aaiDir = path.join(dir, ".aai");
      expect(await fileExists(aaiDir)).toBe(true);
    });
  });

  test("overwrites existing config", async () => {
    await withTempDir(async (dir) => {
      await writeProjectConfig(dir, { slug: "old", serverUrl: "https://old.com" });
      await writeProjectConfig(dir, { slug: "new", serverUrl: "https://new.com" });
      const result = await readProjectConfig(dir);
      expect(result?.slug).toBe("new");
    });
  });
});

describe("ensureApiKeyInEnv", () => {
  test("sets process.env.ASSEMBLYAI_API_KEY from env", async () => {
    const orig = process.env.ASSEMBLYAI_API_KEY;
    process.env.ASSEMBLYAI_API_KEY = "test-key-env";
    try {
      const key = await ensureApiKeyInEnv();
      expect(key).toBe("test-key-env");
      expect(process.env.ASSEMBLYAI_API_KEY).toBe("test-key-env");
    } finally {
      if (orig !== undefined) {
        process.env.ASSEMBLYAI_API_KEY = orig;
      } else {
        delete process.env.ASSEMBLYAI_API_KEY;
      }
    }
  });
});
```

- [ ] **Step 3: Create `_agent.test.ts`**

```ts
// Copyright 2025 the AAI authors. MIT license.
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  DEFAULT_SERVER,
  getServerInfo,
  isDevMode,
  loadAgent,
  resolveServerUrl,
} from "./_agent.ts";
import { writeProjectConfig } from "./_config.ts";
import { withTempDir } from "./_test-utils.ts";

test("DEFAULT_SERVER", () => {
  expect(DEFAULT_SERVER).toBe("https://aai-agent.fly.dev");
});

describe("resolveServerUrl", () => {
  test("explicit URL takes priority", () => {
    expect(resolveServerUrl("https://custom.com", "https://config.com")).toBe("https://custom.com");
  });

  test("dev mode takes priority over config URL", () => {
    // Tests run from the monorepo, so isDevMode() returns true
    expect(resolveServerUrl(undefined, "https://config.com")).toBe("http://localhost:8787");
  });
});

describe("getServerInfo", () => {
  test("throws when no project config exists", async () => {
    await withTempDir(async (dir) => {
      await expect(getServerInfo(dir)).rejects.toThrow("No .aai/project.json found");
    });
  });

  test("error message suggests aai deploy", async () => {
    await withTempDir(async (dir) => {
      await expect(getServerInfo(dir)).rejects.toThrow("aai deploy");
    });
  });

  test("returns config with explicit api key (no prompt)", async () => {
    await withTempDir(async (dir) => {
      await writeProjectConfig(dir, {
        slug: "my-agent",
        serverUrl: "https://my-server.com",
      });
      const info = await getServerInfo(dir, undefined, "test-key-123");
      expect(info.slug).toBe("my-agent");
      // Dev mode (monorepo) takes priority over config serverUrl
      expect(info.serverUrl).toBe("http://localhost:8787");
      expect(info.apiKey).toBe("test-key-123");
    });
  });

  test("explicit server overrides config server", async () => {
    await withTempDir(async (dir) => {
      await writeProjectConfig(dir, {
        slug: "agent",
        serverUrl: "https://config-server.com",
      });
      const info = await getServerInfo(dir, "https://override.com", "key");
      expect(info.serverUrl).toBe("https://override.com");
    });
  });
});

describe("isDevMode", () => {
  test("returns true when running from monorepo", () => {
    expect(isDevMode()).toBe(true);
  });
});

describe("loadAgent", () => {
  test("returns null when no agent.ts exists", async () => {
    await withTempDir(async (dir) => {
      const result = await loadAgent(dir);
      expect(result).toBeNull();
    });
  });

  test("returns agent entry when agent.ts exists", async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(path.join(dir, "agent.ts"), "export default {}");
      const result = await loadAgent(dir);
      expect(result).not.toBeNull();
      expect(result?.dir).toBe(dir);
      expect(result?.entryPoint).toBe(path.join(dir, "agent.ts"));
      expect(result?.slug).toBe("");
    });
  });

  test("uses slug from project config when available", async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(path.join(dir, "agent.ts"), "export default {}");
      await writeProjectConfig(dir, { slug: "my-agent", serverUrl: "https://example.com" });
      const result = await loadAgent(dir);
      expect(result?.slug).toBe("my-agent");
    });
  });

  test("includes client entry when client.tsx exists", async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(path.join(dir, "agent.ts"), "export default {}");
      await fs.writeFile(path.join(dir, "client.tsx"), "export default {}");
      const result = await loadAgent(dir);
      expect(result?.clientEntry).toBe(path.join(dir, "client.tsx"));
    });
  });

  test("client entry is empty string when no client.tsx", async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(path.join(dir, "agent.ts"), "export default {}");
      const result = await loadAgent(dir);
      expect(result?.clientEntry).toBe("");
    });
  });
});
```

- [ ] **Step 4: Update `init.test.ts` import**

Change line 6:
```ts
// Before:
import { fileExists } from "./_discover.ts";

// After:
import { fileExists } from "./_utils.ts";
```

- [ ] **Step 5: Delete `_discover.test.ts`**

```bash
rm packages/aai-cli/_discover.test.ts
```

- [ ] **Step 6: Run all CLI tests**

Run: `pnpm vitest run --project aai-cli`
Expected: PASS — all tests pass with the new file structure.

- [ ] **Step 7: Commit**

```bash
git add packages/aai-cli/_utils.test.ts packages/aai-cli/_config.test.ts \
  packages/aai-cli/_agent.test.ts packages/aai-cli/_discover.test.ts \
  packages/aai-cli/init.test.ts
git commit -m "refactor(cli): split _discover.test.ts into focused test files"
```

---

### Task 9: Final verification

- [ ] **Step 1: Run full typecheck**

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 2: Run full lint**

Run: `pnpm lint`
Expected: PASS (or only pre-existing warnings)

- [ ] **Step 3: Run all CLI unit tests**

Run: `pnpm vitest run --project aai-cli`
Expected: PASS

- [ ] **Step 4: Run full test suite**

Run: `pnpm test`
Expected: PASS

- [ ] **Step 5: Run check:local**

Run: `pnpm check:local`
Expected: PASS — this is the pre-commit gate and catches syncpack, publint, and other issues.

---

## Design Decision: Skip Zod for `loadAgentDef`

The spec proposed replacing manual validation in `loadAgentDef` with Zod. After examining the code, the manual validation (20 lines) produces clear, specific error messages like `"missing or invalid fields: systemPrompt (string), greeting (string)"`. Zod's default messages (`"Expected string, received undefined"`) are less helpful for this use case. The manual approach is already clean and well-tested. Switching to Zod would not reduce complexity. Skipped in favor of the other simplifications which have clearer payoff.
