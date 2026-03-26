// Copyright 2025 the AAI authors. MIT license.
/**
 * End-to-end test: builds CLI, then for every template:
 *   init -> dev --check (builds, starts server, hits /health, exits)
 *
 * Run via: pnpm test:e2e
 */
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

let playwrightAvailable = false;
let chromium: typeof import("playwright").chromium | undefined;
type Browser = import("playwright").Browser;

try {
  ({ chromium } = await import("playwright"));
  // Verify the browser binary is actually installed
  const b = await chromium.launch();
  await b.close();
  playwrightAvailable = true;
} catch {
  // Playwright or Chromium not installed — browser tests will be skipped
}

const dir = import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname);
const templatesDir = path.join(dir, "templates");

const templates = fs
  .readdirSync(templatesDir, { withFileTypes: true })
  .filter((d) => d.isDirectory() && d.name !== "_shared")
  .map((d) => d.name);

let aaiBin: string;
let tmpDir: string;
const BASE_PORT = 4567;

function aaiEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    VITEST: undefined, // CLI skips main() when VITEST=true
    INIT_CWD: undefined, // resolveCwd() prefers INIT_CWD over process.cwd()
    NO_COLOR: "1",
    FORCE_COLOR: "0",
    ASSEMBLYAI_API_KEY: process.env.ASSEMBLYAI_API_KEY || "test",
    npm_config_ignore_scripts: "true", // avoid postinstall hooks in linked pkgs
  };
}

function aai(args: string[], cwd: string, timeoutMs = 120_000): void {
  execFileSync(process.execPath, [aaiBin, ...args], {
    cwd,
    env: aaiEnv(),
    stdio: "inherit",
    timeout: timeoutMs,
  });
}

function aaiSpawn(args: string[], cwd: string): ChildProcess {
  return spawn(process.execPath, [aaiBin, ...args], {
    cwd,
    env: aaiEnv(),
    stdio: "pipe",
  });
}

async function waitForHealth(url: string, timeoutMs = 30_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // server not ready yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

/** Scaffold a project and install deps. Init links workspace packages in dev mode. */
function initProject(template: string, projectDir: string): void {
  aai(["init", projectDir, "-t", template, "--skip-api", "--skip-deploy"], tmpDir);
}

beforeAll(() => {
  execFileSync("npx", ["tsdown"], { cwd: dir, stdio: "inherit" });
  // tsdown outputs .mjs for ESM format
  const mjs = path.resolve(dir, "dist/cli.mjs");
  const js = path.resolve(dir, "dist/cli.js");
  aaiBin = fs.existsSync(mjs) ? mjs : js;
  tmpDir = fs.mkdtempSync("/tmp/aai-e2e-test-");
});

afterAll(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("e2e: init -> test -> dev --check", () => {
  test.each(templates.map((t, i) => [t, i] as const))("template %s", (template, i) => {
    const projectDir = path.join(tmpDir, template);
    initProject(template, projectDir);
    aai(["test"], projectDir);
    aai(["dev", "--check", "--port", String(BASE_PORT + i)], projectDir);
  });
});

describe("e2e: build produces output files", () => {
  test("init -> build writes .aai/build and .aai/client", () => {
    const projectDir = path.join(tmpDir, "_build-test");
    initProject("simple", projectDir);
    aai(["build"], projectDir);

    expect(fs.existsSync(path.join(projectDir, ".aai", "build", "worker.js"))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, ".aai", "client", "index.html"))).toBe(true);
  });
});

describe("e2e: build -> start serves health", () => {
  test("start responds to /health after build", async () => {
    const projectDir = path.join(tmpDir, "_start-test");
    const port = BASE_PORT + 100;
    initProject("simple", projectDir);
    aai(["build"], projectDir);

    const child = aaiSpawn(["start", "--port", String(port)], projectDir);
    try {
      await waitForHealth(`http://localhost:${port}/health`);
      const res = await fetch(`http://localhost:${port}/health`);
      expect(res.ok).toBe(true);
      const body = (await res.json()) as { status: string };
      expect(body.status).toBe("ok");
    } finally {
      child.kill();
    }
  });
});

describe("e2e: deploy --dry-run", () => {
  test("init -> deploy --dry-run succeeds without a server", () => {
    const projectDir = path.join(tmpDir, "_deploy-dry-test");
    initProject("simple", projectDir);
    aai(["deploy", "--dry-run"], projectDir);
  });
});

describe("e2e: unlink reverses link", () => {
  test("init links file: deps, unlink restores them", () => {
    const projectDir = path.join(tmpDir, "_unlink-test");
    initProject("simple", projectDir);

    // After init (dev mode), deps should have file: paths
    const linkedPkg = JSON.parse(fs.readFileSync(path.join(projectDir, "package.json"), "utf-8"));
    const linkedDeps: Record<string, string> = linkedPkg.dependencies ?? {};
    expect(Object.values(linkedDeps).some((v) => v.startsWith("file:"))).toBe(true);

    aai(["unlink"], projectDir);

    // After unlink, no file: paths should remain
    const unlinkedPkg = JSON.parse(fs.readFileSync(path.join(projectDir, "package.json"), "utf-8"));
    const unlinkedDeps: Record<string, string> = unlinkedPkg.dependencies ?? {};
    expect(Object.values(unlinkedDeps).some((v) => v.startsWith("file:"))).toBe(false);
  });
});

/** Shared browser tests: UI renders, Start click opens WebSocket. */
function defineBrowserTests(getContext: () => { browser: Browser; port: number }): void {
  test("page renders with Start button", async () => {
    const { browser, port } = getContext();
    const page = await browser.newPage();
    await page.goto(`http://localhost:${port}`);
    const startBtn = page.getByRole("button", { name: "Start" });
    expect(await startBtn.isVisible()).toBe(true);
    await page.close();
  });

  test("clicking Start opens a WebSocket and receives config", async () => {
    const { browser, port } = getContext();
    const page = await browser.newPage();
    await page.goto(`http://localhost:${port}`);

    // Collect frames via page-level WS listener before clicking Start
    const frames: string[] = [];
    const wsConnected = new Promise<string>((resolve) => {
      page.on("websocket", (ws) => {
        resolve(ws.url());
        ws.on("framereceived", (frame) => {
          if (typeof frame.payload === "string") frames.push(frame.payload);
        });
      });
    });

    await page.getByRole("button", { name: "Start" }).click();
    const wsUrl = await wsConnected;
    expect(wsUrl).toContain("/websocket");

    // Poll for config frame arrival instead of fixed timeout
    const hasConfig = () =>
      frames.some((f) => {
        try {
          return JSON.parse(f).type === "config";
        } catch {
          return false;
        }
      });
    const deadline = Date.now() + 10_000;
    while (!hasConfig() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    expect(hasConfig()).toBe(true);

    await page.close();
  });

  test("full conversation flow: start → agent speaks → user speaks → tool call → agent responds → stop", async () => {
    const { browser, port } = getContext();
    const page = await browser.newPage();

    // Intercept WebSocket construction to capture the instance for message injection.
    // Use addInitScript so the patch runs before any page JS.
    await page.addInitScript(() => {
      const OrigWS = globalThis.WebSocket;
      // @ts-expect-error -- overriding native class for test
      globalThis.WebSocket = class extends OrigWS {
        constructor(url: string | URL, protocols?: string | string[]) {
          super(url, protocols);
          (globalThis as Record<string, unknown>).__aai_test_ws = this;
        }
      };
    });

    await page.goto(`http://localhost:${port}`);

    // Track frames via Playwright's WS listener
    const clientFrames: string[] = [];
    const wsConnected = new Promise<void>((resolve) => {
      page.on("websocket", (ws) => {
        ws.on("framesent", (frame) => {
          if (typeof frame.payload === "string") clientFrames.push(frame.payload);
        });
        resolve();
      });
    });

    // Click Start to open the session
    await page.getByRole("button", { name: "Start" }).click();
    await wsConnected;

    // Wait for the WS reference to be captured (patched send fires on first client message)
    const wsReady = async () => {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const ready = await page.evaluate(() =>
          Boolean((globalThis as Record<string, unknown>).__aai_test_ws),
        );
        if (ready) return;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error("Timed out waiting for WebSocket reference");
    };
    await wsReady();

    // Helper: inject a server message into the browser's WebSocket
    const inject = (msg: Record<string, unknown>) =>
      page.evaluate((json) => {
        const ws = (globalThis as Record<string, unknown>).__aai_test_ws as WebSocket;
        ws.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(json) }));
      }, msg);

    // Step 1: Simulate agent greeting
    await inject({ type: "turn", text: "Hello", turnOrder: 1 });
    await inject({ type: "chat_delta", text: "Hi there!" });
    await inject({ type: "chat", text: "Hi there! How can I help you?" });
    await inject({ type: "tts_done" });
    await page.getByText("Hi there! How can I help you?").waitFor();

    // Step 2: Simulate user speaking
    await inject({ type: "speech_started" });
    await inject({ type: "transcript", text: "What's the weather?", isFinal: false });
    await inject({ type: "transcript", text: "What's the weather today?", isFinal: true });
    await inject({ type: "turn", text: "What's the weather today?", turnOrder: 2 });
    await page.getByText("What's the weather today?").waitFor();

    // Step 3: Simulate tool call
    await inject({
      type: "tool_call_start",
      toolCallId: "tc_001",
      toolName: "web_search",
      args: { query: "weather today" },
    });
    await page.getByRole("button", { name: /Web Search/i }).waitFor();

    await inject({
      type: "tool_call_done",
      toolCallId: "tc_001",
      result: "Sunny, 72°F",
    });

    // Step 4: Agent responds after tool call
    await inject({ type: "chat_delta", text: "The weather today is sunny" });
    await inject({ type: "chat", text: "The weather today is sunny and 72°F!" });
    await inject({ type: "tts_done" });
    await page.getByText("The weather today is sunny and 72°F!").waitFor();

    // Step 5: Verify session controls are visible.
    // In headless mode, audio init fails so the button shows "Resume" (not "Stop").
    // Either way, clicking it toggles the running state.
    const toggleBtn = page.getByRole("button", { name: /Stop|Resume/ });
    await toggleBtn.waitFor({ timeout: 5000 });
    const wasRunning = (await toggleBtn.textContent())?.trim() === "Stop";
    await toggleBtn.click();

    // After clicking, the button text flips
    const expectedAfter = wasRunning ? "Resume" : "Stop";
    await page.getByRole("button", { name: expectedAfter }).waitFor({ timeout: 3000 });

    // Full conversation still visible after toggle
    expect(await page.getByText("Hi there! How can I help you?").isVisible()).toBe(true);
    expect(await page.getByText("What's the weather today?").isVisible()).toBe(true);
    expect(await page.getByText("The weather today is sunny and 72°F!").isVisible()).toBe(true);

    await page.close();
  });
}

describe.skipIf(!playwrightAvailable)("e2e: browser on build -> start", () => {
  let browser: Browser;
  let child: ChildProcess;
  const port = BASE_PORT + 200;

  beforeAll(async () => {
    const projectDir = path.join(tmpDir, "_browser-start");
    initProject("simple", projectDir);
    aai(["build"], projectDir);
    child = aaiSpawn(["start", "--port", String(port)], projectDir);
    await waitForHealth(`http://localhost:${port}/health`);
    // biome-ignore lint/style/noNonNullAssertion: guarded by describe.skipIf(!playwrightAvailable)
    browser = await chromium!.launch();
  });

  afterAll(async () => {
    await browser?.close();
    child?.kill();
  });

  defineBrowserTests(() => ({ browser, port }));
});

describe.skipIf(!playwrightAvailable)("e2e: browser on dev server", () => {
  let browser: Browser;
  let child: ChildProcess;
  const port = BASE_PORT + 201;

  beforeAll(async () => {
    const projectDir = path.join(tmpDir, "_browser-dev");
    initProject("simple", projectDir);
    child = aaiSpawn(["dev", "--port", String(port)], projectDir);
    await waitForHealth(`http://localhost:${port}/health`);
    // biome-ignore lint/style/noNonNullAssertion: guarded by describe.skipIf(!playwrightAvailable)
    browser = await chromium!.launch();
  });

  afterAll(async () => {
    await browser?.close();
    child?.kill();
  });

  defineBrowserTests(() => ({ browser, port }));
});
