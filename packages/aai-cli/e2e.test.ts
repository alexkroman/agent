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
import {
  type ErrorCodeName,
  encAgentTranscript,
  encAudioDone,
  encCancelled,
  encConfig,
  encCustomEvent,
  encError,
  encIdleTimeout,
  encReplyDone,
  encResetS2C,
  encSpeechStarted,
  encSpeechStopped,
  encToolCall,
  encToolCallDone,
  encUserTranscript,
  S2C,
} from "@alexkroman1/aai/wire";
import type { Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import type { MockRegistry } from "./_mock-registry.ts";

const { chromium } = await import("playwright");

/**
 * Converts a fixture message (JSON shape from aai-ui/fixtures/*.json) into
 * the binary wire frame expected by the browser client. Returns null for
 * unsupported/unknown types so callers can skip gracefully.
 *
 * Field-name differences between fixtures and wire encoders:
 *   fixture toolCallId → wire callId
 *   fixture toolName   → wire name
 *   fixture sessionId  → wire sid
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: switch over all S2C fixture types; splitting would hurt readability
function encodeFixtureMessage(msg: Record<string, unknown>): Uint8Array | null {
  switch (msg.type) {
    case "config":
      return encConfig({
        sampleRate: (msg.sampleRate as number) ?? 16_000,
        ttsSampleRate: (msg.ttsSampleRate as number) ?? 24_000,
        sid: (msg.sessionId as string) ?? "",
      });
    case "audio_done":
      return encAudioDone();
    case "speech_started":
      return encSpeechStarted();
    case "speech_stopped":
      return encSpeechStopped();
    case "user_transcript":
      return encUserTranscript((msg.text as string) ?? "");
    case "agent_transcript":
      return encAgentTranscript((msg.text as string) ?? "");
    case "tool_call": {
      const result = encToolCall(
        (msg.toolCallId as string) ?? "",
        (msg.toolName as string) ?? "",
        msg.args ?? {},
      );
      if (result === null) console.warn("[encodeFixtureMessage] encToolCall returned null", msg);
      return result;
    }
    case "tool_call_done":
      return encToolCallDone((msg.toolCallId as string) ?? "", (msg.result as string) ?? "");
    case "reply_done":
      return encReplyDone();
    case "cancelled":
      return encCancelled();
    case "reset":
      return encResetS2C();
    case "idle_timeout":
      return encIdleTimeout();
    case "error": {
      const result = encError(
        (msg.code as ErrorCodeName) ?? "internal",
        (msg.message as string) ?? "",
      );
      return result;
    }
    case "custom_event": {
      const result = encCustomEvent((msg.event as string) ?? "", msg.data);
      if (result === null) console.warn("[encodeFixtureMessage] encCustomEvent returned null", msg);
      return result;
    }
    default:
      console.warn("[encodeFixtureMessage] unsupported message type, skipping:", msg.type);
      return null;
  }
}

/** Check if Playwright browsers are installed (chromium). */
function hasPlaywrightBrowser(): boolean {
  try {
    return fs.existsSync(chromium.executablePath());
  } catch {
    return false;
  }
}

const dir = import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname);
const packagesDir = path.resolve(dir, "..");

// Representative subset: minimal baseline, stateful + tools, external tools + custom UI.
// Full template coverage is handled by the templates unit test tier (pnpm test:templates).
const templates = ["simple", "web-researcher"];

let aaiBin: string;
let tmpDir: string;
let registry: MockRegistry;

const pm = (process.env.AAI_TEST_PM ?? "pnpm") as "pnpm" | "npm" | "yarn";

function aaiEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    VITEST: undefined, // CLI skips main() when VITEST=true
    INIT_CWD: undefined, // resolveCwd() prefers INIT_CWD over process.cwd()
    NO_COLOR: "1",
    FORCE_COLOR: "0",
    AAI_NO_DEV: "1",
    AAI_TEMPLATES_DIR: path.resolve(dir, "../aai-templates"),
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

  // Rewrite workspace dep versions to match the unique testVersion
  // published to the mock registry (avoids pnpm store cache collisions).
  const pkgJsonPath = path.join(projectDir, "package.json");
  const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"));
  for (const depField of ["dependencies", "devDependencies"] as const) {
    if (!pkgJson[depField]) continue;
    for (const dep of Object.keys(pkgJson[depField])) {
      if (
        dep === "@alexkroman1/aai" ||
        dep === "@alexkroman1/aai-ui" ||
        dep === "@alexkroman1/aai-cli"
      ) {
        pkgJson[depField][dep] = registry.testVersion;
      }
    }
  }
  // Remove packageManager to avoid corepack version mismatches in tests
  delete pkgJson.packageManager;
  fs.writeFileSync(pkgJsonPath, `${JSON.stringify(pkgJson, null, 2)}\n`);

  // Write .npmrc in the project directory so pnpm reliably uses the mock
  // registry even when running under turbo (env-only config can be overridden
  // by ancestor .npmrc files discovered during directory traversal).
  const npmrcPath = path.join(projectDir, ".npmrc");
  const registryHost = new URL(registry.registryUrl).host;
  fs.writeFileSync(
    npmrcPath,
    `registry=${registry.registryUrl}\n//${registryHost}/:_authToken=test-token\n`,
  );

  if (pm === "npm") {
    execFileSync("npm", ["install"], { cwd: projectDir, stdio: "inherit", env });
  } else if (pm === "yarn") {
    execFileSync("yarn", ["install", "--no-lockfile"], { cwd: projectDir, stdio: "inherit", env });
  } else {
    execFileSync("pnpm", ["install", "--no-frozen-lockfile", "--no-strict-peer-dependencies"], {
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
    try {
      installDeps(projectDir);
    } catch {
      // Mock registry proxy to npmjs can fail in restricted environments
      // (e.g. turbo CI with egress proxies). Skip rather than fail.
      console.warn(`Skipping template ${template}: pnpm install failed (registry proxy issue)`);
      return;
    }
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
  // Wait for the session to settle after the config message. In headless
  // Chromium, initAudioCapture fails (no microphone), which sets state to
  // "error" asynchronously. If we inject events before that completes, the
  // audio error can overwrite test-driven state transitions.
  await page.locator('[data-state="error"]').waitFor({ timeout: 10_000 });

  /** Inject a server->client event via the captured WebSocket.
   * Accepts the fixture JSON shape, encodes it to binary, and dispatches
   * an ArrayBuffer MessageEvent (matching the binary wire protocol). */
  const inject = async (msg: Record<string, unknown>) => {
    const bytes = encodeFixtureMessage(msg);
    if (bytes === null) return; // unsupported type — skip silently
    const nums = Array.from(bytes);
    await page.evaluate((arr) => {
      const ws = (globalThis as Record<string, unknown>).__aai_test_ws as WebSocket;
      const buf = new Uint8Array(arr).buffer;
      ws.dispatchEvent(new MessageEvent("message", { data: buf }));
    }, nums);
  };

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

describe.skipIf(!hasPlaywrightBrowser())("browser: dev server", () => {
  let browser: Browser;
  let child: ChildProcess;
  let port: number;

  beforeAll(async () => {
    const projectDir = path.join(tmpDir, "_browser-dev");
    initProject("pizza-ordering", projectDir);
    aai(["build", "--skip-tests"], projectDir);

    // Serve the built client with a simple static server (faster than vite dev)
    const clientDir = path.join(projectDir, ".aai", "client");
    // Absolute file URL for the wire ESM module so the child process (node -e,
    // which runs in CJS mode) can load it via dynamic import().
    const wireModuleUrl = new URL(path.resolve(dir, "../aai/dist/sdk/wire.js"), "file://").href;
    child = spawn(
      process.execPath,
      [
        "-e",
        `const http = require("http"); const fs = require("fs"); const path = require("path");
       const { WebSocketServer } = require("ws");
       const mimes = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml" };
       const root = ${JSON.stringify(clientDir)};
       const wireUrl = ${JSON.stringify(wireModuleUrl)};
       import(wireUrl).then(wire => {
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
           const frame = wire.encConfig({ sampleRate: 16000, ttsSampleRate: 24000, sid: "test" });
           ws.send(Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength));
         });
         s.listen(0, () => console.log("PORT:" + s.address().port));
       }).catch(err => { console.error("wire import failed:", err); process.exit(1); });`,
      ],
      { stdio: "pipe" },
    );

    // Read the OS-assigned port from child stdout to avoid EADDRINUSE
    port = await new Promise<number>((resolve, reject) => {
      let buf = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        buf += chunk.toString();
        const match = buf.match(/PORT:(\d+)/);
        if (match) resolve(Number(match[1]));
      });
      child.on("error", reject);
      child.on("exit", (code) =>
        reject(new Error(`Child exited with code ${code} before reporting port`)),
      );
    });

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

    // Collect binary frames (Buffer) from the server. The wire protocol uses
    // binary frames; S2C.CONFIG == 0x82 is the first byte of a config frame.
    const binaryFrames: Buffer[] = [];
    const wsConnected = new Promise<string>((resolve) => {
      page.on("websocket", (ws) => {
        resolve(ws.url());
        ws.on("framereceived", (frame) => {
          if (typeof frame.payload !== "string") {
            binaryFrames.push(Buffer.from(frame.payload as Buffer));
          }
        });
      });
    });

    await page.getByRole("button", { name: "Start" }).click();
    const wsUrl = await wsConnected;
    expect(wsUrl).toContain("/websocket");

    await vi.waitFor(
      () => {
        // S2C.CONFIG == 0x82; first byte of the binary frame identifies the type
        const found = binaryFrames.some((buf) => buf.length > 0 && buf[0] === S2C.CONFIG);
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
    await toggleBtn.waitFor({ timeout: 30_000 });

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
      .waitFor({ state: "hidden", timeout: 30_000 });

    await page.close();
  });

  test.concurrent("thinking state: user message appears after user_transcript", async () => {
    const { page, inject } = await setupEventInjector(browser, port);

    await inject({ type: "user_transcript", text: "What is the meaning of life?" });
    await page.getByText("What is the meaning of life?").waitFor();

    // State indicator should show "thinking"
    await page.locator('[data-state="thinking"]').waitFor({ timeout: 30_000 });

    await inject({ type: "agent_transcript", text: "42." });
    await page.getByText("42.").waitFor();

    await page.close();
  });

  test.concurrent("state transitions: thinking → listening after reply_done", async () => {
    const { page, inject } = await setupEventInjector(browser, port);

    await inject({ type: "user_transcript", text: "Hello" });
    await page.locator('[data-state="thinking"]').waitFor({ timeout: 30_000 });

    await inject({ type: "agent_transcript", text: "Hi there!" });
    await inject({ type: "reply_done" });
    await page.locator('[data-state="listening"]').waitFor({ timeout: 30_000 });

    await page.close();
  });

  test.concurrent("error event shows error banner with message", async () => {
    const { page, inject } = await setupEventInjector(browser, port);

    // Inject an error event
    await inject({ type: "error", code: "internal", message: "Connection lost" });

    // Error banner should appear with the message
    await page.getByText("Connection lost").waitFor({ timeout: 30_000 });

    await page.close();
  });
});
