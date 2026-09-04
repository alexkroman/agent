// Copyright 2026 the AAI authors. MIT license.
/**
 * End-to-end BROWSER tests (Playwright over a real built client).
 *
 * Split from `e2e.test.ts` when that file reached the 700-line test cap, at the
 * seam its own module doc already named: the CLI/server suites there, the
 * browser ones here. Page and WebSocket scaffolding is in
 * `_e2e-browser-test-utils.ts`.
 *
 * ## The shared setup, and why this file may exist at all
 *
 * `buildCli()` and `startRegistry()` mutate state shared across the whole run —
 * `packages/aai-cli/dist`, and workspace package.json versions during publish —
 * so `e2e.test.ts`'s doc used to say the setup "must run exactly once per e2e
 * run — never once per file (vitest runs files concurrently)". That last clause
 * is what made a second file unsafe, and it is no longer true: the e2e profile
 * sets `fileParallelism: false` (see `vitest.slow.config.ts`), so the two files
 * run one after the other and each gets its own build and its own registry at a
 * unique version. Serialized, that is correct rather than merely lucky.
 *
 * Do NOT reintroduce concurrency for this tier without replacing that setup
 * with a `globalSetup`.
 */
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ofetch } from "ofetch";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import {
  hasPlaywrightBrowser,
  setupEventInjector,
  startStubClientServer,
} from "./_e2e-browser-test-utils.ts";
import {
  aai,
  aaiEnv,
  buildCli,
  installDeps,
  startRegistry,
  waitForExit,
  waitForHealth,
} from "./_e2e-test-utils.ts";
import { startSupervisedDevServer } from "./_fault-mode.ts";
import type { MockRegistry } from "./_mock-registry.ts";

let aaiBin: string;
let tmpDir: string;
let registry: MockRegistry;

function initProject(template: string, projectDir: string): void {
  aai(aaiBin, ["init", projectDir, "-t", template, "--skip-deploy"], tmpDir);
  installDeps(registry, projectDir);
}

beforeAll(async () => {
  aaiBin = buildCli();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aai-e2e-browser-"));
  registry = await startRegistry();
});

afterAll(async () => {
  await registry?.stop();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe.skipIf(!hasPlaywrightBrowser())("browser: dev server", () => {
  let browser: Browser;
  let child: ChildProcess;
  let port: number;

  beforeAll(async () => {
    const projectDir = path.join(tmpDir, "_browser-dev");
    initProject("pizza-ordering", projectDir);
    aai(aaiBin, ["build", "--skip-tests"], projectDir);

    // A stub http+ws server over the built client, not `aai dev` — see the
    // helper's doc for why, and the last describe in this file for the one test
    // that does drive the real thing.
    ({ child, port } = await startStubClientServer(path.join(projectDir, ".aai", "client")));
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
    await expect(page.getByRole("button", { name: "Start" }).waitFor()).resolves.toBeUndefined();
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
    await expect(
      page.getByText("Hello! How can I help you today?").waitFor(),
    ).resolves.toBeUndefined();
    await page.close();
  });

  test.concurrent("simple conversation: user + assistant messages render", async () => {
    const { page, replayFixture } = await setupEventInjector(browser, port);
    await replayFixture("simple-conversation.json");

    await expect(page.getByText("Hi there!").waitFor()).resolves.toBeUndefined();
    await expect(
      page.getByText("Tell me a fun fact about space.").waitFor(),
    ).resolves.toBeUndefined();
    await expect(
      page.getByText("A day on Venus is longer than its year.").waitFor(),
    ).resolves.toBeUndefined();

    await page.close();
  });

  test.concurrent("tool call flow: tool block renders with name, messages appear", async () => {
    const { page, replayFixture } = await setupEventInjector(browser, port);
    await replayFixture("tool-call-flow.json");

    await expect(
      page.getByText("The weather in San Francisco is sunny at 72°F.").waitFor(),
    ).resolves.toBeUndefined();
    await expect(page.getByText("get_weather").waitFor()).resolves.toBeUndefined();
    await expect(
      page.getByText("What is the weather like in San Francisco?").waitFor(),
    ).resolves.toBeUndefined();

    await page.close();
  });

  test.concurrent("error recovery: error banner renders with message", async () => {
    const { page, replayFixture } = await setupEventInjector(browser, port);
    await replayFixture("error-recovery.json");

    await expect(page.getByText("Speech recognition failed").waitFor()).resolves.toBeUndefined();
    await expect(page.getByRole("button", { name: "Resume" }).waitFor()).resolves.toBeUndefined();

    await page.close();
  });

  test.concurrent("barge-in: interrupted response cleared, new answer renders", async () => {
    const { page, replayFixture } = await setupEventInjector(browser, port);
    await replayFixture("barge-in.json");

    await expect(page.getByText("No problem!").waitFor()).resolves.toBeUndefined();
    await expect(page.getByText("What about").waitFor()).resolves.toBeUndefined();
    await expect(page.getByText("Actually never mind").waitFor()).resolves.toBeUndefined();

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
    await expect(
      page.getByText("A day on Venus is longer than its year.").waitFor(),
    ).resolves.toBeUndefined();

    // Inject a reset event as if the server acknowledged the reset
    await inject({ type: "session.reset" });

    // Messages should be cleared — the assistant message should no longer be visible
    await expect(
      page
        .getByText("A day on Venus is longer than its year.")
        .waitFor({ state: "hidden", timeout: 30_000 }),
    ).resolves.toBeUndefined();

    await page.close();
  });

  test.concurrent("thinking state: user message appears after user_transcript", async () => {
    const { page, inject } = await setupEventInjector(browser, port);

    await inject({ type: "user-transcript.committed", text: "What is the meaning of life?" });
    await expect(page.getByText("What is the meaning of life?").waitFor()).resolves.toBeUndefined();

    // State indicator should show "thinking"
    await expect(
      page.locator('[data-state="thinking"]').waitFor({ timeout: 30_000 }),
    ).resolves.toBeUndefined();

    await inject({ type: "agent-transcript.updated", text: "42." });
    await expect(page.getByText("42.").waitFor()).resolves.toBeUndefined();

    await page.close();
  });

  test.concurrent("state transitions: thinking → listening after reply_done", async () => {
    const { page, inject } = await setupEventInjector(browser, port);

    await inject({ type: "user-transcript.committed", text: "Hello" });
    await expect(
      page.locator('[data-state="thinking"]').waitFor({ timeout: 30_000 }),
    ).resolves.toBeUndefined();

    await inject({ type: "agent-transcript.updated", text: "Hi there!" });
    await inject({ type: "reply.completed" });
    await expect(
      page.locator('[data-state="listening"]').waitFor({ timeout: 30_000 }),
    ).resolves.toBeUndefined();

    await page.close();
  });

  test.concurrent("error event shows error banner with message", async () => {
    const { page, inject } = await setupEventInjector(browser, port);

    // Inject an error event
    await inject({
      type: "error.reported",
      code: "internal",
      message: "Connection lost",
      fatal: true,
    });

    // Error banner should appear with the message
    await expect(
      page.getByText("Connection lost").waitFor({ timeout: 30_000 }),
    ).resolves.toBeUndefined();

    await page.close();
  });
});

/**
 * The same client, served by the REAL `aai dev`. One test, deliberately.
 *
 * The stub above is what makes the fifteen fixture tests deterministic — no
 * live session emits frames of its own, and `/__sever` cuts a socket without
 * the server going away — so it stays. The cost is that none of them touches
 * the stack a user runs: delete `viteDevConfig`'s `"/websocket": { ws: true }`
 * proxy entry and all fifteen still pass. This one fails.
 *
 * `session.configured` is the assertion because `ws-handler.ts` sends it the
 * moment the socket opens, before any provider is dialled, and it cannot
 * arrive unless the upgrade really crossed Vite into the backend.
 */
describe.skipIf(!hasPlaywrightBrowser())("browser: the real aai dev server", () => {
  test("Vite serves the client and proxies the session upgrade", async () => {
    const projectDir = path.join(tmpDir, "_browser-vite");
    initProject("pizza-ordering", projectDir);
    const server = await startSupervisedDevServer({
      aaiBin,
      cwd: projectDir,
      // Fixed, and clear of the workflow leg's 4820: with a client.tsx present
      // Vite owns this port and picks the backend's itself.
      port: 4830,
      // `localhost`, never `127.0.0.1` — Vite binds the NAME and lands on `::1`
      // here. The option's doc carries the `lsof` measurement.
      host: "localhost",
      env: { ...aaiEnv(), ASSEMBLYAI_API_KEY: "e2e-not-dialled" },
    });
    const browser = await chromium.launch();
    try {
      // A no-op unless AAI_FAULT_PROFILE is set; under one it is what stops the
      // navigation below racing a restart window.
      await server.awaitSettled();

      const page = await browser.newPage();
      // Armed before `goto`, and PREDICATED because an unpredicated wait here
      // resolves on the WRONG SOCKET. Measured against a scaffolded project:
      // Vite's HMR client opens `ws://<host>/?token=…` twice, both BEFORE the
      // session dial, so "whichever websocket appears first" is the HMR one.
      // (The stub suite above has no HMR socket, which is why it can be loose.)
      const dial = page.waitForEvent("websocket", {
        predicate: (ws) => new URL(ws.url()).pathname === "/websocket",
        timeout: 30_000,
      });
      await page.goto(server.url);
      await page.getByRole("button", { name: "Start" }).click();

      // Measured: `session.configured` lands first even though this key is
      // rejected — the provider failures (`AssemblyAI STT: connect failed`)
      // arrive after it, so nothing here depends on a live credential.
      const frame = await (await dial).waitForEvent("framereceived", { timeout: 30_000 });
      expect(JSON.parse(String(frame.payload))).toMatchObject({ type: "session.configured" });
    } finally {
      await browser.close();
      await server.stop();
    }
  });
});
