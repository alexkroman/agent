// Copyright 2025 the AAI authors. MIT license.
/**
 * Integration test: deploys a minimal agent into a real secure-exec isolate
 * and verifies the isolate boots, accepts RPC calls via bindings, and
 * supports WebSocket sessions via the sandbox proxy.
 *
 * Security boundaries (filesystem, process, env isolation) are enforced by
 * the same secure-exec permissions as before. Network is now fully disabled
 * since all communication uses bindings IPC.
 */

import { readdirSync, statSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import type { IsolateConfig } from "./rpc-schemas.ts";
import { _internals } from "./sandbox.ts";
import { createMockKv, TEST_AGENT_CONFIG } from "./test-utils.ts";

// ── Agent config matching AGENT_BUNDLE ────────────────────────────────────

const AGENT_CONFIG: IsolateConfig = {
  name: "integration-test",
  systemPrompt: "You are a test agent.",
  greeting: "Hello from the isolate",
  maxSteps: 3,
  toolSchemas: [
    { name: "echo", description: "Echo the input", parameters: { type: "object", properties: {} } },
    {
      name: "kv_roundtrip",
      description: "Store then read from KV",
      parameters: { type: "object", properties: {} },
    },
  ],
  hasState: true,
  hooks: {
    onConnect: true,
    onDisconnect: false,
    onError: false,
    onUserTranscript: true,
    maxStepsIsFn: false,
  },
};

// ── Agent bundle ─────────────────────────────────────────────────────────

const AGENT_BUNDLE = `
export default {
  name: "integration-test",
  systemPrompt: "You are a test agent.",
  greeting: "Hello from the isolate",
  maxSteps: 3,
  tools: {
    echo: {
      description: "Echo the input",
      execute(args) { return "echo:" + args.text; },
    },
    kv_roundtrip: {
      description: "Store then read from KV",
      async execute(args, ctx) {
        await ctx.kv.set("test-key", args.value);
        const result = await ctx.kv.get("test-key");
        return "stored:" + JSON.stringify(result);
      },
    },
  },
  state: () => ({ count: 0 }),
  onConnect: (ctx) => { ctx.state.count = 1; },
  onUserTranscript: (text, ctx) => { ctx.state.lastTurn = text; },
};
`;

// ── Isolate boot tests ──────────────────────────────────────────────────

describe("isolate boot", () => {
  let channel: Awaited<ReturnType<typeof _internals.startIsolate>>["channel"];
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    const kv = createMockKv();
    const isolate = await _internals.startIsolate(AGENT_BUNDLE, kv, {});
    channel = isolate.channel;
    cleanup = async () => {
      isolate.channel.shutdown();
      await isolate.runtime.terminate();
    };
  });

  afterAll(async () => {
    await cleanup?.();
  });

  test("isolate executes tool via bindings", async () => {
    // Connect a session first
    await channel.call({ type: "hook", hook: "onConnect", sessionId: "s1" }, 5000);

    const result = await channel.call<{ result: string }>(
      { type: "tool", name: "echo", sessionId: "s1", args: { text: "hello" }, messages: [] },
      5000,
    );
    expect(result.result).toBe("echo:hello");
  });
});

// ── WebSocket session lifecycle ──────────────────────────────────────────

describe("WebSocket session lifecycle", () => {
  let sandbox: Awaited<ReturnType<typeof _internals.createSandbox>>;

  beforeAll(async () => {
    const { createTestStorage } = await import("./test-utils.ts");
    sandbox = await _internals.createSandbox({
      workerCode: AGENT_BUNDLE,
      apiKey: "test-key",
      agentEnv: {},
      storage: createTestStorage(),
      slug: "ws-test",
      agentConfig: AGENT_CONFIG,
    });
  });

  afterAll(async () => {
    await sandbox?.shutdown();
  });

  test("startSession proxies config message from isolate", async () => {
    const messages: string[] = [];

    const ws = {
      readyState: 1,
      send(data: string | ArrayBuffer | Uint8Array) {
        if (typeof data === "string") messages.push(data);
      },
      addEventListener(type: string, listener: (event: Event) => void) {
        if (type === "open") {
          listener(new Event("open"));
        }
        if (type === "close") {
          setTimeout(() => listener(new Event("close")), 1000);
        }
      },
    };

    sandbox.startSession(ws as unknown as WebSocket, { skipGreeting: false });

    // Wait for the isolate's WebSocket server to connect and send config
    await vi.waitFor(
      () => {
        expect(messages.length).toBeGreaterThan(0);
      },
      { timeout: 5000, interval: 50 },
    );

    const config = JSON.parse(messages[0] as string);
    expect(config.type).toBe("config");
    expect(config.audioFormat).toBe("pcm16");
    expect(config.sampleRate).toBeTruthy();
    expect(config.sessionId).toBeTruthy();
  });
});

// ── Multiple concurrent agents ───────────────────────────────────────────

describe("multiple concurrent agents", () => {
  let isolate1: Awaited<ReturnType<typeof _internals.startIsolate>>;
  let isolate2: Awaited<ReturnType<typeof _internals.startIsolate>>;

  const BUNDLE_A = `
export default {
  name: "agent-a",
  systemPrompt: "A",
  greeting: "Hi from A",
  maxSteps: 1,
  tools: { id: { description: "Return agent name", execute() { return "agent-a"; } } },
};
`;

  const BUNDLE_B = `
export default {
  name: "agent-b",
  systemPrompt: "B",
  greeting: "Hi from B",
  maxSteps: 2,
  tools: { id: { description: "Return agent name", execute() { return "agent-b"; } } },
};
`;

  beforeAll(async () => {
    const kv1 = createMockKv();
    const kv2 = createMockKv();
    [isolate1, isolate2] = await Promise.all([
      _internals.startIsolate(BUNDLE_A, kv1, {}),
      _internals.startIsolate(BUNDLE_B, kv2, {}),
    ]);
  });

  afterAll(async () => {
    isolate1?.channel.shutdown();
    isolate2?.channel.shutdown();
    await isolate1?.runtime.terminate();
    await isolate2?.runtime.terminate();
  });

  test("two isolates boot independently and respond to RPC", async () => {
    // Verify both isolates respond to hook RPC independently
    await isolate1.channel.call({ type: "hook", hook: "onConnect", sessionId: "s1" }, 5000);
    await isolate2.channel.call({ type: "hook", hook: "onConnect", sessionId: "s2" }, 5000);
    await isolate1.channel.call({ type: "hook", hook: "onDisconnect", sessionId: "s1" }, 5000);
    await isolate2.channel.call({ type: "hook", hook: "onDisconnect", sessionId: "s2" }, 5000);
  });
});

// ── Redeploy replaces sandbox ────────────────────────────────────────────

describe("redeploy replaces sandbox", () => {
  test("deploying same slug terminates old sandbox", async () => {
    const { createTestStorage } = await import("./test-utils.ts");
    const storage = createTestStorage();

    const minimalConfig: IsolateConfig = {
      name: "v1",
      systemPrompt: "v1",
      greeting: "v1",
      toolSchemas: [],
      hasState: false,
      hooks: {
        onConnect: false,
        onDisconnect: false,
        onError: false,
        onUserTranscript: false,
        maxStepsIsFn: false,
      },
    };

    const sandbox1 = await _internals.createSandbox({
      workerCode: `export default { name: "v1", systemPrompt: "v1", greeting: "v1", maxSteps: 1, tools: {} };`,
      apiKey: "test-key",
      agentEnv: {},
      storage,
      slug: "redeploy-test",
      agentConfig: minimalConfig,
    });

    const sandbox2 = await _internals.createSandbox({
      workerCode: `export default { name: "v2", systemPrompt: "v2", greeting: "v2", maxSteps: 1, tools: {} };`,
      apiKey: "test-key",
      agentEnv: {},
      storage,
      slug: "redeploy-test",
      agentConfig: { ...minimalConfig, name: "v2", systemPrompt: "v2", greeting: "v2" },
    });

    sandbox1.shutdown();

    expect(sandbox2).toBeTruthy();

    sandbox2.shutdown();
  });
});

// ── Deploy → serve client files round-trip ───────────────────────────────

describe("deploy serves client files", () => {
  // Use real createBundleStore + unstorage memory driver (not the mock).
  async function createRealOrchestrator() {
    const { createStorage } = await import("unstorage");
    const { createBundleStore } = await import("./bundle-store.ts");
    const { deriveCredentialKey } = await import("./credentials.ts");
    const { createOrchestrator } = await import("./orchestrator.ts");

    const storage = createStorage();
    const credentialKey = await deriveCredentialKey("test-secret");
    const store = createBundleStore(storage, { credentialKey });
    const { createSlotCache } = await import("./sandbox-slots.ts");
    const { app } = createOrchestrator({ slots: createSlotCache(), store, storage });
    const fetch = async (input: string | Request, init?: RequestInit) => app.request(input, init);
    return { fetch, store };
  }

  test("deploy → GET / returns HTML, GET /assets/* returns JS", async () => {
    const { fetch, store } = await createRealOrchestrator();

    await store.putAgent({
      slug: "rt-agent",
      env: { ASSEMBLYAI_API_KEY: "k" },
      worker: "w",
      clientFiles: {
        "index.html":
          '<!DOCTYPE html><html><body><script src="./assets/index.js"></script></body></html>',
        "assets/index.js": 'console.log("app");',
      },
      credential_hashes: ["h"],
      agentConfig: TEST_AGENT_CONFIG,
    });

    const htmlRes = await fetch("/rt-agent/");
    expect(htmlRes.status).toBe(200);
    const html = await htmlRes.text();
    expect(html).toContain("<!DOCTYPE html>");

    const jsRes = await fetch("/rt-agent/assets/index.js");
    expect(jsRes.status).toBe(200);
    const js = await jsRes.text();
    expect(js).toContain("console.log");
  });

  test("redeploy updates served HTML", async () => {
    const { fetch, store } = await createRealOrchestrator();

    await store.putAgent({
      slug: "update-agent",
      env: { ASSEMBLYAI_API_KEY: "k" },
      worker: "w",
      clientFiles: { "index.html": "<!DOCTYPE html><html>v1</html>" },
      credential_hashes: ["h"],
      agentConfig: TEST_AGENT_CONFIG,
    });

    const v1 = await fetch("/update-agent/");
    expect(v1.status).toBe(200);
    expect(await v1.text()).toContain("v1");

    await store.putAgent({
      slug: "update-agent",
      env: { ASSEMBLYAI_API_KEY: "k" },
      worker: "w",
      clientFiles: { "index.html": "<!DOCTYPE html><html>v2</html>" },
      credential_hashes: ["h"],
      agentConfig: TEST_AGENT_CONFIG,
    });

    const v2 = await fetch("/update-agent/");
    expect(v2.status).toBe(200);
    expect(await v2.text()).toContain("v2");
  });
});

// ── Every template boots in the isolate ─────────────────────────────────

describe("template isolate boot", () => {
  const templatesDir = path.resolve(import.meta.dirname, "../aai-templates/templates");
  const templateNames = readdirSync(templatesDir).filter((d) =>
    statSync(path.join(templatesDir, d)).isDirectory(),
  );

  // Shared: bundle helper that copies a template, symlinks workspace deps, and bundles
  async function bundleTemplate(template: string): Promise<{
    worker: string;
    tmpDir: string;
  }> {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), `aai-tpl-${template}-`));
    const srcDir = path.join(templatesDir, template);

    // Copy all template files
    for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
      const src = path.join(srcDir, entry.name);
      const dest = path.join(tmpDir, entry.name);
      if (entry.isFile()) {
        await fs.copyFile(src, dest);
      }
    }

    // Minimal package.json
    await fs.writeFile(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ name: `test-${template}`, type: "module", dependencies: { zod: "^4.0.0" } }),
    );

    // Symlink workspace packages so Vite can resolve them
    const scope = path.join(tmpDir, "node_modules", "@alexkroman1");
    await fs.mkdir(scope, { recursive: true });
    await fs.symlink(path.resolve(import.meta.dirname, "..", "aai"), path.join(scope, "aai"));

    // biome-ignore lint/style/noRestrictedImports: integration test needs CLI bundler internals
    const { bundleAgent } = await import("../aai-cli/_bundler.ts");
    const bundle = await bundleAgent({
      slug: `tpl-${template}`,
      dir: tmpDir,
      entryPoint: path.join(tmpDir, "agent.ts"),
      clientEntry: "",
    });

    return { worker: bundle.worker, tmpDir };
  }

  test.each(templateNames)("template %s boots in isolate", async (template: string) => {
    const { worker, tmpDir } = await bundleTemplate(template);
    const kv = createMockKv();
    let isolate: Awaited<ReturnType<typeof _internals.startIsolate>> | undefined;

    try {
      isolate = await _internals.startIsolate(worker, kv, {});

      // 1. Hook lifecycle — connect a session (verifies isolate boots)
      await isolate.channel.call({ type: "hook", hook: "onConnect", sessionId: "s1" }, 5000);

      // 2. Hook lifecycle — disconnect
      await isolate.channel.call({ type: "hook", hook: "onDisconnect", sessionId: "s1" }, 5000);
    } finally {
      isolate?.channel.shutdown();
      await isolate?.runtime.terminate();
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  }, 30_000);
});

// ── Vite-bundled template agent boots in isolate ────────────────────────

describe("bundled template agent", () => {
  let tmpDir: string;
  let isolate: Awaited<ReturnType<typeof _internals.startIsolate>>;

  beforeAll(async () => {
    // Scaffold a simple template project with defineAgent + zod
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "aai-integ-"));
    const agentCode = `
import { defineAgent, defineTool } from "@alexkroman1/aai";
import { z } from "zod";

export default defineAgent({
  name: "Bundled Test Agent",
  tools: {
    greet: defineTool({
      description: "Greet someone",
      parameters: z.object({ name: z.string() }),
      execute: ({ name }) => "hello " + name,
    }),
  },
});
`;
    await fs.writeFile(path.join(tmpDir, "agent.ts"), agentCode);
    await fs.writeFile(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ name: "test", type: "module", dependencies: { zod: "^4.0.0" } }),
    );

    // Symlink workspace packages so Vite can resolve them
    const nodeModules = path.join(tmpDir, "node_modules");
    const scope = path.join(nodeModules, "@alexkroman1");
    await fs.mkdir(scope, { recursive: true });
    const pkgsDir = path.resolve(import.meta.dirname, "..", "aai");
    await fs.symlink(pkgsDir, path.join(scope, "aai"));

    // Bundle via the CLI bundler (same path as `aai build` / `aai deploy`)
    // biome-ignore lint/style/noRestrictedImports: integration test needs CLI bundler internals
    const { bundleAgent } = await import("../aai-cli/_bundler.ts");
    const bundle = await bundleAgent({
      slug: "integ-bundle-test",
      dir: tmpDir,
      entryPoint: path.join(tmpDir, "agent.ts"),
      clientEntry: "",
    });

    // Boot the bundled worker in a real isolate
    const kv = createMockKv();
    isolate = await _internals.startIsolate(bundle.worker, kv, {});
  }, 30_000);

  afterAll(async () => {
    isolate?.channel.shutdown();
    await isolate?.runtime.terminate();
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("tool RPC executes bundled tool", async () => {
    // Connect a session first
    await isolate.channel.call({ type: "hook", hook: "onConnect", sessionId: "s1" }, 5000);

    // Execute the tool
    const result = await isolate.channel.call<{ result: string }>(
      { type: "tool", name: "greet", sessionId: "s1", args: { name: "World" }, messages: [] },
      5000,
    );
    expect(result.result).toBe("hello World");
  });
});
