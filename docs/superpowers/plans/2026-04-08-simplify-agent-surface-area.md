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
| `packages/aai-cli/_bundler-v2.ts` | New esbuild-based bundler |
| `packages/aai-cli/_bundler-v2.test.ts` | Tests for new bundler |
| `packages/aai-server/harness-runtime-v2.ts` | New isolate dispatcher for file-per-tool |
| `packages/aai-server/harness-runtime-v2.test.ts` | Tests for new dispatcher |
| `packages/aai/host/testing-v2.ts` | Updated test harness for directory agents |
| `packages/aai/host/testing-v2.test.ts` | Tests for new test harness |
| `packages/aai-templates/templates/simple-v2/` | Proof-of-concept migrated template |

### Files to modify

| File | Change |
|------|--------|
| `packages/aai/isolate/index.ts` | Re-export manifest types |
| `packages/aai/package.json` | Add `./manifest` export |
| `packages/aai-cli/cli.ts` | Wire new bundler into build/deploy commands |
| `packages/aai-cli/dev.ts` | New dev server using directory scanner |
| `packages/aai-cli/deploy.ts` | Use new bundler output |
| `packages/aai-cli/init.ts` | Scaffold directory-format projects |
| `packages/aai/host/vite-plugin.ts` | Load from directory instead of single agent.ts |

### Files to eventually remove (after migration complete)

| File | Replaced by |
|------|-------------|
| `packages/aai-cli/_bundler.ts` | `_bundler-v2.ts` |
| `packages/aai-server/harness-runtime.ts` | `harness-runtime-v2.ts` |
| `packages/aai/host/testing.ts` | `testing-v2.ts` |

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

## Task 6: Proof-of-Concept Template (simple-v2)

Migrate the simplest template to validate the end-to-end authoring experience.

**Files:**
- Create: `packages/aai-templates/templates/simple-v2/agent.json`
- Create: `packages/aai-templates/templates/simple-v2/agent.test.ts`

**Dependencies:** Task 5 (test harness)

- [ ] **Step 1: Create the minimal directory agent**

```json
// packages/aai-templates/templates/simple-v2/agent.json
{
  "name": "Simple Assistant"
}
```

That's it. A deployable agent in one line of JSON.

- [ ] **Step 2: Write a test proving it works with the new harness**

```typescript
// packages/aai-templates/templates/simple-v2/agent.test.ts
import { describe, expect, test } from "vitest";
import { createDirTestHarness } from "@alexkroman1/aai/host/testing-v2";
import { join } from "node:path";

describe("simple-v2 agent", () => {
  test("loads without errors", async () => {
    const dir = join(__dirname);
    const harness = await createDirTestHarness(dir);
    // Minimal agent has no tools or hooks — just verify it loads
    expect(harness).toBeDefined();
  });
});
```

- [ ] **Step 3: Run the test**

Run: `pnpm vitest run packages/aai-templates/templates/simple-v2/agent.test.ts`
Expected: PASS

- [ ] **Step 4: Create a more realistic template with a tool**

```json
// packages/aai-templates/templates/web-researcher-v2/agent.json
{
  "name": "Web Researcher",
  "systemPrompt": "You are a research assistant. Search the web to answer questions. Cite your sources.",
  "greeting": "Hi, I can help you research anything. What would you like to know?",
  "builtinTools": ["web_search", "visit_webpage"]
}
```

- [ ] **Step 5: Create a stateful template with custom tools**

```json
// packages/aai-templates/templates/pizza-v2/agent.json
{
  "name": "Pizza Palace",
  "systemPrompt": "You are a pizza ordering assistant for Pizza Palace. Help customers build and manage their pizza orders. Be friendly and suggest popular combinations.",
  "greeting": "Welcome to Pizza Palace. What kind of pizza can I get started for you?",
  "maxSteps": 8
}
```

```typescript
// packages/aai-templates/templates/pizza-v2/tools/add_pizza.ts
export const description = "Add a pizza to the customer's order";

export const parameters = {
  type: "object",
  properties: {
    size: {
      type: "string",
      enum: ["small", "medium", "large"],
      description: "Pizza size",
    },
    toppings: {
      type: "array",
      items: { type: "string" },
      description: "List of toppings",
    },
  },
  required: ["size", "toppings"],
};

const PRICES = { small: 8, medium: 12, large: 16 };
const TOPPING_PRICE = 1.5;

export default async function execute(
  args: { size: "small" | "medium" | "large"; toppings: string[] },
  ctx: { kv: any },
) {
  const pizzas = (await ctx.kv.get("pizzas")) ?? [];
  const nextId = (await ctx.kv.get("nextId")) ?? 1;

  const price = PRICES[args.size] + args.toppings.length * TOPPING_PRICE;
  const pizza = { id: nextId, ...args, price };

  await ctx.kv.set("pizzas", [...pizzas, pizza]);
  await ctx.kv.set("nextId", nextId + 1);

  return { added: pizza, orderTotal: calculateTotal([...pizzas, pizza]) };
}

function calculateTotal(pizzas: { price: number }[]): string {
  return "$" + pizzas.reduce((sum, p) => sum + p.price, 0).toFixed(2);
}
```

```typescript
// packages/aai-templates/templates/pizza-v2/tools/get_order.ts
export const description = "Get the current pizza order with all items and total";

export default async function execute(
  _args: unknown,
  ctx: { kv: any },
) {
  const pizzas = (await ctx.kv.get("pizzas")) ?? [];
  const total = pizzas.reduce(
    (sum: number, p: { price: number }) => sum + p.price,
    0,
  );
  return { pizzas, total: "$" + total.toFixed(2) };
}
```

```typescript
// packages/aai-templates/templates/pizza-v2/tools/remove_pizza.ts
export const description = "Remove a pizza from the order by its ID";

export const parameters = {
  type: "object",
  properties: {
    id: { type: "number", description: "Pizza ID to remove" },
  },
  required: ["id"],
};

export default async function execute(
  args: { id: number },
  ctx: { kv: any },
) {
  const pizzas: { id: number; price: number }[] =
    (await ctx.kv.get("pizzas")) ?? [];
  const index = pizzas.findIndex((p) => p.id === args.id);
  if (index === -1) return { error: `No pizza with id ${args.id}` };
  const removed = pizzas.splice(index, 1)[0];
  await ctx.kv.set("pizzas", pizzas);
  return { removed, remaining: pizzas.length };
}
```

- [ ] **Step 6: Write test for pizza template**

```typescript
// packages/aai-templates/templates/pizza-v2/agent.test.ts
import { describe, expect, test } from "vitest";
import { createDirTestHarness } from "@alexkroman1/aai/host/testing-v2";
import { join } from "node:path";

describe("pizza-v2 agent", () => {
  test("add and retrieve pizza order", async () => {
    const harness = await createDirTestHarness(join(__dirname));

    await harness.executeTool("add_pizza", {
      size: "large",
      toppings: ["pepperoni", "mushrooms"],
    });

    const order = await harness.executeTool("get_order", {});
    expect(order).toEqual({
      pizzas: [
        {
          id: 1,
          size: "large",
          toppings: ["pepperoni", "mushrooms"],
          price: 19,
        },
      ],
      total: "$19.00",
    });
  });

  test("remove pizza from order", async () => {
    const harness = await createDirTestHarness(join(__dirname));

    await harness.executeTool("add_pizza", {
      size: "small",
      toppings: ["cheese"],
    });
    await harness.executeTool("add_pizza", {
      size: "medium",
      toppings: ["veggie"],
    });

    const result = await harness.executeTool("remove_pizza", { id: 1 });
    expect(result).toEqual({ removed: expect.objectContaining({ id: 1 }), remaining: 1 });
  });
});
```

- [ ] **Step 7: Run all template tests**

Run: `pnpm vitest run packages/aai-templates/templates/simple-v2/ packages/aai-templates/templates/pizza-v2/`
Expected: PASS (all tests)

- [ ] **Step 8: Commit**

```bash
git add packages/aai-templates/templates/simple-v2/ packages/aai-templates/templates/web-researcher-v2/ packages/aai-templates/templates/pizza-v2/
git commit -m "feat: add proof-of-concept templates in directory agent format"
```

---

## Task 7: Wire New Bundler into CLI Build Command

Connect `_bundler-v2.ts` to the `aai build` command, supporting both old and new formats during migration.

**Files:**
- Modify: `packages/aai-cli/_bundler-v2.ts` (add `runBuildCommandV2`)
- Modify: `packages/aai-cli/cli.ts` (detect format, route to v2 bundler)

**Dependencies:** Task 3 (bundler)

- [ ] **Step 1: Add format detection function**

Add to `packages/aai-cli/_bundler-v2.ts`:

```typescript
import { access } from "node:fs/promises";
import { join } from "node:path";

/**
 * Detect whether the agent directory uses the new directory format (agent.json)
 * or the legacy single-file format (agent.ts + defineAgent).
 */
export async function detectAgentFormat(
  cwd: string,
): Promise<"directory" | "legacy"> {
  try {
    await access(join(cwd, "agent.json"));
    return "directory";
  } catch {
    return "legacy";
  }
}

export async function runBuildCommandV2(cwd: string): Promise<void> {
  const { log } = await import("./_ui.ts");
  const output = await bundleAgentV2(cwd);
  // Write output files
  const { mkdir, writeFile } = await import("node:fs/promises");
  const buildDir = join(cwd, ".aai", "build");
  await mkdir(join(buildDir, "tools"), { recursive: true });
  await mkdir(join(buildDir, "hooks"), { recursive: true });

  await writeFile(join(buildDir, "manifest.json"), output.manifestJson);

  for (const [name, code] of Object.entries(output.toolBundles)) {
    await writeFile(join(buildDir, "tools", `${name}.js`), code);
  }
  for (const [name, code] of Object.entries(output.hookBundles)) {
    await writeFile(join(buildDir, "hooks", `${name}.js`), code);
  }

  log(`Build complete: ${output.manifest.name}`);
  log(`  ${Object.keys(output.toolBundles).length} tools, ${Object.keys(output.hookBundles).length} hooks`);
  log(`  Output: ${buildDir}`);
}
```

- [ ] **Step 2: Update CLI to detect and route**

In `packages/aai-cli/cli.ts`, update the build command handler to detect format:

```typescript
// In the build command handler (around line 129):
const { detectAgentFormat } = await import("./_bundler-v2.ts");
const format = await detectAgentFormat(cwd);
if (format === "directory") {
  const { runBuildCommandV2 } = await import("./_bundler-v2.ts");
  await runBuildCommandV2(cwd);
} else {
  const { runBuildCommand } = await import("./_bundler.ts");
  await runBuildCommand(cwd);
}
```

- [ ] **Step 3: Test manually with proof-of-concept template**

Run: `cd packages/aai-templates/templates/pizza-v2 && pnpm aai build`
Expected: Build output in `.aai/build/` with `manifest.json`, `tools/add_pizza.js`, `tools/get_order.js`, `tools/remove_pizza.js`

Verify: `cat .aai/build/manifest.json | jq .tools` shows tool schemas extracted correctly.

- [ ] **Step 4: Commit**

```bash
git add packages/aai-cli/_bundler-v2.ts packages/aai-cli/cli.ts
git commit -m "feat: wire v2 bundler into CLI build command with format detection"
```

---

## Task 8: Update CLI Init Command for Directory Format

Scaffold new projects in the directory format by default.

**Files:**
- Modify: `packages/aai-cli/init.ts`
- Modify: `packages/aai-cli/_init.ts`
- Modify: `packages/aai-cli/_templates.ts`

**Dependencies:** Task 6 (templates exist)

- [ ] **Step 1: Add v2 templates to template list**

In `packages/aai-templates/templates.json`, add entries for the new format templates:

```json
{
  "simple-v2": { "description": "Minimal voice assistant (directory format)" },
  "web-researcher-v2": { "description": "Web research assistant (directory format)" },
  "pizza-v2": { "description": "Pizza ordering with custom tools (directory format)" }
}
```

- [ ] **Step 2: Update scaffold for directory format**

The scaffold needs to produce a project without `vite.config.ts` importing `@alexkroman1/aai/vite-plugin`, without `agent.ts`, and with `agent.json` instead. Create a `scaffold-v2/` directory alongside the existing `scaffold/`:

```json
// packages/aai-templates/scaffold-v2/package.json
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

Note: No `@alexkroman1/aai` dependency needed for agent code. Only `aai-ui` for client and `aai-cli` for dev/build/deploy.

```json
// packages/aai-templates/scaffold-v2/tsconfig.json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["**/*.ts", "**/*.tsx"]
}
```

- [ ] **Step 3: Update init to detect and use v2 scaffold**

In `packages/aai-cli/_init.ts`, check whether the selected template is a v2 template (has `agent.json` instead of `agent.ts`) and use `scaffold-v2/` accordingly:

```typescript
// In runInit(), after downloading template:
const isV2 = await fileExists(join(targetDir, "agent.json"));
const scaffoldDir = isV2 ? "scaffold-v2" : "scaffold";
// Use the appropriate scaffold when merging files
```

- [ ] **Step 4: Test init with new template**

Run: `pnpm aai init --template pizza-v2 --yes --skip-api --skip-deploy`
Expected: Creates project with `agent.json`, `tools/add_pizza.ts`, `tools/get_order.ts`, `tools/remove_pizza.ts`, no `agent.ts`, no `vite.config.ts`

- [ ] **Step 5: Commit**

```bash
git add packages/aai-templates/ packages/aai-cli/_init.ts packages/aai-cli/init.ts
git commit -m "feat: update CLI init to scaffold directory-format agents"
```

---

## Task 9: Update Dev Server for Directory Format

The dev command needs to load and serve directory-format agents with file watching.

**Files:**
- Create: `packages/aai-cli/_dev-v2.ts`
- Modify: `packages/aai-cli/dev.ts`

**Dependencies:** Task 2 (scanner), Task 7 (format detection)

- [ ] **Step 1: Implement the v2 dev server**

```typescript
// packages/aai-cli/_dev-v2.ts
import { watch } from "node:fs";
import { join } from "node:path";
import { scanAgentDir } from "./_scanner.ts";
import { createRuntime, createServer } from "@alexkroman1/aai/server";
import type { Manifest } from "@alexkroman1/aai/isolate";

export async function runDevCommandV2(opts: {
  cwd: string;
  port: number;
}): Promise<void> {
  const { log, fmtUrl } = await import("./_ui.ts");
  const { cwd, port } = opts;

  let server: Awaited<ReturnType<typeof createServer>> | null = null;

  async function startServer() {
    const manifest = await scanAgentDir(cwd);

    // Dynamically import tool and hook handlers
    const tools = await loadToolHandlers(cwd);
    const hooks = await loadHookHandlers(cwd);

    // Create runtime with loaded handlers
    const runtime = createRuntime({
      agent: manifestToAgentDef(manifest, tools, hooks),
      env: await loadEnv(cwd),
    });

    server = await createServer({ runtime, name: manifest.name, port });
    log(`Agent "${manifest.name}" running at ${fmtUrl(`http://localhost:${port}`)}`);
  }

  await startServer();

  // Watch for changes and restart
  const watcher = watch(cwd, { recursive: true }, async (event, filename) => {
    if (!filename) return;
    if (filename.startsWith(".aai")) return;
    if (filename.startsWith("node_modules")) return;

    log(`Change detected: ${filename}. Restarting...`);
    if (server) await server.close();
    try {
      await startServer();
    } catch (err) {
      log(`Restart failed: ${err instanceof Error ? err.message : err}`);
    }
  });

  // Keep process alive
  process.on("SIGINT", () => {
    watcher.close();
    if (server) server.close();
    process.exit(0);
  });
}

// Helper: load tool handler modules from tools/ directory
async function loadToolHandlers(
  cwd: string,
): Promise<Record<string, { default: Function; description?: string; parameters?: Record<string, unknown> }>> {
  const { readdir } = await import("node:fs/promises");
  const { basename, extname } = await import("node:path");
  const { pathToFileURL } = await import("node:url");
  const toolsDir = join(cwd, "tools");
  const result: Record<string, any> = {};
  try {
    const files = await readdir(toolsDir);
    for (const file of files) {
      if (!file.endsWith(".ts") && !file.endsWith(".js")) continue;
      const toolName = basename(file, extname(file));
      result[toolName] = await import(pathToFileURL(join(toolsDir, file)).href);
    }
  } catch {
    // No tools/ directory
  }
  return result;
}

// Helper: load hook handler modules from hooks/ directory
async function loadHookHandlers(
  cwd: string,
): Promise<Record<string, { default: Function }>> {
  const { readdir } = await import("node:fs/promises");
  const { basename, extname } = await import("node:path");
  const { pathToFileURL } = await import("node:url");
  const hooksDir = join(cwd, "hooks");
  const hookFileMap: Record<string, string> = {
    "on-connect": "onConnect",
    "on-disconnect": "onDisconnect",
    "on-user-transcript": "onUserTranscript",
    "on-error": "onError",
  };
  const result: Record<string, any> = {};
  try {
    const files = await readdir(hooksDir);
    for (const file of files) {
      if (!file.endsWith(".ts") && !file.endsWith(".js")) continue;
      const hookFile = basename(file, extname(file));
      const hookKey = hookFileMap[hookFile];
      if (hookKey) {
        result[hookKey] = await import(pathToFileURL(join(hooksDir, file)).href);
      }
    }
  } catch {
    // No hooks/ directory
  }
  return result;
}

// Helper: convert Manifest + loaded handlers to AgentDef for createRuntime
// This bridges the new directory format with the existing runtime during migration.
// It constructs an object matching the AgentDef shape that createRuntime expects.
function manifestToAgentDef(
  manifest: Manifest,
  toolHandlers: Record<string, { default: Function; parameters?: Record<string, unknown> }>,
  hookHandlers: Record<string, { default: Function }>,
) {
  // Build tools record in the shape createRuntime expects:
  // { [name]: { description, parameters (as Zod-like .parse), execute } }
  const tools: Record<string, any> = {};
  for (const [name, schema] of Object.entries(manifest.tools)) {
    const handler = toolHandlers[name];
    if (!handler) continue;
    tools[name] = {
      description: schema.description,
      // Wrap JSON Schema params as a passthrough (no Zod validation in dev mode)
      parameters: schema.parameters
        ? { parse: (v: unknown) => v, _def: { typeName: "ZodObject" } }
        : undefined,
      execute: handler.default,
    };
  }

  return {
    name: manifest.name,
    systemPrompt: manifest.systemPrompt,
    greeting: manifest.greeting,
    sttPrompt: manifest.sttPrompt,
    maxSteps: manifest.maxSteps,
    toolChoice: manifest.toolChoice,
    builtinTools: manifest.builtinTools,
    idleTimeoutMs: manifest.idleTimeoutMs,
    tools,
    onConnect: hookHandlers.onConnect?.default,
    onDisconnect: hookHandlers.onDisconnect?.default,
    onUserTranscript: hookHandlers.onUserTranscript?.default,
    onError: hookHandlers.onError?.default,
  };
}

// Helper: load .env file
async function loadEnv(cwd: string): Promise<Record<string, string>> {
  try {
    const { parseEnvFile } = await import("@alexkroman1/aai/isolate");
    const { readFile } = await import("node:fs/promises");
    const envContent = await readFile(join(cwd, ".env"), "utf-8");
    return parseEnvFile(envContent);
  } catch {
    return {};
  }
}
```

- [ ] **Step 2: Update dev.ts to detect format**

```typescript
// packages/aai-cli/dev.ts
import { detectAgentFormat } from "./_bundler-v2.ts";

export async function runDevCommand(opts: {
  cwd: string;
  port: string;
}): Promise<void> {
  const format = await detectAgentFormat(opts.cwd);

  if (format === "directory") {
    const { runDevCommandV2 } = await import("./_dev-v2.ts");
    await runDevCommandV2({ cwd: opts.cwd, port: parseInt(opts.port, 10) || 3000 });
  } else {
    // Legacy: existing Vite dev server
    const { createServer: createViteServer } = await import("vite");
    // ... existing implementation
  }
}
```

- [ ] **Step 3: Test dev server with pizza template**

Run: `cd packages/aai-templates/templates/pizza-v2 && pnpm aai dev`
Expected: Server starts, serves default UI, WebSocket endpoint available

- [ ] **Step 4: Commit**

```bash
git add packages/aai-cli/_dev-v2.ts packages/aai-cli/dev.ts
git commit -m "feat: add dev server for directory-format agents with file watching"
```

---

## Task 10: Update Deploy for Directory Format

The deploy command needs to use the v2 bundler output.

**Files:**
- Modify: `packages/aai-cli/deploy.ts`
- Modify: `packages/aai-cli/_deploy.ts`

**Dependencies:** Task 3 (v2 bundler), Task 7 (format detection)

- [ ] **Step 1: Update deploy to use v2 bundler**

In `packages/aai-cli/deploy.ts`, detect format and branch:

```typescript
import { detectAgentFormat, bundleAgentV2 } from "./_bundler-v2.ts";

// In the deploy flow, after resolving CWD:
const format = await detectAgentFormat(cwd);

if (format === "directory") {
  const v2Output = await bundleAgentV2(cwd);
  // Convert v2 output to the format expected by runDeploy():
  // - manifest.json serves as agentConfig
  // - tool bundles + hook bundles become the worker payload
  // - client files handled separately if client.tsx exists
  await runDeploy({
    slug,
    manifest: v2Output.manifest,
    toolBundles: v2Output.toolBundles,
    hookBundles: v2Output.hookBundles,
    clientFiles: v2Output.clientDir ? await gatherClientFiles(v2Output.clientDir) : [],
  });
} else {
  // Legacy: existing buildAgentBundle + runDeploy
  const { buildAgentBundle } = await import("./_bundler.ts");
  const output = await buildAgentBundle(cwd);
  await runDeploy(/* existing args */);
}
```

- [ ] **Step 2: Update server deploy handler to accept v2 bundle format**

The server (`packages/aai-server/deploy.ts`) needs to handle the new bundle format. Instead of a single `worker.js` + extracted config, it receives `manifest.json` + individual handler files.

This is a server-side change that requires updating:
- `packages/aai-server/deploy.ts` — accept new payload shape
- `packages/aai-server/bundle-store.ts` — store manifest + handler files
- `packages/aai-server/sandbox.ts` — load handler files into isolate

**Note:** The exact server-side changes depend on how the platform handles the new bundle format. This task defines the CLI-side contract; server-side is a separate task that may involve the platform team.

- [ ] **Step 3: Commit**

```bash
git add packages/aai-cli/deploy.ts packages/aai-cli/_deploy.ts
git commit -m "feat: update deploy to support directory-format agent bundles"
```

---

## Task 11: Migrate Remaining Templates

Convert all 18 existing templates from `defineAgent` to directory format.

**Files:**
- Modify: All directories under `packages/aai-templates/templates/`

**Dependencies:** Tasks 1-6 (core infrastructure + proof of concept)

This task is mechanical and can be parallelized across templates. Each template migration follows the same steps from the spec's migration section:

1. Extract config fields → `agent.json`
2. Each tool → `tools/<name>.ts` with `description`, `parameters` (Zod → JSON Schema), `export default execute`
3. Each hook → `hooks/<name>.ts`
4. `state` mutations → `ctx.kv.get/set` calls
5. Delete `import { ... } from "@alexkroman1/aai"` and `import { z } from "zod"`
6. Update tests to use `createDirTestHarness`

- [ ] **Step 1: Migrate simple templates first** (simple, math-buddy, code-interpreter)

These have no custom tools — just `agent.json` with config.

- [ ] **Step 2: Migrate tool-using templates** (web-researcher, travel-concierge, health-assistant, personal-finance, support)

These use built-in tools only — `agent.json` with `builtinTools` array.

- [ ] **Step 3: Migrate stateful templates** (pizza-ordering, dispatch-center, solo-rpg, memory-agent, smart-research)

These require converting `state()` → `ctx.kv` calls in every tool.

- [ ] **Step 4: Migrate UI-heavy templates** (night-owl, infocom-adventure, embedded-assets)

These have `client.tsx` — keep client code as-is, just migrate agent side.

- [ ] **Step 5: Migrate test-patterns template**

This template exercises all features — good integration test for the new format.

- [ ] **Step 6: Update template tests**

All `agent.test.ts` files updated to use `createDirTestHarness` instead of `createTestHarness`.

- [ ] **Step 7: Run all template tests**

Run: `pnpm test:templates`
Expected: All pass

- [ ] **Step 8: Commit**

```bash
git add packages/aai-templates/
git commit -m "feat: migrate all templates to directory agent format"
```

---

## Task 12: Remove Legacy Code

After all templates are migrated and tests pass, remove the old code paths.

**Files:**
- Remove: `packages/aai/isolate/types.ts` — `defineAgent`, `defineTool`, `defineToolFactory`, Zod schemas
- Remove: `packages/aai-cli/_bundler.ts` — old Vite SSR + node:vm bundler
- Remove: `packages/aai-server/harness-runtime.ts` — old single-bundle dispatcher
- Remove: `packages/aai/host/testing.ts` — old test harness
- Modify: `packages/aai/index.ts` — remove defineAgent/defineTool exports
- Modify: `packages/aai/package.json` — update exports map

**Dependencies:** All previous tasks complete, all tests passing

- [ ] **Step 1: Remove old bundler**

Delete `packages/aai-cli/_bundler.ts`. Update any remaining imports in `cli.ts`, `deploy.ts` to use `_bundler-v2.ts` exclusively. Rename `_bundler-v2.ts` → `_bundler.ts`.

- [ ] **Step 2: Remove old harness runtime**

Delete `packages/aai-server/harness-runtime.ts`. Rename `harness-runtime-v2.ts` → `harness-runtime.ts`.

- [ ] **Step 3: Remove old test harness**

Delete `packages/aai/host/testing.ts`. Rename `testing-v2.ts` → `testing.ts`. Update `@alexkroman1/aai/testing` export in `package.json`.

- [ ] **Step 4: Remove defineAgent/defineTool/Zod from SDK exports**

Update `packages/aai/index.ts` to export manifest types instead of defineAgent. Remove Zod dependency from `packages/aai/package.json` if no other code uses it.

- [ ] **Step 5: Remove old templates**

Delete the original template directories (simple, pizza-ordering, etc.). Rename v2 templates to drop the `-v2` suffix.

- [ ] **Step 6: Run full check**

Run: `pnpm check:local`
Expected: PASS — build, typecheck, lint, tests all green

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore: remove legacy defineAgent/Vite/Zod agent authoring code"
```

---

## Task 13: Update Documentation

**Files:**
- Modify: `packages/aai-templates/scaffold-v2/CLAUDE.md` (new agent API docs)
- Modify: `CLAUDE.md` (root — update architecture section)

**Dependencies:** Task 12 (legacy removal)

- [ ] **Step 1: Write new agent API docs**

Update `packages/aai-templates/scaffold-v2/CLAUDE.md` to document:
- Directory structure conventions
- `agent.json` format (all fields, defaults)
- Tool file format (3 exports: description, parameters, default)
- Hook file format (4 available hooks)
- `ctx` object (env, kv, messages, sessionId)
- Testing with `createDirTestHarness`
- Build and deploy commands

- [ ] **Step 2: Update root CLAUDE.md**

Update architecture section to reflect:
- No more `defineAgent`/`defineTool`/Zod
- Directory-convention authoring format
- esbuild-based bundler
- Simplified build pipeline

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md packages/aai-templates/scaffold-v2/CLAUDE.md
git commit -m "docs: update agent authoring docs for directory format"
```
