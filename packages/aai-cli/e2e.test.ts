// Copyright 2025 the AAI authors. MIT license.
/**
 * End-to-end CLI tests (Vite builds, real servers, Playwright browser):
 *   1. Template builds: dev & user workflows for representative templates
 *   2. Browser tests (Playwright): UI render, WebSocket, conversation flow
 *
 * Both suites share ONE beforeAll (CLI build + mock registry): the setup
 * mutates shared state (packages/aai-cli/dist, workspace package.json
 * versions during registry publish), so it must run exactly once per e2e
 * run — never once per file (vitest runs files concurrently).
 * Shared helpers live in _e2e-test-utils.ts.
 *
 * Run via: pnpm test:e2e
 */
import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { errorDetail } from "@alexkroman1/aai/utils";
import { ofetch } from "ofetch";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { hasPlaywrightBrowser, setupEventInjector } from "./_e2e-browser-test-utils.ts";
import {
  aai,
  aaiEnv,
  buildCli,
  detachedCli,
  installDeps,
  isRegistryProxyFailure,
  startRegistry,
  waitForExit,
  waitForHealth,
} from "./_e2e-test-utils.ts";
import { startSupervisedDevServer } from "./_fault-mode.ts";
import type { MockRegistry } from "./_mock-registry.ts";

// Representative subset: minimal baseline, external tools + custom UI, and
// durable workflows. This tier only builds these end-to-end. Config-level
// validation of EVERY template (asset imports resolve, toAgentConfig accepts
// the config) lives in packages/aai-templates/templates.test.ts
// (pnpm test:templates).
//
// `research-workflow` is here for one reason no in-tree test can cover: its
// `workflows/research.ts` imports `workflow`, and a scaffolded project resolves
// its dependencies from a real INSTALL of the published manifest rather than
// from this repo's node_modules. Missing from the scaffold's `dependencies`,
// the package resolves in every repo test and in nothing a user runs — the
// build dies on `Could not resolve "workflow"` in the one place no CI job
// looks.
const templates = ["simple", "web-researcher", "research-workflow"];

let aaiBin: string;
let tmpDir: string;
let registry: MockRegistry;

function initProject(template: string, projectDir: string): void {
  aai(aaiBin, ["init", projectDir, "-t", template, "--skip-deploy"], tmpDir);
  installDeps(registry, projectDir);
}

beforeAll(async () => {
  aaiBin = buildCli();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aai-e2e-test-"));
  // Start mock npm registry and publish workspace packages to it.
  // Packages are built + published inside startMockRegistry, so consumers
  // (npm/pnpm/yarn install) resolve them exactly as they would from the real registry.
  registry = await startRegistry();
});

afterAll(async () => {
  await registry?.stop();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

// --- Pack + build: representative templates ---

describe("pack + build: template workflows", () => {
  test.concurrent.for(templates)("template %s", async (template, ctx) => {
    const projectDir = path.join(tmpDir, template);

    // Init + install from mock registry + test + build
    aai(aaiBin, ["init", projectDir, "-t", template, "--skip-deploy"], tmpDir);
    try {
      installDeps(registry, projectDir);
    } catch (err) {
      // The mock registry's proxy to npmjs can fail in restricted
      // environments (e.g. turbo CI with egress proxies). Skip VISIBLY —
      // a silent `return` made the whole suite a green no-op exactly where
      // registry/exports regressions would surface — and only for failures
      // that look like network/proxy trouble; a real dependency-resolution
      // bug in the published packages must still fail.
      if (!isRegistryProxyFailure(err)) throw err;
      // Also log the full failure — the skip note is truncated and the
      // install output is captured, so this is the only diagnosis trail.
      const detail = errorDetail(err);
      const output = (err as { stderr?: string; stdout?: string }) ?? {};
      console.warn(
        `[e2e] install skipped for template ${template}:\n${detail}\n` +
          `stderr:\n${output.stderr ?? ""}\nstdout:\n${output.stdout ?? ""}`,
      );
      ctx.skip(`pnpm install failed (registry proxy issue): ${String(err).slice(0, 200)}`);
    }
    aai(aaiBin, ["test"], projectDir);
    aai(aaiBin, ["build", "--skip-tests"], projectDir);
  });
});

describe("self-hosted server: npm start", () => {
  /**
   * The scaffold ships `server.mjs` and the `prestart`/`start` pair, so every
   * project runs on its own with `npm start`. Only this tier can prove it: the
   * project's own `aai build` runs from a real INSTALL, `server.mjs` imports the
   * worker that build left on disk, and `defaultClientDir()` resolves out of the
   * installed `@alexkroman1/aai-ui`.
   *
   * **`pizza-ordering`, because it has a `tools/` directory — which is what this
   * leg is really about.** A tool is registered by EXISTING, enumerated into the
   * bundler's generated entry, so an entrypoint loading `agent.ts` directly boots
   * an agent with none of its six tools and no error anywhere. It also keeps what
   * `math-buddy` was picked for: a `./system-prompt.md?raw` import.
   */
  test("boots a scaffolded pizza-ordering project and serves it", async ({ skip }) => {
    const projectDir = path.join(tmpDir, "_self-hosted");
    aai(aaiBin, ["init", projectDir, "-t", "pizza-ordering", "--skip-deploy"], tmpDir);
    try {
      installDeps(registry, projectDir);
    } catch (err) {
      if (!isRegistryProxyFailure(err)) throw err;
      skip(`pnpm install failed (registry proxy issue): ${String(err).slice(0, 200)}`);
    }

    // PORT=0 lets the OS assign one — the suite runs concurrently with other
    // servers, and a fixed port is an EADDRINUSE flake waiting to happen.
    // No --skip-* anything: `npm start` runs the project's own `prestart`,
    // which is the half of self-hosting under test.
    const child = spawn("npm", ["start"], {
      cwd: projectDir,
      env: { ...aaiEnv(), PORT: "0" },
      stdio: "pipe",
    });
    try {
      const port = await new Promise<number>((resolve, reject) => {
        let buf = "";
        // stderr too, and it goes IN the failure: every way this can fail — a
        // build error, a missing artifact, a throwing agent — reports there,
        // and discarding it leaves a bare "exited with code 1" naming none of
        // them. That cost a full diagnosis cycle once already.
        child.stderr?.on("data", (chunk: Buffer) => {
          buf += chunk.toString();
        });
        child.stdout?.on("data", (chunk: Buffer) => {
          buf += chunk.toString();
          // The line server.mjs prints on listen: "<name> listening on <url>".
          const match = buf.match(/listening on http:\/\/[^:]+:(\d+)/);
          if (match) resolve(Number(match[1]));
        });
        child.on("error", reject);
        child.on("exit", (code) =>
          reject(
            new Error(`npm start exited with code ${code} before listening:\n${buf.slice(-4000)}`),
          ),
        );
      });

      await waitForHealth(`http://127.0.0.1:${port}/health`, child);
      const health = await ofetch<{ status: string; name: string }>(
        `http://127.0.0.1:${port}/health`,
      );
      expect(health).toMatchObject({ status: "ok", name: "Pizza Palace" });

      // The greeting proves createAgentServer read it off the agent rather
      // than the caller restating it — the silent-drop bug that command exists
      // to prevent. The page proves defaultClientDir() resolved from the
      // installed package, which no in-tree test can check.
      const config = await ofetch<{ name: string; greeting?: string }>(
        `http://127.0.0.1:${port}/client-config`,
      );
      expect(config.greeting).toBeTruthy();
      expect(await ofetch(`http://127.0.0.1:${port}/`, { responseType: "text" })).toContain(
        "<!DOCTYPE html>",
      );

      // The tools, read out of the artifact the server booted — nothing over
      // HTTP exposes a tool list, and this is the assertion that matters: these
      // six names exist ONLY because the build enumerated `tools/`, and the
      // failure is otherwise silent (every probe above still passes).
      const worker = path.join(projectDir, ".aai", "worker.mjs");
      const { __aaiConfig } = (await import(pathToFileURL(worker).href)) as {
        __aaiConfig: { toolSchemas: { name: string }[] };
      };
      const names = __aaiConfig.toolSchemas.map((t) => t.name);
      // Code-unit sort, never localeCompare — the standing rule here.
      expect(names.sort((a, b) => Number(a > b) - Number(a < b))).toEqual([
        "add_pizza",
        "place_order",
        "remove_pizza",
        "set_customer_name",
        "update_pizza",
        "view_order",
      ]);
    } finally {
      child.kill();
      await waitForExit(child);
    }
  });
});

describe("aai dev: a scaffolded workflow template", () => {
  /**
   * The question this answers is "can a user `aai init` a workflow template and
   * `aai dev` it", and nothing else in the repo can: the in-tree integration
   * test (`dev-workflow.scenario.test.ts`) drives the same code against a
   * fixture that resolves `workflow` from this workspace, and the `npm start`
   * leg above runs `server.mjs`, which has no bundler and builds no workflows.
   * Only here is the project scaffolded, installed from the published manifest,
   * and served by the real `aai dev` process.
   */
  test("boots and mounts the DevKit's queue callbacks", async ({ skip }) => {
    const projectDir = path.join(tmpDir, "_dev-workflow");
    aai(aaiBin, ["init", projectDir, "-t", "research-workflow", "--skip-deploy"], tmpDir);
    try {
      installDeps(registry, projectDir);
    } catch (err) {
      if (!isRegistryProxyFailure(err)) throw err;
      skip(`pnpm install failed (registry proxy issue): ${String(err).slice(0, 200)}`);
    }

    // A fixed port, because `aai dev --port` is how a user picks one and the
    // JSON line is what a script reads back; the range is chosen high enough to
    // sit clear of the other servers this suite runs.
    // Through the supervisor rather than a bare spawn, so this test inherits
    // FAULT MODE: with `AAI_FAULT_PROFILE` set it runs against a server that is
    // hard-killed and restarted underneath it, and with the variable unset it is
    // the same plain spawn it always was. See `_fault-mode.ts`.
    const server = await startSupervisedDevServer({
      aaiBin,
      cwd: projectDir,
      // A fixed port, because `aai dev --port` is how a user picks one and the
      // JSON line is what a script reads back; the range is chosen high enough
      // to sit clear of the other servers this suite runs. It also has to
      // survive a restart, which is why the supervisor takes one rather than
      // asking the OS.
      port: 4820,
      env: { ...aaiEnv(), ASSEMBLYAI_API_KEY: "e2e-not-dialled" },
      args: ["--json"],
    });
    try {
      // Booting at all is most of the assertion: `loadWorker` compiles
      // `workflows/` BEFORE the server listens, so a project whose workflow
      // build fails never answers /health. Under a profile, every declared kill
      // has to have happened and the survivor be healthy before the assertion —
      // otherwise the request below races a restart window.
      await server.awaitSettled();

      // Mounted-or-not is the distinction that matters. Unmounted, this falls
      // through to the server's 404 and every run stalls forever with nothing
      // logged — which is exactly how it behaved before the routes were wired.
      const res = await fetch(`${server.url}/.well-known/workflow/v1/flow`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      expect(res.status).not.toBe(404);
    } finally {
      await server.stop();
    }
  });
});

describe("bundled templates", () => {
  // `aai init` used to giget the templates from GitHub at run time; they now
  // ship inside dist/. Nothing in-tree can catch a regression here, because a
  // CLI running from packages/aai-cli/dist always finds the workspace root and
  // takes the monorepo branch — so detach the build first.
  test("init works from a detached dist with no workspace above it", () => {
    const detachedDir = fs.mkdtempSync(path.join(os.tmpdir(), "aai-detached-"));
    try {
      const detachedBin = detachedCli(aaiBin, detachedDir);
      const projectDir = path.join(tmpDir, "bundled-templates");
      aai(detachedBin, ["init", projectDir, "-t", "pipeline-simple", "--skip-deploy"], tmpDir);

      // A template file and a scaffold file: both dirs have to ship.
      expect(fs.existsSync(path.join(projectDir, "agent.ts"))).toBe(true);
      expect(fs.existsSync(path.join(projectDir, "tsconfig.json"))).toBe(true);
    } finally {
      fs.rmSync(detachedDir, { recursive: true, force: true });
    }
  });
});

// --- Browser tests (Playwright) ---
// Page/WebSocket scaffolding lives in _e2e-browser-test-utils.ts.

describe.skipIf(!hasPlaywrightBrowser())("browser: dev server", () => {
  let browser: Browser;
  let child: ChildProcess;
  let port: number;

  beforeAll(async () => {
    const projectDir = path.join(tmpDir, "_browser-dev");
    initProject("pizza-ordering", projectDir);
    aai(aaiBin, ["build", "--skip-tests"], projectDir);

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
       const live = new Set();
       const s = http.createServer((req, res) => {
         const url = new URL(req.url, "http://localhost");
         // Sever every live session socket ABRUPTLY — destroy, never close(1000).
         // A clean close is the "user hung up" case aai-ui deliberately does not
         // reconnect from, so a reconnect test built on one proves nothing.
         if (url.pathname === "/__sever") {
           let cut = 0;
           for (const sock of live) { sock.destroy(); cut++; }
           live.clear();
           res.writeHead(200, { "Content-Type": "application/json" });
           res.end(JSON.stringify({ severed: cut }));
           return;
         }
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
       wss.on("connection", (ws, req) => {
         live.add(ws._socket);
         ws.on("close", () => live.delete(ws._socket));
         // Echo the id the client asked to resume, so a redial that carries one
         // is answered as the SAME session rather than a fresh one.
         const asked = new URL(req.url, "http://localhost").searchParams.get("sessionId");
         ws.send(JSON.stringify({ type: "session.configured", meta: { id: "evt_e2ehandshake", at: Date.now() }, audioFormat: "pcm16", sampleRate: 16000, ttsSampleRate: 24000, sessionId: asked || "resumed-e2e-7" }));
       });
       s.listen(0, () => console.log("PORT:" + s.address().port));`,
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
            return JSON.parse(f).type === "session.configured";
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

  test("the client RECONNECTS after an abrupt drop and resumes the same session", async () => {
    // The client half of the disconnect contract, which nothing else covers.
    // `aai/host/session-resume*.integration.test.ts` proves the SERVER resumes a
    // session when asked; aai-ui's fuzz harnesses drive its reconnect against a
    // fake socket. Neither shows the real browser client redialling after a real
    // drop and carrying the id forward — partysocket's backoff, the
    // `serverIsBroker` latch and the handshake guard all sit in that path.
    //
    // Severed by DESTROYING the socket server-side, so the client sees 1006. A
    // clean close is the "user hung up" case aai-ui deliberately does not
    // reconnect from, so a test built on `close()` would prove the opposite of
    // what it looks like. (The `_fault-socket.ts` proxy does this properly for
    // in-package tests; it is `_`-internal to `aai`, which this package may not
    // import — hence the fake server severing its own socket.)
    const page = await browser.newPage();
    const urls: string[] = [];
    page.on("websocket", (ws) => urls.push(ws.url()));
    try {
      await page.goto(`http://localhost:${port}`);
      await page.getByRole("button", { name: "Start" }).click();
      await vi.waitFor(() => expect(urls.length).toBe(1), { timeout: 15_000, interval: 50 });
      expect(urls[0]).toContain("/websocket");
      // No id on the FIRST dial — so the one below can only have come from the
      // config frame, which is the mechanism under test. A distinctive value for
      // the same reason: a generic id could in principle be matched by some
      // client-side default rather than by the id this server issued.
      expect(urls[0]).not.toContain("sessionId=");

      const severed = await ofetch<{ severed: number }>(`http://localhost:${port}/__sever`);
      expect(severed.severed).toBeGreaterThanOrEqual(1);

      // The claim: it comes back on its own, and the redial names the session it
      // was in. A client that reconnected WITHOUT the id would start a fresh
      // conversation — the caller greeted again mid-call — so the id is the
      // assertion, not the reconnect count.
      await vi.waitFor(() => expect(urls.length).toBeGreaterThanOrEqual(2), {
        timeout: 30_000,
        interval: 100,
      });
      expect(urls[1]).toContain("sessionId=resumed-e2e-7");
    } finally {
      await page.close();
    }
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

  test.concurrent("the Resume button redials the session after fixture replay", async () => {
    const { page, replayFixture } = await setupEventInjector(browser, port);
    await replayFixture("greeting-session.json");
    await page.getByText("Hello! How can I help you today?").waitFor();

    // The label is DETERMINISTICALLY "Resume", not "non-deterministic" as this
    // test used to claim: `setupEventInjector` does not return until the session
    // reaches `data-state="error"`, and the `initAudioCapture` failure that puts
    // it there (no microphone in headless chromium) clears `running` in the same
    // update — see session-core-audio-setup.ts. Only `start`/`toggle` set
    // `running` back, so no injected fixture frame can move it.
    const toggleBtn = page.getByRole("button", { name: "Resume", exact: true });
    await toggleBtn.waitFor({ timeout: 30_000 });

    // **Assert the DIAL, not the label**, because the label is a TRANSIENT.
    // `toggle()` sets `running` synchronously, so the button reads "Stop" — and
    // then the new socket's `config` frame fails `initAudioCapture` all over
    // again and it reads "Resume" once more. Its lifetime is one socket round
    // trip plus a `getUserMedia` rejection, so waiting for "Stop" to be VISIBLE
    // is a race a locator loses whenever the machine is quick: it lost on
    // ubuntu CI while passing on macOS, 30s of polling then finding only the
    // label it started from. Playwright records `websocket` as an EVENT, which
    // cannot be missed however brief the label was.
    //
    // It still covers the regression this test exists for — an unwired
    // `Controls` onClick dials nothing at all — while the label toggle itself
    // is pinned deterministically by unit tests (components/controls.test.tsx,
    // components/integration.test.tsx).
    //
    // **`waitForEvent` with a PREDICATE, not an array polled by `expect.poll`.**
    // The poll was a hard failure in a `test.concurrent` — `guard-invariants`
    // rule 21 carries that argument and keeps the spelling out of the tree. The
    // predicate is the second half: this suite's stub attaches its
    // `WebSocketServer` to the http server, so it upgrades on EVERY path and
    // `dials.length > 0` never said the click dialed the SESSION.
    //
    // Armed BEFORE the click, so a dial that lands during `click()` is caught.
    const redial = page.waitForEvent("websocket", {
      predicate: (ws) => new URL(ws.url()).pathname === "/websocket",
      timeout: 30_000,
    });

    await toggleBtn.click();
    const dial = await redial;
    // The predicate matched the PATH; this pins the ORIGIN, so a dial at some
    // other server's `/websocket` cannot pass for the dev server's.
    expect(new URL(dial.url()).port).toBe(String(port));

    await page.close();
  });

  test.concurrent("new conversation clears messages", async () => {
    const { page, replayFixture, inject } = await setupEventInjector(browser, port);
    await replayFixture("simple-conversation.json");
    await page.getByText("A day on Venus is longer than its year.").waitFor();

    // Inject a reset event as if the server acknowledged the reset
    await inject({ type: "session.reset" });

    // Messages should be cleared — the assistant message should no longer be visible
    await page
      .getByText("A day on Venus is longer than its year.")
      .waitFor({ state: "hidden", timeout: 30_000 });

    await page.close();
  });

  test.concurrent("thinking state: user message appears after user_transcript", async () => {
    const { page, inject } = await setupEventInjector(browser, port);

    await inject({ type: "user-transcript.committed", text: "What is the meaning of life?" });
    await page.getByText("What is the meaning of life?").waitFor();

    // State indicator should show "thinking"
    await page.locator('[data-state="thinking"]').waitFor({ timeout: 30_000 });

    await inject({ type: "agent-transcript.updated", text: "42." });
    await page.getByText("42.").waitFor();

    await page.close();
  });

  test.concurrent("state transitions: thinking → listening after reply_done", async () => {
    const { page, inject } = await setupEventInjector(browser, port);

    await inject({ type: "user-transcript.committed", text: "Hello" });
    await page.locator('[data-state="thinking"]').waitFor({ timeout: 30_000 });

    await inject({ type: "agent-transcript.updated", text: "Hi there!" });
    await inject({ type: "reply.completed" });
    await page.locator('[data-state="listening"]').waitFor({ timeout: 30_000 });

    await page.close();
  });

  test.concurrent("error event shows error banner with message", async () => {
    const { page, inject } = await setupEventInjector(browser, port);

    // Inject an error event
    await inject({ type: "error.reported", code: "internal", message: "Connection lost" });

    // Error banner should appear with the message
    await page.getByText("Connection lost").waitFor({ timeout: 30_000 });

    await page.close();
  });
});
