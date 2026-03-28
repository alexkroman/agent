// Copyright 2025 the AAI authors. MIT license.
/**
 * End-to-end CLI tests (Vite builds, real servers, Playwright browser):
 *   1. Template builds: dev & user workflows for every template
 *   2. CLI commands: dev --check, start, deploy --dry-run
 *   3. Browser tests (Playwright): UI render, WebSocket, conversation flow
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
  const b = await chromium.launch();
  await b.close();
  playwrightAvailable = true;
} catch {
  // Playwright or Chromium not installed — browser tests will be skipped
}

const dir = import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname);
const packagesDir = path.resolve(dir, "..");
const templatesDir = path.resolve(dir, "../aai-templates");

const templates = fs
  .readdirSync(templatesDir, { withFileTypes: true })
  .filter((d) => d.isDirectory() && !d.name.startsWith("_") && d.name !== "node_modules")
  .map((d) => d.name);

let aaiBin: string;
let tmpDir: string;
let tarballs: Record<string, string>;
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

function initProject(template: string, projectDir: string): void {
  aai(["init", projectDir, "-t", template, "--skip-api", "--skip-deploy"], tmpDir);
}

function installFromTarballs(projectDir: string): void {
  const pkgJsonPath = path.join(projectDir, "package.json");
  const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"));
  const deps = pkgJson.dependencies ?? {};
  for (const [name, tarball] of Object.entries(tarballs)) {
    if (deps[name]) deps[name] = `file:${tarball}`;
  }
  fs.writeFileSync(pkgJsonPath, `${JSON.stringify(pkgJson, null, 2)}\n`);
  execFileSync("npm", ["install"], { cwd: projectDir, stdio: "inherit" });
}

beforeAll(() => {
  // Build CLI
  execFileSync("npx", ["tsdown"], { cwd: dir, stdio: "inherit" });
  const mjs = path.resolve(dir, "dist/cli.mjs");
  const js = path.resolve(dir, "dist/cli.js");
  aaiBin = fs.existsSync(mjs) ? mjs : js;
  tmpDir = fs.mkdtempSync("/tmp/aai-e2e-test-");

  // Pack SDK packages into tarballs
  const tarballDir = path.join(tmpDir, "_tarballs");
  fs.mkdirSync(tarballDir);
  tarballs = {};
  for (const pkgDir of ["aai", "aai-ui"]) {
    const pkgPath = path.join(packagesDir, pkgDir);
    execFileSync("pnpm", ["run", "build"], { cwd: pkgPath, stdio: "inherit" });
    const output = execFileSync("pnpm", ["pack", "--pack-destination", tarballDir], {
      cwd: pkgPath,
      encoding: "utf-8",
    }).trim();
    // pnpm pack returns the full absolute path; npm pack returns just the filename
    const tarballPath = output.split("\n").pop() ?? "";
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgPath, "package.json"), "utf-8"));
    tarballs[pkg.name] = path.isAbsolute(tarballPath)
      ? tarballPath
      : path.join(tarballDir, tarballPath);
  }
});

afterAll(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

// --- Pack + build: all templates ---

describe("pack + build: dev and user workflows", () => {
  test.each(templates)("template %s", (template) => {
    const projectDir = path.join(tmpDir, template);

    // Dev workflow: init -> link -> test -> build
    aai(["init", projectDir, "-t", template, "--skip-api", "--skip-deploy"], tmpDir);
    aai(["link"], projectDir);
    aai(["test"], projectDir);
    aai(["build", "--skip-tests"], projectDir);

    // User workflow: unlink -> install tarballs -> test -> build
    aai(["unlink"], projectDir);
    installFromTarballs(projectDir);
    aai(["test"], projectDir);
    aai(["build", "--skip-tests"], projectDir);
  });
});

// --- CLI commands (single template) ---

describe("CLI: dev --check", () => {
  test("init -> dev --check", () => {
    const projectDir = path.join(tmpDir, "_dev-check");
    initProject("simple", projectDir);
    aai(["dev", "--check", "--port", String(BASE_PORT)], projectDir);
  });
});

describe("CLI: build -> start serves health", () => {
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

describe("CLI: deploy --dry-run", () => {
  test("init -> deploy --dry-run succeeds without a server", () => {
    const projectDir = path.join(tmpDir, "_deploy-dry-test");
    initProject("simple", projectDir);
    aai(["deploy", "--dry-run"], projectDir);
  });
});

// --- Browser tests (Playwright) ---

/** Set up a page with a WebSocket capture hook and event injector. */
async function setupEventInjector(browser: Browser, port: number) {
  const page = await browser.newPage();

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

  const clientFrames: string[] = [];
  const wsConnected = new Promise<void>((resolve) => {
    page.on("websocket", (ws) => {
      ws.on("framesent", (frame) => {
        if (typeof frame.payload === "string") clientFrames.push(frame.payload);
      });
      resolve();
    });
  });

  await page.getByRole("button", { name: "Start" }).click();
  await wsConnected;

  // Wait for the WebSocket reference to be available
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const ready = await page.evaluate(() =>
      Boolean((globalThis as Record<string, unknown>).__aai_test_ws),
    );
    if (ready) break;
    await new Promise((r) => setTimeout(r, 50));
  }

  /** Inject a server→client event via the captured WebSocket. */
  const inject = (msg: Record<string, unknown>) =>
    page.evaluate((json) => {
      const ws = (globalThis as Record<string, unknown>).__aai_test_ws as WebSocket;
      ws.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(json) }));
    }, msg);

  /** Replay a fixture file (from aai-ui/__fixtures__/). */
  const replayFixture = async (fixtureName: string) => {
    const fixturePath = path.resolve(dir, "../aai-ui/__fixtures__", fixtureName);
    const messages = JSON.parse(fs.readFileSync(fixturePath, "utf-8")) as Record<string, unknown>[];
    for (const msg of messages) {
      await inject(msg);
    }
  };

  return { page, inject, replayFixture, clientFrames };
}

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

    const hasConfig = () =>
      frames.some((f) => {
        try {
          return JSON.parse(f).type === "config";
        } catch {
          return false;
        }
      });
    const dl = Date.now() + 10_000;
    while (!hasConfig() && Date.now() < dl) await new Promise((r) => setTimeout(r, 50));
    expect(hasConfig()).toBe(true);

    await page.close();
  });

  // ── Fixture-driven event injection tests ───────────────────────────────

  test("greeting session: agent message renders in browser", async () => {
    const { browser, port } = getContext();
    const { page, replayFixture } = await setupEventInjector(browser, port);

    await replayFixture("greeting-session.json");
    await page.getByText("Hello! How can I help you today?").waitFor();
    expect(await page.getByText("Hello! How can I help you today?").isVisible()).toBe(true);

    await page.close();
  });

  test("simple conversation: user + assistant messages render", async () => {
    const { browser, port } = getContext();
    const { page, replayFixture } = await setupEventInjector(browser, port);

    await replayFixture("simple-conversation.json");
    await page.getByText("Tell me a fun fact about space.").waitFor();
    await page.getByText("A day on Venus is longer than its year.").waitFor();

    expect(await page.getByText("Hi there!").isVisible()).toBe(true);
    expect(await page.getByText("Tell me a fun fact about space.").isVisible()).toBe(true);
    expect(await page.getByText("A day on Venus is longer than its year.").isVisible()).toBe(true);

    await page.close();
  });

  test("tool call flow: tool block renders with name, messages appear", async () => {
    const { browser, port } = getContext();
    const { page, replayFixture } = await setupEventInjector(browser, port);

    await replayFixture("tool-call-flow.json");
    await page.getByText("The weather in San Francisco is sunny at 72°F.").waitFor();

    // Tool call block should be visible with tool name
    expect(await page.getByText("get_weather").isVisible()).toBe(true);
    // Messages present
    expect(await page.getByText("What is the weather like in San Francisco?").isVisible()).toBe(
      true,
    );
    expect(await page.getByText("The weather in San Francisco is sunny at 72°F.").isVisible()).toBe(
      true,
    );

    await page.close();
  });

  test("error recovery: error banner renders with message", async () => {
    const { browser, port } = getContext();
    const { page, replayFixture } = await setupEventInjector(browser, port);

    await replayFixture("error-recovery.json");
    await page.getByText("Speech recognition failed").waitFor();

    expect(await page.getByText("Speech recognition failed").isVisible()).toBe(true);
    // Resume button should appear
    expect(await page.getByRole("button", { name: "Resume" }).isVisible()).toBe(true);

    await page.close();
  });

  test("barge-in: interrupted response cleared, new answer renders", async () => {
    const { browser, port } = getContext();
    const { page, replayFixture } = await setupEventInjector(browser, port);

    await replayFixture("barge-in.json");
    await page.getByText("No problem!").waitFor();

    // Final answer visible
    expect(await page.getByText("No problem!").isVisible()).toBe(true);
    // Both user turns visible
    expect(await page.getByText("What about").isVisible()).toBe(true);
    expect(await page.getByText("Actually never mind").isVisible()).toBe(true);

    await page.close();
  });

  test("multi-turn with tools: two tool calls and all messages render", async () => {
    const { browser, port } = getContext();
    const { page, replayFixture } = await setupEventInjector(browser, port);

    await replayFixture("multi-turn-with-tools.json");
    await page.getByText("London is 55°F and rainy.").waitFor();

    // Both user questions
    expect(await page.getByText("Weather in NYC?").isVisible()).toBe(true);
    expect(await page.getByText("And in London?").isVisible()).toBe(true);
    // Both tool call blocks
    const toolBlocks = await page.getByText("get_weather").all();
    expect(toolBlocks.length).toBe(2);
    // Both answers
    expect(await page.getByText(/65°F/).isVisible()).toBe(true);
    expect(await page.getByText(/55°F/).isVisible()).toBe(true);

    await page.close();
  });

  test("stop/resume toggle works after fixture replay", async () => {
    const { browser, port } = getContext();
    const { page, replayFixture } = await setupEventInjector(browser, port);

    await replayFixture("greeting-session.json");
    await page.getByText("Hello! How can I help you today?").waitFor();

    // Should see Stop button
    const toggleBtn = page.getByRole("button", { name: /Stop|Resume/ });
    await toggleBtn.waitFor({ timeout: 5000 });
    const label = (await toggleBtn.textContent())?.trim();
    expect(label).toBe("Stop");

    // Click Stop → should become Resume
    await toggleBtn.click();
    await page.getByRole("button", { name: "Resume" }).waitFor({ timeout: 3000 });

    await page.close();
  });
}

describe.skipIf(!playwrightAvailable)("browser: build -> start", () => {
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
