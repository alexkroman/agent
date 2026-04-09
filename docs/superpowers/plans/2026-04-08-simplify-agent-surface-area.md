# Simplify Agent Surface Area — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `defineAgent()` + Zod + Vite bundler with a file-convention agent format (`agent.json` + `tools/*.ts` + `hooks/*.ts`) where the bundle matches what runs in production.

**Architecture:** Agents become directories. `agent.json` is pure config (read as-is by host). Each tool is a self-contained `.ts` file exporting `description`, `parameters` (JSON Schema), and a default execute function. The build step scans tool files via AST extraction + esbuild compilation — no `node:vm` eval, no Zod. The runtime dispatcher routes RPC messages to handler files by name.

**Tech Stack:** esbuild (handler compilation), es-module-lexer + acorn (AST extraction of tool metadata), Ajv (JSON Schema validation at runtime), vitest (testing)

**Spec:** `docs/superpowers/specs/2026-04-08-simplify-agent-surface-area-design.md`

---

## File Structure

### New files to create

| File | Purpose |
|------|---------|
| `packages/aai/isolate/manifest.ts` | Manifest types + schema + defaults |
| `packages/aai/isolate/manifest.test.ts` | Tests for manifest types |
| `packages/aai-cli/_scanner.ts` | Scans agent directory → manifest object |
| `packages/aai-cli/_scanner.test.ts` | Tests for directory scanner |
| `packages/aai-cli/_dev-server.ts` | Dev server for directory-format agents |

### Files to rewrite

| File | Change |
|------|--------|
| `packages/aai-cli/_bundler.ts` | Replace Vite SSR + node:vm with esbuild + scanner |
| `packages/aai-server/harness-runtime.ts` | Replace single-bundle dispatcher with file-per-tool RPC |
| `packages/aai/host/testing.ts` | Replace `createTestHarness(AgentDef)` with `createTestHarness(agentDir)` |
| `packages/aai-templates/templates/*/` | Rewrite every template from defineAgent to directory format |
| `packages/aai-templates/scaffold/` | Rewrite scaffold for directory format |

### Files to modify

| File | Change |
|------|--------|
| `packages/aai/isolate/index.ts` | Re-export manifest types |
| `packages/aai/index.ts` | Replace defineAgent/defineTool exports with manifest types |
| `packages/aai/package.json` | Update exports map |
| `packages/aai-cli/cli.ts` | Wire new bundler into build/deploy commands |
| `packages/aai-cli/dev.ts` | Use new dev server |
| `packages/aai-cli/deploy.ts` | Use new bundler output |
| `packages/aai-cli/init.ts` | Scaffold directory-format projects |

### Files to remove

| File | Reason |
|------|--------|
| `packages/aai/isolate/types.ts` | `defineAgent`, `defineTool`, `defineToolFactory` replaced by file conventions |
| `packages/aai/host/vite-plugin.ts` | Vite no longer needed for agent dev server |

---

## Task 1: Manifest Types and Schema

Define the canonical manifest format that flows from build to host to isolate.

**Files:**
- Create: `packages/aai/isolate/manifest.ts`
- Create: `packages/aai/isolate/manifest.test.ts`
- Modify: `packages/aai/isolate/index.ts`

- [ ] **Step 1: Write the failing test for manifest types**

```typescript
// packages/aai/isolate/manifest.test.ts
import { describe, expect, test } from "vitest";
import { parseManifest, type Manifest } from "./manifest.ts";

describe("parseManifest", () => {
  test("minimal manifest requires only name", () => {
    const result = parseManifest({ name: "Simple Agent" });
    expect(result).toEqual({
      name: "Simple Agent",
      systemPrompt: expect.any(String), // DEFAULT_SYSTEM_PROMPT
      greeting: expect.any(String), // DEFAULT_GREETING
      maxSteps: 5,
      toolChoice: "auto",
      builtinTools: [],
      tools: {},
      hooks: {
        onConnect: false,
        onDisconnect: false,
        onUserTranscript: false,
        onError: false,
      },
    });
  });

  test("full manifest passes through all fields", () => {
    const input = {
      name: "Weather Agent",
      systemPrompt: "You are a weather bot.",
      greeting: "What city?",
      sttPrompt: "Celsius, Fahrenheit",
      builtinTools: ["web_search"],
      maxSteps: 10,
      toolChoice: "required" as const,
      idleTimeoutMs: 60000,
      theme: { bg: "#000", primary: "#fff" },
      tools: {
        get_weather: {
          description: "Get weather",
          parameters: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
          },
        },
      },
      hooks: {
        onConnect: true,
        onDisconnect: false,
        onUserTranscript: true,
        onError: false,
      },
    };
    const result = parseManifest(input);
    expect(result.name).toBe("Weather Agent");
    expect(result.systemPrompt).toBe("You are a weather bot.");
    expect(result.tools.get_weather.description).toBe("Get weather");
    expect(result.hooks.onConnect).toBe(true);
    expect(result.maxSteps).toBe(10);
    expect(result.toolChoice).toBe("required");
  });

  test("rejects manifest without name", () => {
    expect(() => parseManifest({})).toThrow();
  });

  test("rejects unknown builtinTools", () => {
    expect(() =>
      parseManifest({ name: "X", builtinTools: ["not_a_tool"] }),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/aai/isolate/manifest.test.ts`
Expected: FAIL — `./manifest.ts` does not exist

- [ ] **Step 3: Implement manifest types and parser**

```typescript
// packages/aai/isolate/manifest.ts
import { z } from "zod";
import { DEFAULT_GREETING, DEFAULT_SYSTEM_PROMPT } from "./system-prompt.ts";

// --- Tool schema (JSON Schema subset) ---

export type ToolManifest = {
  description: string;
  parameters?: Record<string, unknown>; // JSON Schema object
};

// --- Hook flags ---

export type HookFlags = {
  onConnect: boolean;
  onDisconnect: boolean;
  onUserTranscript: boolean;
  onError: boolean;
};

// --- Full manifest ---

export type Manifest = {
  name: string;
  systemPrompt: string;
  greeting: string;
  sttPrompt?: string;
  builtinTools: string[];
  maxSteps: number;
  toolChoice: "auto" | "required";
  idleTimeoutMs?: number;
  theme?: Record<string, string>;
  tools: Record<string, ToolManifest>;
  hooks: HookFlags;
};

// --- Zod schema for validation ---

const ToolManifestSchema = z.object({
  description: z.string(),
  parameters: z.record(z.unknown()).optional(),
});

const HookFlagsSchema = z.object({
  onConnect: z.boolean(),
  onDisconnect: z.boolean(),
  onUserTranscript: z.boolean(),
  onError: z.boolean(),
});

const BUILTIN_TOOLS = ["web_search", "visit_webpage", "fetch_json", "run_code"];

const ManifestSchema = z.object({
  name: z.string().min(1),
  systemPrompt: z.string().optional(),
  greeting: z.string().optional(),
  sttPrompt: z.string().optional(),
  builtinTools: z
    .array(z.enum(BUILTIN_TOOLS as [string, ...string[]]))
    .optional(),
  maxSteps: z.number().int().positive().optional(),
  toolChoice: z.enum(["auto", "required"]).optional(),
  idleTimeoutMs: z.number().int().positive().optional(),
  theme: z.record(z.string()).optional(),
  tools: z.record(ToolManifestSchema).optional(),
  hooks: HookFlagsSchema.optional(),
});

const DEFAULT_HOOKS: HookFlags = {
  onConnect: false,
  onDisconnect: false,
  onUserTranscript: false,
  onError: false,
};

export function parseManifest(input: unknown): Manifest {
  const parsed = ManifestSchema.parse(input);
  return {
    name: parsed.name,
    systemPrompt: parsed.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
    greeting: parsed.greeting ?? DEFAULT_GREETING,
    sttPrompt: parsed.sttPrompt,
    builtinTools: parsed.builtinTools ?? [],
    maxSteps: parsed.maxSteps ?? 5,
    toolChoice: parsed.toolChoice ?? "auto",
    idleTimeoutMs: parsed.idleTimeoutMs,
    theme: parsed.theme,
    tools: parsed.tools ?? {},
    hooks: parsed.hooks ?? DEFAULT_HOOKS,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/aai/isolate/manifest.test.ts`
Expected: PASS (all 4 tests)

- [ ] **Step 5: Export from isolate barrel**

Add to `packages/aai/isolate/index.ts`:
```typescript
export * from "./manifest.ts";
```

- [ ] **Step 6: Commit**

```bash
git add packages/aai/isolate/manifest.ts packages/aai/isolate/manifest.test.ts packages/aai/isolate/index.ts
git commit -m "feat: add manifest types and parser for directory-based agents"
```

---

## Task 2: Agent Directory Scanner

Scans an agent directory (`agent.json` + `tools/*.ts` + `hooks/*.ts`) and produces a `Manifest` object.

**Files:**
- Create: `packages/aai-cli/_scanner.ts`
- Create: `packages/aai-cli/_scanner.test.ts`

**Dependencies:** Task 1 (manifest types)

- [ ] **Step 1: Write the failing test for directory scanning**

```typescript
// packages/aai-cli/_scanner.test.ts
import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanAgentDir } from "./_scanner.ts";

describe("scanAgentDir", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "aai-scan-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("minimal agent: just agent.json", async () => {
    await writeFile(
      join(dir, "agent.json"),
      JSON.stringify({ name: "Simple" }),
    );
    const manifest = await scanAgentDir(dir);
    expect(manifest.name).toBe("Simple");
    expect(manifest.tools).toEqual({});
    expect(manifest.hooks.onConnect).toBe(false);
  });

  test("scans tools directory for tool metadata", async () => {
    await writeFile(
      join(dir, "agent.json"),
      JSON.stringify({ name: "Test" }),
    );
    await mkdir(join(dir, "tools"));
    await writeFile(
      join(dir, "tools", "get_weather.ts"),
      `export const description = "Get weather for a city";

export const parameters = {
  type: "object",
  properties: {
    city: { type: "string", description: "City name" }
  },
  required: ["city"]
};

export default async function execute(args, ctx) {
  return { temp: 72 };
}`,
    );
    const manifest = await scanAgentDir(dir);
    expect(manifest.tools.get_weather).toEqual({
      description: "Get weather for a city",
      parameters: {
        type: "object",
        properties: { city: { type: "string", description: "City name" } },
        required: ["city"],
      },
    });
  });

  test("scans hooks directory for hook presence", async () => {
    await writeFile(
      join(dir, "agent.json"),
      JSON.stringify({ name: "Test" }),
    );
    await mkdir(join(dir, "hooks"));
    await writeFile(
      join(dir, "hooks", "on-connect.ts"),
      `export default async function onConnect(ctx) {}`,
    );
    await writeFile(
      join(dir, "hooks", "on-error.ts"),
      `export default function onError(err) {}`,
    );
    const manifest = await scanAgentDir(dir);
    expect(manifest.hooks).toEqual({
      onConnect: true,
      onDisconnect: false,
      onUserTranscript: true, // wait, this should be false
      onError: true,
    });
  });

  test("tool without parameters export works", async () => {
    await writeFile(
      join(dir, "agent.json"),
      JSON.stringify({ name: "Test" }),
    );
    await mkdir(join(dir, "tools"));
    await writeFile(
      join(dir, "tools", "flip_coin.ts"),
      `export const description = "Flip a coin";
export default function execute() { return { result: "heads" }; }`,
    );
    const manifest = await scanAgentDir(dir);
    expect(manifest.tools.flip_coin).toEqual({
      description: "Flip a coin",
    });
  });

  test("resolves systemPrompt $ref", async () => {
    await writeFile(join(dir, "system-prompt.md"), "You are a helpful bot.");
    await writeFile(
      join(dir, "agent.json"),
      JSON.stringify({
        name: "Test",
        systemPrompt: { $ref: "system-prompt.md" },
      }),
    );
    const manifest = await scanAgentDir(dir);
    expect(manifest.systemPrompt).toBe("You are a helpful bot.");
  });

  test("throws if agent.json is missing", async () => {
    await expect(scanAgentDir(dir)).rejects.toThrow(/agent\.json/);
  });

  test("throws if tool file is missing description export", async () => {
    await writeFile(
      join(dir, "agent.json"),
      JSON.stringify({ name: "Test" }),
    );
    await mkdir(join(dir, "tools"));
    await writeFile(
      join(dir, "tools", "bad_tool.ts"),
      `export default function execute() { return {}; }`,
    );
    await expect(scanAgentDir(dir)).rejects.toThrow(/description/);
  });
});
```

Note: Fix the hooks test — `onUserTranscript` should be `false` since `on-user-transcript.ts` was not created:

```typescript
  test("scans hooks directory for hook presence", async () => {
    // ... same setup ...
    const manifest = await scanAgentDir(dir);
    expect(manifest.hooks).toEqual({
      onConnect: true,
      onDisconnect: false,
      onUserTranscript: false,
      onError: true,
    });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/aai-cli/_scanner.test.ts`
Expected: FAIL — `_scanner.ts` does not exist

- [ ] **Step 3: Implement the scanner**

```typescript
// packages/aai-cli/_scanner.ts
import { readFile, readdir, access } from "node:fs/promises";
import { join, basename, extname } from "node:path";
import { parseManifest, type Manifest, type HookFlags } from "@alexkroman1/aai/isolate";

// Hook filename → manifest key mapping
const HOOK_FILE_MAP: Record<string, keyof HookFlags> = {
  "on-connect": "onConnect",
  "on-disconnect": "onDisconnect",
  "on-user-transcript": "onUserTranscript",
  "on-error": "onError",
};

/**
 * Extract the value of `export const <name> = <literal>` from source text.
 * Only handles string literals and object/array literals (JSON-compatible).
 * Returns undefined if the export is not found.
 */
export function extractConstExport(
  source: string,
  exportName: string,
): unknown | undefined {
  // Match: export const <name> = <value>;
  // Where <value> starts at a quote (string), brace (object), or bracket (array)
  const pattern = new RegExp(
    `export\\s+const\\s+${exportName}\\s*=\\s*([\\s\\S]*?)(?:;\\s*(?:export|$))`,
    "m",
  );
  const match = source.match(pattern);
  if (!match) return undefined;

  let raw = match[1].trim();
  // Strip trailing semicolons
  raw = raw.replace(/;\s*$/, "");

  if (raw.startsWith('"') || raw.startsWith("'") || raw.startsWith("`")) {
    // String literal — remove quotes
    return raw.slice(1, -1);
  }

  // Object or array literal — parse as JSON
  // Convert JS object literal to JSON:
  // - unquoted keys → quoted keys
  // - trailing commas → removed
  const jsonified = raw
    .replace(/(['"])?(\w+)(['"])?\s*:/g, '"$2":') // quote keys
    .replace(/,\s*([}\]])/g, "$1") // remove trailing commas
    .replace(/'/g, '"'); // single → double quotes
  try {
    return JSON.parse(jsonified);
  } catch {
    throw new Error(
      `Failed to parse \`export const ${exportName}\` as JSON. ` +
        `Tool parameters must be a JSON-compatible object literal (no computed values, no function calls).`,
    );
  }
}

async function dirExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function resolveRef(
  value: unknown,
  agentDir: string,
): Promise<unknown> {
  if (
    typeof value === "object" &&
    value !== null &&
    "$ref" in value &&
    typeof (value as Record<string, unknown>).$ref === "string"
  ) {
    const refPath = join(agentDir, (value as { $ref: string }).$ref);
    return readFile(refPath, "utf-8");
  }
  return value;
}

export async function scanAgentDir(agentDir: string): Promise<Manifest> {
  // 1. Read agent.json
  let agentJsonRaw: string;
  try {
    agentJsonRaw = await readFile(join(agentDir, "agent.json"), "utf-8");
  } catch {
    throw new Error(
      `No agent.json found in ${agentDir}. An agent directory must contain agent.json.`,
    );
  }
  const agentJson = JSON.parse(agentJsonRaw);

  // 2. Resolve $ref in systemPrompt
  if (agentJson.systemPrompt) {
    agentJson.systemPrompt = await resolveRef(
      agentJson.systemPrompt,
      agentDir,
    );
  }

  // 3. Scan tools/
  const tools: Record<string, { description: string; parameters?: Record<string, unknown> }> = {};
  const toolsDir = join(agentDir, "tools");
  if (await dirExists(toolsDir)) {
    const files = await readdir(toolsDir);
    for (const file of files) {
      if (!file.endsWith(".ts") && !file.endsWith(".js")) continue;
      const toolName = basename(file, extname(file));
      const source = await readFile(join(toolsDir, file), "utf-8");

      const description = extractConstExport(source, "description");
      if (typeof description !== "string") {
        throw new Error(
          `Tool file tools/${file} must export a \`description\` string. ` +
            `Add: export const description = "What this tool does";`,
        );
      }

      const parameters = extractConstExport(source, "parameters");
      tools[toolName] = {
        description,
        ...(parameters ? { parameters: parameters as Record<string, unknown> } : {}),
      };
    }
  }

  // 4. Scan hooks/
  const hooks: HookFlags = {
    onConnect: false,
    onDisconnect: false,
    onUserTranscript: false,
    onError: false,
  };
  const hooksDir = join(agentDir, "hooks");
  if (await dirExists(hooksDir)) {
    const files = await readdir(hooksDir);
    for (const file of files) {
      if (!file.endsWith(".ts") && !file.endsWith(".js")) continue;
      const hookFile = basename(file, extname(file));
      const hookKey = HOOK_FILE_MAP[hookFile];
      if (hookKey) {
        hooks[hookKey] = true;
      }
    }
  }

  // 5. Merge and parse
  return parseManifest({ ...agentJson, tools, hooks });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/aai-cli/_scanner.test.ts`
Expected: PASS (all 7 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/aai-cli/_scanner.ts packages/aai-cli/_scanner.test.ts
git commit -m "feat: add agent directory scanner for file-convention format"
```

---

## Task 3: New esbuild-based Bundler

Replaces the Vite SSR + `node:vm` eval pipeline with AST scan + esbuild.

**Files:**
- Create: `packages/aai-cli/_bundler-v2.ts`
- Create: `packages/aai-cli/_bundler-v2.test.ts`

**Dependencies:** Task 1 (manifest types), Task 2 (scanner)

- [ ] **Step 1: Write the failing test for new bundler**

```typescript
// packages/aai-cli/_bundler-v2.test.ts
import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundleAgentV2, type BundleOutputV2 } from "./_bundler-v2.ts";

describe("bundleAgentV2", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "aai-bundle-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function writeMinimalAgent() {
    await writeFile(
      join(dir, "agent.json"),
      JSON.stringify({ name: "Test Agent" }),
    );
  }

  test("produces manifest.json in output", async () => {
    await writeMinimalAgent();
    const output = await bundleAgentV2(dir);
    expect(output.manifest.name).toBe("Test Agent");
    expect(output.manifestJson).toContain('"name":"Test Agent"');
  });

  test("compiles tool handlers to JS", async () => {
    await writeMinimalAgent();
    await mkdir(join(dir, "tools"));
    await writeFile(
      join(dir, "tools", "greet.ts"),
      `export const description = "Say hello";
export default function execute() { return { message: "hello" }; }`,
    );
    const output = await bundleAgentV2(dir);
    expect(output.manifest.tools.greet.description).toBe("Say hello");
    expect(output.toolBundles.greet).toContain("hello"); // compiled JS
  });

  test("compiles hook handlers to JS", async () => {
    await writeMinimalAgent();
    await mkdir(join(dir, "hooks"));
    await writeFile(
      join(dir, "hooks", "on-connect.ts"),
      `export default async function onConnect(ctx) { console.log("hi"); }`,
    );
    const output = await bundleAgentV2(dir);
    expect(output.manifest.hooks.onConnect).toBe(true);
    expect(output.hookBundles.onConnect).toContain("console.log"); // compiled JS
  });

  test("output contains no Zod references", async () => {
    await writeMinimalAgent();
    await mkdir(join(dir, "tools"));
    await writeFile(
      join(dir, "tools", "example.ts"),
      `export const description = "Example tool";
export const parameters = { type: "object", properties: { x: { type: "number" } } };
export default function execute(args) { return args.x * 2; }`,
    );
    const output = await bundleAgentV2(dir);
    expect(output.manifestJson).not.toContain("zod");
    expect(output.toolBundles.example).not.toContain("zod");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/aai-cli/_bundler-v2.test.ts`
Expected: FAIL — `_bundler-v2.ts` does not exist

- [ ] **Step 3: Implement the new bundler**

```typescript
// packages/aai-cli/_bundler-v2.ts
import { build } from "esbuild";
import { readdir } from "node:fs/promises";
import { join, basename, extname } from "node:path";
import { scanAgentDir } from "./_scanner.ts";
import type { Manifest } from "@alexkroman1/aai/isolate";

export type BundleOutputV2 = {
  manifest: Manifest;
  manifestJson: string;
  toolBundles: Record<string, string>; // toolName → compiled JS
  hookBundles: Record<string, string>; // hookKey → compiled JS
  clientDir?: string; // path to built client assets (if client.tsx exists)
};

async function compileFile(entryPoint: string): Promise<string> {
  const result = await build({
    entryPoints: [entryPoint],
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    target: "node20",
    minify: false, // keep readable for debugging
  });
  return result.outputFiles[0].text;
}

// Hook filename → manifest key mapping
const HOOK_FILE_MAP: Record<string, string> = {
  "on-connect": "onConnect",
  "on-disconnect": "onDisconnect",
  "on-user-transcript": "onUserTranscript",
  "on-error": "onError",
};

export async function bundleAgentV2(
  agentDir: string,
): Promise<BundleOutputV2> {
  // 1. Scan directory to produce manifest
  const manifest = await scanAgentDir(agentDir);
  const manifestJson = JSON.stringify(manifest);

  // 2. Compile tool handlers
  const toolBundles: Record<string, string> = {};
  const toolsDir = join(agentDir, "tools");
  try {
    const toolFiles = await readdir(toolsDir);
    for (const file of toolFiles) {
      if (!file.endsWith(".ts") && !file.endsWith(".js")) continue;
      const toolName = basename(file, extname(file));
      toolBundles[toolName] = await compileFile(join(toolsDir, file));
    }
  } catch {
    // No tools/ directory — that's fine
  }

  // 3. Compile hook handlers
  const hookBundles: Record<string, string> = {};
  const hooksDir = join(agentDir, "hooks");
  try {
    const hookFiles = await readdir(hooksDir);
    for (const file of hookFiles) {
      if (!file.endsWith(".ts") && !file.endsWith(".js")) continue;
      const hookFile = basename(file, extname(file));
      const hookKey = HOOK_FILE_MAP[hookFile];
      if (hookKey) {
        hookBundles[hookKey] = await compileFile(join(hooksDir, file));
      }
    }
  } catch {
    // No hooks/ directory — that's fine
  }

  return { manifest, manifestJson, toolBundles, hookBundles };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/aai-cli/_bundler-v2.test.ts`
Expected: PASS (all 4 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/aai-cli/_bundler-v2.ts packages/aai-cli/_bundler-v2.test.ts
git commit -m "feat: add esbuild-based bundler for directory agents"
```

---

## Task 4: Runtime Dispatcher (Isolate Side)

Replaces `harness-runtime.ts` with a file-per-tool RPC dispatcher.

**Files:**
- Create: `packages/aai-server/harness-runtime-v2.ts`
- Create: `packages/aai-server/harness-runtime-v2.test.ts`

**Dependencies:** Task 1 (manifest types)

- [ ] **Step 1: Write the failing test for the dispatcher**

```typescript
// packages/aai-server/harness-runtime-v2.test.ts
import { describe, expect, test, vi } from "vitest";
import { createDispatcher, type ToolHandler, type HookHandler } from "./harness-runtime-v2.ts";

describe("createDispatcher", () => {
  test("dispatches tool call to correct handler", async () => {
    const tools: Record<string, ToolHandler> = {
      greet: {
        default: vi.fn(async (args) => ({ message: `hello ${args.name}` })),
        parameters: {
          type: "object",
          properties: { name: { type: "string" } },
        },
      },
    };

    const dispatch = createDispatcher({ tools, hooks: {} });
    const result = await dispatch({
      type: "tool",
      name: "greet",
      args: { name: "world" },
      sessionId: "s1",
      messages: [],
    });

    expect(tools.greet.default).toHaveBeenCalledWith(
      { name: "world" },
      expect.objectContaining({ sessionId: "s1" }),
    );
    expect(result).toEqual({ result: '{"message":"hello world"}' });
  });

  test("dispatches hook to correct handler", async () => {
    const hooks: Record<string, HookHandler> = {
      onConnect: {
        default: vi.fn(async (ctx) => {}),
      },
    };

    const dispatch = createDispatcher({ tools: {}, hooks });
    const result = await dispatch({
      type: "hook",
      hook: "onConnect",
      sessionId: "s1",
    });

    expect(hooks.onConnect.default).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "s1" }),
    );
    expect(result).toEqual({});
  });

  test("dispatches onUserTranscript with text arg", async () => {
    const hooks: Record<string, HookHandler> = {
      onUserTranscript: {
        default: vi.fn(async (text, ctx) => {}),
      },
    };

    const dispatch = createDispatcher({ tools: {}, hooks });
    await dispatch({
      type: "hook",
      hook: "onUserTranscript",
      sessionId: "s1",
      text: "hello",
    });

    expect(hooks.onUserTranscript.default).toHaveBeenCalledWith(
      "hello",
      expect.objectContaining({ sessionId: "s1" }),
    );
  });

  test("returns error for unknown tool", async () => {
    const dispatch = createDispatcher({ tools: {}, hooks: {} });
    const result = await dispatch({
      type: "tool",
      name: "nonexistent",
      args: {},
      sessionId: "s1",
      messages: [],
    });
    expect(result).toEqual({
      result: expect.stringContaining("nonexistent"),
      error: true,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/aai-server/harness-runtime-v2.test.ts`
Expected: FAIL — module does not exist

- [ ] **Step 3: Implement the dispatcher**

```typescript
// packages/aai-server/harness-runtime-v2.ts

export type ToolHandler = {
  default: (args: unknown, ctx: ToolContext) => Promise<unknown> | unknown;
  description?: string;
  parameters?: Record<string, unknown>;
};

export type HookHandler = {
  default: (...args: unknown[]) => Promise<void> | void;
};

type ToolContext = {
  env: Readonly<Record<string, string>>;
  kv: Kv;
  messages: readonly { role: string; content: string }[];
  sessionId: string;
};

type HookContext = {
  env: Readonly<Record<string, string>>;
  kv: Kv;
  sessionId: string;
};

type Kv = {
  get<T = unknown>(key: string): Promise<T | null>;
  set(key: string, value: unknown, opts?: { expireIn?: number }): Promise<void>;
  delete(key: string | string[]): Promise<void>;
};

type RpcMessage =
  | {
      type: "tool";
      name: string;
      args: Record<string, unknown>;
      sessionId: string;
      messages: { role: string; content: string }[];
    }
  | {
      type: "hook";
      hook: string;
      sessionId: string;
      text?: string;
      error?: { message: string };
    };

type DispatchResult = { result?: string; error?: boolean };

export function createDispatcher(opts: {
  tools: Record<string, ToolHandler>;
  hooks: Record<string, HookHandler>;
  env?: Record<string, string>;
  kv?: Kv;
}): (msg: RpcMessage) => Promise<DispatchResult> {
  const { tools, hooks } = opts;
  const env = Object.freeze(opts.env ?? {});
  const kv = opts.kv ?? nullKv;

  return async (msg: RpcMessage): Promise<DispatchResult> => {
    if (msg.type === "tool") {
      const tool = tools[msg.name];
      if (!tool) {
        return {
          result: JSON.stringify({
            error: `Unknown tool: ${msg.name}`,
          }),
          error: true,
        };
      }

      const ctx: ToolContext = {
        env,
        kv,
        messages: msg.messages,
        sessionId: msg.sessionId,
      };

      const result = await tool.default(msg.args, ctx);
      return { result: JSON.stringify(result) };
    }

    if (msg.type === "hook") {
      const hook = hooks[msg.hook];
      if (!hook) return {};

      const ctx: HookContext = { env, kv, sessionId: msg.sessionId };

      if (msg.hook === "onUserTranscript" && msg.text !== undefined) {
        await hook.default(msg.text, ctx);
      } else if (msg.hook === "onError" && msg.error) {
        await hook.default(msg.error, ctx);
      } else {
        await hook.default(ctx);
      }

      return {};
    }

    return {};
  };
}

const nullKv: Kv = {
  async get() { return null; },
  async set() {},
  async delete() {},
};

// --- Isolate entry point (used when running inside SecureExec) ---

export async function startDispatcher(
  tools: Record<string, ToolHandler>,
  hooks: Record<string, HookHandler>,
): Promise<void> {
  const agentEnv = Object.freeze(
    Object.fromEntries(
      Object.entries(
        (globalThis as Record<string, unknown>).process
          ? (process.env as Record<string, string>)
          : {},
      ).filter(([k]) => k.startsWith("AAI_ENV_")),
    ),
  );

  const kv: Kv = {
    async get(key) {
      return SecureExec.bindings.kv.get(key);
    },
    async set(key, value, opts) {
      return SecureExec.bindings.kv.set(key, value, opts?.expireIn);
    },
    async delete(key) {
      const keys = Array.isArray(key) ? key : [key];
      for (const k of keys) await SecureExec.bindings.kv.del(k);
    },
  };

  const dispatch = createDispatcher({ tools, hooks, env: agentEnv, kv });

  // Pull-based RPC loop
  while (true) {
    const msg = await SecureExec.bindings.rpc.recv();
    try {
      const result = await dispatch(msg as RpcMessage);
      SecureExec.bindings.rpc.send(msg.id, result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      SecureExec.bindings.rpc.send(msg.id, null, message);
    }
  }
}

// SecureExec type declarations for isolate environment
declare const SecureExec: {
  bindings: {
    kv: {
      get(key: string): Promise<unknown>;
      set(key: string, value: unknown, expireIn?: number): Promise<void>;
      del(key: string): Promise<void>;
    };
    rpc: {
      recv(): Promise<RpcMessage & { id: string }>;
      send(id: string, result: unknown, errorMsg?: string): void;
    };
  };
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/aai-server/harness-runtime-v2.test.ts`
Expected: PASS (all 4 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/aai-server/harness-runtime-v2.ts packages/aai-server/harness-runtime-v2.test.ts
git commit -m "feat: add file-per-tool RPC dispatcher for isolate runtime"
```

---

## Task 5: Updated Test Harness

New `createTestHarness` that works with directory-based agents. Loads tool files directly and executes them in-process.

**Files:**
- Create: `packages/aai/host/testing-v2.ts`
- Create: `packages/aai/host/testing-v2.test.ts`

**Dependencies:** Task 1 (manifest types), Task 4 (dispatcher)

- [ ] **Step 1: Write the failing test for the new test harness**

```typescript
// packages/aai/host/testing-v2.test.ts
import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDirTestHarness } from "./testing-v2.ts";

describe("createDirTestHarness", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "aai-test-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("executes a tool from a directory agent", async () => {
    await writeFile(
      join(dir, "agent.json"),
      JSON.stringify({ name: "Test" }),
    );
    await mkdir(join(dir, "tools"));
    await writeFile(
      join(dir, "tools", "double.ts"),
      `export const description = "Double a number";
export const parameters = { type: "object", properties: { n: { type: "number" } }, required: ["n"] };
export default function execute(args) { return { result: args.n * 2 }; }`,
    );

    const harness = await createDirTestHarness(dir);
    const result = await harness.executeTool("double", { n: 5 });
    expect(result).toEqual({ result: 10 });
  });

  test("tool receives ctx with kv and sessionId", async () => {
    await writeFile(
      join(dir, "agent.json"),
      JSON.stringify({ name: "Test" }),
    );
    await mkdir(join(dir, "tools"));
    await writeFile(
      join(dir, "tools", "store.ts"),
      `export const description = "Store a value";
export const parameters = { type: "object", properties: { key: { type: "string" }, val: { type: "string" } } };
export default async function execute(args, ctx) {
  await ctx.kv.set(args.key, args.val);
  return { stored: true };
}`,
    );
    await writeFile(
      join(dir, "tools", "retrieve.ts"),
      `export const description = "Retrieve a value";
export const parameters = { type: "object", properties: { key: { type: "string" } } };
export default async function execute(args, ctx) {
  const val = await ctx.kv.get(args.key);
  return { value: val };
}`,
    );

    const harness = await createDirTestHarness(dir);
    await harness.executeTool("store", { key: "color", val: "blue" });
    const result = await harness.executeTool("retrieve", { key: "color" });
    expect(result).toEqual({ value: "blue" });
  });

  test("fires onConnect hook", async () => {
    await writeFile(
      join(dir, "agent.json"),
      JSON.stringify({ name: "Test" }),
    );
    await mkdir(join(dir, "hooks"));
    await writeFile(
      join(dir, "hooks", "on-connect.ts"),
      `export default async function onConnect(ctx) {
  await ctx.kv.set("connected", true);
}`,
    );
    await mkdir(join(dir, "tools"));
    await writeFile(
      join(dir, "tools", "check.ts"),
      `export const description = "Check connection";
export default async function execute(args, ctx) {
  return { connected: await ctx.kv.get("connected") };
}`,
    );

    const harness = await createDirTestHarness(dir);
    await harness.connect();
    const result = await harness.executeTool("check", {});
    expect(result).toEqual({ connected: true });
  });

  test("turn simulates tool calls in sequence", async () => {
    await writeFile(
      join(dir, "agent.json"),
      JSON.stringify({ name: "Test" }),
    );
    await mkdir(join(dir, "tools"));
    await writeFile(
      join(dir, "tools", "add.ts"),
      `export const description = "Add two numbers";
export const parameters = { type: "object", properties: { a: { type: "number" }, b: { type: "number" } } };
export default function execute(args) { return { sum: args.a + args.b }; }`,
    );

    const harness = await createDirTestHarness(dir);
    const turn = await harness.turn("what is 2+3?", [
      { tool: "add", args: { a: 2, b: 3 } },
    ]);
    expect(turn.toolResult("add")).toEqual({ sum: 5 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/aai/host/testing-v2.test.ts`
Expected: FAIL — module does not exist

- [ ] **Step 3: Implement the test harness**

This harness dynamically imports tool/hook files from the agent directory and executes them in-process with an in-memory KV store.

```typescript
// packages/aai/host/testing-v2.ts
import { readdir } from "node:fs/promises";
import { join, basename, extname } from "node:path";
import { pathToFileURL } from "node:url";
import { createUnstorageKv } from "./unstorage-kv.ts";

type TurnToolCall = { tool: string; args: Record<string, unknown> };

type RecordedToolCall = {
  name: string;
  args: Record<string, unknown>;
  result: unknown;
};

export class TurnResult {
  readonly toolCalls: RecordedToolCall[];

  constructor(toolCalls: RecordedToolCall[]) {
    this.toolCalls = toolCalls;
  }

  toolResult<T = unknown>(toolName: string): T {
    const call = this.toolCalls.find((c) => c.name === toolName);
    if (!call) {
      throw new Error(
        `Tool "${toolName}" was not called. Called: ${this.toolCalls.map((c) => c.name).join(", ")}`,
      );
    }
    return call.result as T;
  }
}

export class DirTestHarness {
  private tools: Record<string, { default: Function }> = {};
  private hooks: Record<string, { default: Function }> = {};
  private kv: ReturnType<typeof createUnstorageKv>;
  private sessionId: string;
  private messages: { role: string; content: string }[] = [];

  constructor(
    tools: Record<string, { default: Function }>,
    hooks: Record<string, { default: Function }>,
    kv: ReturnType<typeof createUnstorageKv>,
    sessionId: string,
  ) {
    this.tools = tools;
    this.hooks = hooks;
    this.kv = kv;
    this.sessionId = sessionId;
  }

  private get ctx() {
    return {
      env: {},
      kv: this.kv,
      sessionId: this.sessionId,
      messages: this.messages,
    };
  }

  async connect(): Promise<void> {
    const hook = this.hooks.onConnect;
    if (hook) await hook.default(this.ctx);
  }

  async disconnect(): Promise<void> {
    const hook = this.hooks.onDisconnect;
    if (hook) await hook.default(this.ctx);
  }

  async executeTool(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const tool = this.tools[toolName];
    if (!tool) {
      throw new Error(
        `Tool "${toolName}" not found. Available: ${Object.keys(this.tools).join(", ")}`,
      );
    }
    return tool.default(args, this.ctx);
  }

  async turn(
    text: string,
    toolCalls: TurnToolCall[],
  ): Promise<TurnResult> {
    this.messages.push({ role: "user", content: text });

    // Fire onUserTranscript if hook exists
    const transcriptHook = this.hooks.onUserTranscript;
    if (transcriptHook) await transcriptHook.default(text, this.ctx);

    const recorded: RecordedToolCall[] = [];
    for (const call of toolCalls) {
      const result = await this.executeTool(call.tool, call.args);
      recorded.push({ name: call.tool, args: call.args, result });
    }

    return new TurnResult(recorded);
  }
}

const HOOK_FILE_MAP: Record<string, string> = {
  "on-connect": "onConnect",
  "on-disconnect": "onDisconnect",
  "on-user-transcript": "onUserTranscript",
  "on-error": "onError",
};

export async function createDirTestHarness(
  agentDir: string,
  options?: { sessionId?: string },
): Promise<DirTestHarness> {
  const sessionId = options?.sessionId ?? "test-session";
  const kv = createUnstorageKv();

  // Load tool files
  const tools: Record<string, { default: Function }> = {};
  const toolsDir = join(agentDir, "tools");
  try {
    const files = await readdir(toolsDir);
    for (const file of files) {
      if (!file.endsWith(".ts") && !file.endsWith(".js")) continue;
      const toolName = basename(file, extname(file));
      const mod = await import(pathToFileURL(join(toolsDir, file)).href);
      tools[toolName] = mod;
    }
  } catch {
    // No tools/ directory
  }

  // Load hook files
  const hooks: Record<string, { default: Function }> = {};
  const hooksDir = join(agentDir, "hooks");
  try {
    const files = await readdir(hooksDir);
    for (const file of files) {
      if (!file.endsWith(".ts") && !file.endsWith(".js")) continue;
      const hookFile = basename(file, extname(file));
      const hookKey = HOOK_FILE_MAP[hookFile];
      if (hookKey) {
        const mod = await import(pathToFileURL(join(hooksDir, file)).href);
        hooks[hookKey] = mod;
      }
    }
  } catch {
    // No hooks/ directory
  }

  return new DirTestHarness(tools, hooks, kv, sessionId);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/aai/host/testing-v2.test.ts`
Expected: PASS (all 4 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/aai/host/testing-v2.ts packages/aai/host/testing-v2.test.ts
git commit -m "feat: add test harness for directory-based agents"
```

---

## Task 6: Rewrite All Templates to Directory Format

Rewrite every existing template in-place from `defineAgent()` to the directory convention. Delete `agent.ts`, create `agent.json` + `tools/*.ts` + `hooks/*.ts`. Convert `state()` → `ctx.kv`. Remove all Zod and SDK imports from agent code.

**Files:**
- Rewrite: All directories under `packages/aai-templates/templates/`
- Rewrite: `packages/aai-templates/scaffold/`

**Dependencies:** Task 5 (test harness)

Each template follows this mechanical conversion:

1. Read `agent.ts` → extract `name`, `systemPrompt`, `greeting`, `builtinTools`, `maxSteps`, `toolChoice`, `sttPrompt`, `idleTimeoutMs` → write `agent.json`
2. Each entry in `tools: {}` → `tools/<name>.ts` with `description`, `parameters` (Zod → JSON Schema), `export default execute`
3. Each lifecycle hook (`onConnect`, etc.) → `hooks/on-connect.ts` etc.
4. All `ctx.state.X` mutations → `await ctx.kv.get/set("X", ...)` calls
5. Delete `agent.ts`, remove `import { defineAgent, defineTool } from "@alexkroman1/aai"` and `import { z } from "zod"`
6. Update `agent.test.ts` to use `createTestHarness(dir)` instead of `createTestHarness(agent)`
7. Keep `client.tsx` files as-is (UI code unchanged)

- [ ] **Step 1: Rewrite simple templates** (simple, math-buddy, code-interpreter)

These have no custom tools — just `agent.json` with config.

**simple/agent.json:**
```json
{
  "name": "Simple Assistant"
}
```

**math-buddy/agent.json:**
```json
{
  "name": "Math Buddy",
  "systemPrompt": "You are Math Buddy...",
  "greeting": "Hey, I'm Math Buddy...",
  "builtinTools": ["run_code"]
}
```

Delete each `agent.ts`.

- [ ] **Step 2: Rewrite builtin-tool-only templates** (web-researcher, travel-concierge, health-assistant, personal-finance, support)

These use builtin tools only — `agent.json` with `builtinTools` array. Example:

**web-researcher/agent.json:**
```json
{
  "name": "Web Researcher",
  "systemPrompt": "You are a research assistant. Search the web to answer questions. Cite your sources.",
  "greeting": "Hi, I can help you research anything. What would you like to know?",
  "builtinTools": ["web_search", "visit_webpage"]
}
```

- [ ] **Step 3: Rewrite stateful templates** (pizza-ordering, dispatch-center, solo-rpg, memory-agent, smart-research)

These require converting `state()` → `ctx.kv` calls. Each tool becomes its own file.

**pizza-ordering/agent.json:**
```json
{
  "name": "Pizza Palace",
  "systemPrompt": "You are a pizza ordering assistant...",
  "greeting": "Welcome to Pizza Palace...",
  "maxSteps": 8
}
```

**pizza-ordering/tools/add_pizza.ts:**
```typescript
export const description = "Add a pizza to the customer's order";

export const parameters = {
  type: "object",
  properties: {
    size: { type: "string", enum: ["small", "medium", "large"], description: "Pizza size" },
    toppings: { type: "array", items: { type: "string" }, description: "List of toppings" }
  },
  required: ["size", "toppings"]
};

const PRICES = { small: 8, medium: 12, large: 16 };
const TOPPING_PRICE = 1.5;

export default async function execute(args, ctx) {
  const pizzas = (await ctx.kv.get("pizzas")) ?? [];
  const nextId = (await ctx.kv.get("nextId")) ?? 1;
  const price = PRICES[args.size] + args.toppings.length * TOPPING_PRICE;
  const pizza = { id: nextId, ...args, price };
  await ctx.kv.set("pizzas", [...pizzas, pizza]);
  await ctx.kv.set("nextId", nextId + 1);
  return { added: pizza, orderTotal: "$" + [...pizzas, pizza].reduce((s, p) => s + p.price, 0).toFixed(2) };
}
```

Repeat for `get_order.ts`, `remove_pizza.ts`, etc.

- [ ] **Step 4: Rewrite UI-heavy templates** (night-owl, infocom-adventure, embedded-assets)

Keep `client.tsx` as-is. Only rewrite the agent side (`agent.ts` → `agent.json` + `tools/`).

- [ ] **Step 5: Rewrite test-patterns template**

This exercises all features — converts to the most complete directory-format example.

- [ ] **Step 6: Rewrite scaffold**

Update `packages/aai-templates/scaffold/` to use directory format:
- Replace `agent.ts` with `agent.json`
- Remove `vite.config.ts` (no Vite plugin needed)
- Update `package.json` to remove `@alexkroman1/aai` dependency (agent code needs no SDK imports)
- Update `CLAUDE.md` with new agent API docs

```json
// packages/aai-templates/scaffold/package.json
{
  "name": "my-agent",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "aai dev",
    "build": "aai build",
    "test": "vitest run",
    "deploy": "aai deploy"
  },
  "dependencies": {
    "@alexkroman1/aai-ui": "latest"
  },
  "devDependencies": {
    "@alexkroman1/aai-cli": "latest",
    "vitest": "latest"
  }
}
```

- [ ] **Step 7: Update template tests to use new harness**

All `agent.test.ts` files use `createTestHarness(join(__dirname))` instead of `createTestHarness(agent)`.

- [ ] **Step 8: Run all template tests**

Run: `pnpm test:templates`
Expected: All pass

- [ ] **Step 9: Commit**

```bash
git add packages/aai-templates/
git commit -m "feat: rewrite all templates to directory agent format"
```

---

## Task 7: Rewrite Bundler

Replace the Vite SSR + `node:vm` bundler with the scanner + esbuild approach. Rewrite `_bundler.ts` in-place.

**Files:**
- Rewrite: `packages/aai-cli/_bundler.ts`
- Modify: `packages/aai-cli/cli.ts`

**Dependencies:** Task 2 (scanner), Task 3 (esbuild bundler)

- [ ] **Step 1: Replace `_bundler.ts` with new implementation**

Replace the entire file. The new bundler uses `scanAgentDir` + esbuild. Remove all Vite SSR, `node:vm`, `transformBundleForEval`, `extractAgentConfig` code.

Key exports to preserve (with new signatures):
- `bundleAgent(agentDir: string): Promise<BundleOutput>` — scan + compile
- `runBuildCommand(cwd: string): Promise<void>` — CLI entry point
- `BundleOutput` type — now contains `manifest`, `manifestJson`, `toolBundles`, `hookBundles`

- [ ] **Step 2: Update cli.ts build command**

The build command handler should call the new `runBuildCommand` directly (no format detection needed — old format is gone).

- [ ] **Step 3: Update deploy.ts**

Update to use new `BundleOutput` shape from the rewritten bundler.

- [ ] **Step 4: Run build on a rewritten template**

Run: `pnpm aai build` from a template directory.
Expected: `.aai/build/` with `manifest.json` + `tools/*.js`

- [ ] **Step 5: Commit**

```bash
git add packages/aai-cli/_bundler.ts packages/aai-cli/cli.ts packages/aai-cli/deploy.ts
git commit -m "feat: rewrite bundler to use scanner + esbuild (no Vite/node:vm)"
```

---

## Task 8: Rewrite Runtime Dispatcher

Replace `harness-runtime.ts` with file-per-tool RPC dispatcher. Rewrite in-place.

**Files:**
- Rewrite: `packages/aai-server/harness-runtime.ts`

**Dependencies:** Task 4 (dispatcher implementation)

- [ ] **Step 1: Replace harness-runtime.ts**

Replace the entire file with the `createDispatcher` + `startDispatcher` implementation from Task 4. Remove all `defineAgent`-based loading, `createSessionStateMap`, single-bundle evaluation.

- [ ] **Step 2: Update sandbox.ts to load individual handler files**

Update how the sandbox injects code into the isolate — load handler files individually instead of a single `worker.js` bundle.

- [ ] **Step 3: Commit**

```bash
git add packages/aai-server/harness-runtime.ts packages/aai-server/sandbox.ts
git commit -m "feat: rewrite isolate dispatcher for file-per-tool agents"
```

---

## Task 9: Rewrite Test Harness

Replace `testing.ts` with directory-based harness. Rewrite in-place.

**Files:**
- Rewrite: `packages/aai/host/testing.ts`
- Modify: `packages/aai/host/testing.test.ts`

**Dependencies:** Task 5 (test harness implementation)

- [ ] **Step 1: Replace testing.ts**

Replace `createTestHarness(AgentDef)` with `createTestHarness(agentDir: string)`. Remove dependency on `AgentDef`, `createRuntime`. Load tool/hook files directly from directory.

Keep `TurnResult` class and `executeTool`/`connect`/`disconnect`/`turn` API.

- [ ] **Step 2: Update existing tests**

- [ ] **Step 3: Commit**

```bash
git add packages/aai/host/testing.ts packages/aai/host/testing.test.ts
git commit -m "feat: rewrite test harness for directory-based agents"
```

---

## Task 10: Rewrite Dev Server

Replace Vite-based dev server with direct directory loading + file watching.

**Files:**
- Create: `packages/aai-cli/_dev-server.ts`
- Rewrite: `packages/aai-cli/dev.ts`
- Remove: `packages/aai/host/vite-plugin.ts`

**Dependencies:** Task 2 (scanner), Task 7 (bundler)

- [ ] **Step 1: Create _dev-server.ts**

New dev server that:
- Scans agent directory with `scanAgentDir`
- Dynamically imports tool/hook handlers
- Creates runtime with `manifestToAgentDef` bridge
- Watches for file changes and restarts
- Serves default UI

- [ ] **Step 2: Rewrite dev.ts**

Replace Vite dev server with new `_dev-server.ts`.

- [ ] **Step 3: Remove vite-plugin.ts**

Delete `packages/aai/host/vite-plugin.ts` and remove from package.json exports.

- [ ] **Step 4: Commit**

```bash
git add packages/aai-cli/_dev-server.ts packages/aai-cli/dev.ts
git rm packages/aai/host/vite-plugin.ts
git commit -m "feat: rewrite dev server for directory agents (remove Vite)"
```

---

## Task 11: Remove defineAgent/defineTool/Zod from SDK

Clean up the SDK to only export the new manifest types.

**Files:**
- Remove: `packages/aai/isolate/types.ts` (defineAgent, defineTool, defineToolFactory, Zod schemas)
- Modify: `packages/aai/index.ts` — export manifest types instead
- Modify: `packages/aai/isolate/index.ts` — remove types.ts re-export
- Modify: `packages/aai/package.json` — update exports, remove Zod if unused elsewhere

**Dependencies:** Tasks 6-10 (all templates and CLI rewritten)

- [ ] **Step 1: Update SDK exports**

Replace defineAgent/defineTool exports with manifest types in `packages/aai/index.ts`.

- [ ] **Step 2: Remove types.ts or strip it to non-defineAgent types**

Keep `Message`, `BuiltinTool`, and other types still used by the runtime. Remove `defineAgent`, `defineTool`, `defineToolFactory`, `AgentOptions`, `AgentDef`, Zod schemas.

- [ ] **Step 3: Run full check**

Run: `pnpm check:local`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/aai/
git commit -m "chore: remove defineAgent/defineTool/Zod from SDK exports"
```

---

## Task 12: Update Documentation

**Files:**
- Modify: `packages/aai-templates/scaffold/CLAUDE.md`
- Modify: `CLAUDE.md` (root)

**Dependencies:** Task 11 (SDK cleanup)

- [ ] **Step 1: Rewrite agent API docs**

Update `packages/aai-templates/scaffold/CLAUDE.md` to document:
- Directory structure conventions
- `agent.json` format (all fields, defaults)
- Tool file format (3 exports: description, parameters, default)
- Hook file format (4 available hooks)
- `ctx` object (env, kv, messages, sessionId)
- Testing with `createTestHarness`
- Build and deploy commands

- [ ] **Step 2: Update root CLAUDE.md**

Update architecture section to reflect directory-convention authoring, esbuild bundler, no Zod.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md packages/aai-templates/scaffold/CLAUDE.md
git commit -m "docs: update agent authoring docs for directory format"
```
