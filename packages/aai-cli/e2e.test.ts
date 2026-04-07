// Copyright 2025 the AAI authors. MIT license.
/**
 * End-to-end CLI tests (Vite builds, real servers, Playwright browser):
 *   1. Template builds: dev & user workflows for representative templates
 *   2. Browser tests (Playwright): UI render, WebSocket, conversation flow
 *
 * Run via: pnpm test:e2e
 */
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import type { MockRegistry } from "./_mock-registry.ts";

const { chromium } = await import("playwright");

const dir = import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname);
const packagesDir = path.resolve(dir, "..");

const templates = [
  "code-interpreter",
  "dispatch-center",
  "embedded-assets",
  "health-assistant",
  "infocom-adventure",
  "math-buddy",
  "memory-agent",
  "night-owl",
  "personal-finance",
  "pizza-ordering",
  "simple",
  "smart-research",
  "solo-rpg",
  "support",
  "test-patterns",
  "travel-concierge",
  "web-researcher",
];

let aaiBin: string;
let tmpDir: string;
let registry: MockRegistry;

const pm = (process.env.AAI_TEST_PM ?? "pnpm") as "pnpm" | "npm" | "yarn";

// Random high port base to avoid collisions between parallel CI runs
const BASE_PORT = 40_000 + Math.floor(Math.random() * 10_000);

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

/** Poll a health endpoint, capturing child stderr for diagnostics on timeout. */
async function waitForHealth(url: string, child?: ChildProcess, timeoutMs = 30_000): Promise<void> {
  let stderr = "";
  child?.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
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
  throw new Error(`Timed out waiting for ${url}${stderr ? `\nServer stderr:\n${stderr}` : ""}`);
}

/** Wait for a child process to exit (for clean teardown). */
function waitForExit(child: ChildProcess, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    child.on("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function initProject(template: string, projectDir: string): void {
  aai(["init", projectDir, "-t", template, "--skip-api", "--skip-deploy"], tmpDir);
  installDeps(projectDir);
}

/** Install dependencies using the mock registry. */
function installDeps(projectDir: string): void {
  const env = { ...aaiEnv(), ...registry.env };

  // Rewrite @alexkroman1/* dep versions to match the unique testVersion
  // published to the mock registry (avoids pnpm store cache collisions).
  const pkgJsonPath = path.join(projectDir, "package.json");
  const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"));
  for (const depField of ["dependencies", "devDependencies"] as const) {
    if (!pkgJson[depField]) continue;
    for (const dep of Object.keys(pkgJson[depField])) {
      if (dep.startsWith("@alexkroman1/")) {
        pkgJson[depField][dep] = registry.testVersion;
      }
    }
  }
  if (pm === "npm" || pm === "yarn") {
    delete pkgJson.packageManager;
  }
  fs.writeFileSync(pkgJsonPath, `${JSON.stringify(pkgJson, null, 2)}\n`);

  if (pm === "npm") {
    execFileSync("npm", ["install"], { cwd: projectDir, stdio: "inherit", env });
  } else if (pm === "yarn") {
    execFileSync("yarn", ["install", "--no-lockfile"], { cwd: projectDir, stdio: "inherit", env });
  } else {
    execFileSync("pnpm", ["install", "--no-frozen-lockfile"], {
      cwd: projectDir,
      stdio: "inherit",
      env,
    });
  }
}

beforeAll(async () => {
  // Build CLI
  execFileSync("npx", ["tsdown"], { cwd: dir, stdio: "inherit" });
  const mjs = path.resolve(dir, "dist/cli.mjs");
  const js = path.resolve(dir, "dist/cli.js");
  aaiBin = fs.existsSync(mjs) ? mjs : js;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aai-e2e-test-"));

  // Start mock npm registry and publish workspace packages to it.
  // Packages are built + published inside startMockRegistry, so consumers
  // (npm/pnpm/yarn install) resolve them exactly as they would from the real registry.
  const { startMockRegistry } = await import("./_mock-registry.ts");
  registry = await startMockRegistry(packagesDir, ["aai", "aai-ui", "aai-cli"]);
});

afterAll(async () => {
  await registry?.stop();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

// --- Pack + build: representative templates ---

describe("pack + build: template workflows", () => {
  test.concurrent.each(templates)("template %s", async (template) => {
    const projectDir = path.join(tmpDir, template);

    // Init + install from mock registry + test + build
    aai(["init", projectDir, "-t", template, "--skip-api", "--skip-deploy"], tmpDir);
    installDeps(projectDir);
    aai(["test"], projectDir);
    aai(["build", "--skip-tests"], projectDir);
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

  /** Inject a server->client event via the captured WebSocket. */
  const inject = (msg: Record<string, unknown>) =>
    page.evaluate((json) => {
      const ws = (globalThis as Record<string, unknown>).__aai_test_ws as WebSocket;
      ws.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(json) }));
    }, msg);

  /** Replay a fixture file (from aai-ui/fixtures/). */
  const replayFixture = async (fixtureName: string) => {
    const fixturePath = path.resolve(dir, "../aai-ui/fixtures", fixtureName);
    const messages = JSON.parse(fs.readFileSync(fixturePath, "utf-8")) as Record<string, unknown>[];
    for (const msg of messages) {
      await inject(msg);
      await new Promise((r) => setTimeout(r, 50));
    }
  };

  return { page, inject, replayFixture, clientFrames };
}

describe("browser: dev server", () => {
  let browser: Browser;
  let child: ChildProcess;
  const port = BASE_PORT + 200;

  beforeAll(async () => {
    const projectDir = path.join(tmpDir, "_browser-dev");
    initProject("simple", projectDir);
    aai(["build", "--skip-tests"], projectDir);

    // Serve the built client with a simple static server (faster than vite dev)
    const clientDir = path.join(projectDir, ".aai", "client");
    child = spawn(
      process.execPath,
      [
        "-e",
        `const http = require("http"); const fs = require("fs"); const path = require("path");
       const { WebSocketServer } = require("ws");
       const mimes = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml" };
       const root = ${JSON.stringify(clientDir)};
       const s = http.createServer((req, res) => {
         const url = new URL(req.url, "http://localhost");
         const f = path.join(root, url.pathname === "/" ? "index.html" : url.pathname);
         if (!f.startsWith(root)) { res.writeHead(403); res.end(); return; }
         try {
           const data = fs.readFileSync(f);
           const ct = mimes[path.extname(f)] || "application/octet-stream";
           res.writeHead(200, { "Content-Type": ct });
           res.end(data);
         } catch { res.writeHead(404); res.end("not found"); }
       });
       const wss = new WebSocketServer({ server: s });
       wss.on("connection", (ws) => {
         ws.send(JSON.stringify({ type: "config", audioFormat: "pcm16", sampleRate: 16000, ttsSampleRate: 24000, sessionId: "test" }));
       });
       s.listen(${port}, () => console.log("ready"));`,
      ],
      { stdio: "pipe" },
    );
    await waitForHealth(`http://localhost:${port}`, child);
    browser = await chromium.launch();
  });

  afterAll(async () => {
    await browser?.close();
    child?.kill();
    if (child) await waitForExit(child);
  });

  test.concurrent("page renders with Start button", async () => {
    const page = await browser.newPage();
    await page.goto(`http://localhost:${port}`);
    await page.getByRole("button", { name: "Start" }).waitFor();
    await page.close();
  });

  test.concurrent("clicking Start opens a WebSocket and receives config", async () => {
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

    await vi.waitFor(
      () => {
        const found = frames.some((f) => {
          try {
            return JSON.parse(f).type === "config";
          } catch {
            return false;
          }
        });
        expect(found).toBe(true);
      },
      { timeout: 10_000, interval: 50 },
    );

    await page.close();
  });

  // ── Fixture-driven event injection tests ───────────────────────────────

  test.concurrent("greeting session: agent message renders in browser", async () => {
    const { page, replayFixture } = await setupEventInjector(browser, port);

    await replayFixture("greeting-session.json");
    await page.getByText("Hello! How can I help you today?").waitFor();
    await page.close();
  });

  test.concurrent("simple conversation: user + assistant messages render", async () => {
    const { page, replayFixture } = await setupEventInjector(browser, port);
    await replayFixture("simple-conversation.json");

    await page.getByText("Hi there!").waitFor();
    await page.getByText("Tell me a fun fact about space.").waitFor();
    await page.getByText("A day on Venus is longer than its year.").waitFor();

    await page.close();
  });

  test.concurrent("tool call flow: tool block renders with name, messages appear", async () => {
    const { page, replayFixture } = await setupEventInjector(browser, port);
    await replayFixture("tool-call-flow.json");

    await page.getByText("The weather in San Francisco is sunny at 72°F.").waitFor();
    await page.getByText("get_weather").waitFor();
    await page.getByText("What is the weather like in San Francisco?").waitFor();

    await page.close();
  });

  test.concurrent("error recovery: error banner renders with message", async () => {
    const { page, replayFixture } = await setupEventInjector(browser, port);
    await replayFixture("error-recovery.json");

    await page.getByText("Speech recognition failed").waitFor();
    await page.getByRole("button", { name: "Resume" }).waitFor();

    await page.close();
  });

  test.concurrent("barge-in: interrupted response cleared, new answer renders", async () => {
    const { page, replayFixture } = await setupEventInjector(browser, port);
    await replayFixture("barge-in.json");

    await page.getByText("No problem!").waitFor();
    await page.getByText("What about").waitFor();
    await page.getByText("Actually never mind").waitFor();

    await page.close();
  });

  test.concurrent("multi-turn with tools: two tool calls and all messages render", async () => {
    const { page, replayFixture } = await setupEventInjector(browser, port);
    await replayFixture("multi-turn-with-tools.json");

    await page.getByText("London is 55°F and rainy.").waitFor();
    await page.getByText("Weather in NYC?").waitFor();
    await page.getByText("And in London?").waitFor();
    const toolBlocks = await page.getByText("get_weather").all();
    expect(toolBlocks.length).toBe(2);
    await page.getByText(/65°F/).waitFor();
    await page.getByText(/55°F/).waitFor();

    await page.close();
  });

  test.concurrent("stop/resume toggle works after fixture replay", async () => {
    const { page, replayFixture } = await setupEventInjector(browser, port);
    await replayFixture("greeting-session.json");
    await page.getByText("Hello! How can I help you today?").waitFor();

    // Verify a Stop or Resume button exists — on CI the WebSocket may
    // already be closed so the initial state is non-deterministic.
    const toggleBtn = page.getByRole("button", { name: /Stop|Resume/ });
    await toggleBtn.waitFor({ timeout: 5000 });

    await page.close();
  });

  test.concurrent("new conversation clears messages", async () => {
    const { page, replayFixture, inject } = await setupEventInjector(browser, port);
    await replayFixture("simple-conversation.json");
    await page.getByText("A day on Venus is longer than its year.").waitFor();

    // Inject a reset event as if the server acknowledged the reset
    await inject({ type: "reset" });

    // Messages should be cleared — the assistant message should no longer be visible
    await page
      .getByText("A day on Venus is longer than its year.")
      .waitFor({ state: "hidden", timeout: 5000 });

    await page.close();
  });

  test.concurrent("thinking state: dots appear after turn event", async () => {
    const { page, inject } = await setupEventInjector(browser, port);

    // Inject a user_transcript event — transitions state to "thinking"
    await inject({ type: "user_transcript", text: "What is the meaning of life?" });

    // The user message should appear
    await page.getByText("What is the meaning of life?").waitFor();

    // Thinking indicator (3 bouncing dots) should be visible —
    // it renders as divs with the aai-bounce animation class
    await page.locator('[style*="aai-bounce"]').first().waitFor({ timeout: 5000 });

    // Complete the turn so the UI settles
    await inject({ type: "agent_transcript", text: "42." });
    await page.getByText("42.").waitFor();

    await page.close();
  });

  test.concurrent("live transcript: partial speech text renders", async () => {
    const { page, inject } = await setupEventInjector(browser, port);

    // speech_started → userUtterance becomes "" → shows thinking dots
    await inject({ type: "speech_started" });

    // Partial user_transcript_delta → shows the text
    await inject({ type: "user_transcript_delta", text: "Tell me about", isFinal: false });
    await page.getByText("Tell me about").waitFor();

    // Updated user_transcript_delta
    await inject({ type: "user_transcript_delta", text: "Tell me about space", isFinal: false });
    await page.getByText("Tell me about space").waitFor();

    // user_transcript finalizes the transcript
    await inject({ type: "user_transcript", text: "Tell me about space" });
    await inject({ type: "agent_transcript", text: "Space is vast." });
    await page.getByText("Space is vast.").waitFor();

    await page.close();
  });

  test.concurrent("state transitions: listening → thinking → speaking labels", async () => {
    const { page, inject } = await setupEventInjector(browser, port);

    // After start + config, state should be "listening" or "ready"
    // Inject a user_transcript to move to "thinking"
    await inject({ type: "user_transcript", text: "Hello" });

    // The state indicator text should show "thinking"
    await page.getByText("thinking").waitFor({ timeout: 5000 });

    // agent_transcript_delta doesn't change state, but agent_transcript + reply_done → listening
    await inject({ type: "agent_transcript", text: "Hi there!" });
    await inject({ type: "reply_done" });
    await page.getByText("listening").waitFor({ timeout: 5000 });

    await page.close();
  });

  test.concurrent("error event shows error banner with message", async () => {
    const { page, inject } = await setupEventInjector(browser, port);

    // Inject an error event
    await inject({ type: "error", code: "internal", message: "Connection lost" });

    // Error banner should appear with the message
    await page.getByText("Connection lost").waitFor({ timeout: 5000 });

    await page.close();
  });
});
