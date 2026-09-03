// Copyright 2026 the AAI authors. MIT license.
/**
 * Playwright scaffolding for the browser half of `e2e.test.ts`.
 *
 * Split out of that file for the 700-line test cap, and along a seam it
 * already had (`// --- Browser tests (Playwright) ---`): everything here is
 * setup, and nothing here is a test.
 *
 * The SUITES deliberately did NOT move with it. `e2e.test.ts`'s header
 * records why — the CLI build and the mock-registry publish mutate shared
 * state (`packages/aai-cli/dist`, workspace `package.json` versions), so the
 * one `beforeAll` must run exactly once per e2e run and never once per file,
 * and vitest runs files concurrently. A second `e2e*.test.ts` would run that
 * setup twice, in parallel, against the same working tree.
 */

import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { sleep } from "@alexkroman1/aai/internal";
import type { Browser } from "playwright";
import { chromium } from "playwright";
import { vi } from "vitest";

/**
 * Whether a Playwright chromium is installed — the precondition for every
 * `describe.skipIf` in the browser suites.
 *
 * A self-skip is how thirteen browser tests vanish while the job still reports
 * green: if a cache restore leaves a path `executablePath()` cannot resolve,
 * nothing anywhere says so. `AAI_REQUIRE_BROWSER` is the counterpart to
 * `AAI_REQUIRE_PG` / `_STACK` / `_REGISTRY` / `_EVAL` — set it and a missing
 * browser is a hard failure instead of a silent skip. Unset, the skip at least
 * ANNOUNCES itself.
 *
 * Memoized so the warning is printed once rather than once per suite.
 */
let browserProbe: boolean | undefined;
export function hasPlaywrightBrowser(): boolean {
  if (browserProbe !== undefined) return browserProbe;
  let found = false;
  try {
    found = fs.existsSync(chromium.executablePath());
  } catch {
    found = false;
  }
  if (found) {
    browserProbe = true;
    return true;
  }
  if (/^(1|true|yes|on)$/i.test(process.env.AAI_REQUIRE_BROWSER?.trim() ?? "")) {
    throw new Error(
      "AAI_REQUIRE_BROWSER is set but no Playwright chromium is installed, so every " +
        "browser suite would have SKIPPED and the job would have reported green. " +
        "Run `npx playwright install chromium`, or unset AAI_REQUIRE_BROWSER.",
    );
  }
  console.warn(
    "[e2e] no Playwright chromium found — SKIPPING every browser suite. " +
      "Set AAI_REQUIRE_BROWSER=1 to make this a failure instead.",
  );
  browserProbe = false;
  return false;
}

/** Set up a page with a WebSocket capture hook and event injector. */
export async function setupEventInjector(browser: Browser, port: number) {
  const page = await browser.newPage();

  await page.addInitScript(() => {
    const OrigWS = globalThis.WebSocket;
    class CapturingWebSocket extends OrigWS {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        (globalThis as Record<string, unknown>).__aai_test_ws = this;
      }
    }
    // `defineProperty` rather than an assignment: `globalThis.WebSocket` is
    // typed as the native constructor and a subclass is not assignable to it,
    // so a plain assignment needs a type-suppression comment. This does not.
    Object.defineProperty(globalThis, "WebSocket", {
      value: CapturingWebSocket,
      configurable: true,
      writable: true,
    });
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

  // The WebSocket reference the init script parks on `globalThis` is the
  // precondition every `inject()` below depends on. `vi.waitUntil`, which
  // THROWS on expiry, not the deadline loop this replaces: that loop simply
  // fell out of the `while` and carried on, so a regression in the init-script
  // hook surfaced as an opaque "ws is undefined" inside whichever of eleven
  // concurrent tests reported first. (`expect` is not an option here — this is
  // a helper, not a test body, and an assertion outside one reports against
  // the wrong test; Biome rejects it.)
  await vi.waitUntil(
    () => page.evaluate(() => Boolean((globalThis as Record<string, unknown>).__aai_test_ws)),
    { timeout: 10_000, interval: 50 },
  );
  // Wait for the session to settle after the config message. In headless
  // Chromium, initAudioCapture fails (no microphone), which sets state to
  // "error" asynchronously. If we inject events before that completes, the
  // audio error can overwrite test-driven state transitions.
  //
  // NOTE this is a precondition on a FAILURE: if capture ever degrades
  // gracefully rather than erroring, every fixture test blocks for the full
  // budget and then reports a locator timeout naming a state rather than the
  // cause. The message below is what makes that legible.
  await page
    .locator('[data-state="error"]')
    .waitFor({ timeout: 10_000 })
    .catch((err: unknown) => {
      throw new Error(
        'the session never reached data-state="error". These fixture tests rely on ' +
          "headless Chromium having no microphone, so initAudioCapture fails and the " +
          "session settles in `error` before events are injected. If capture now " +
          "degrades gracefully, this precondition needs replacing rather than waiting " +
          `out. Underlying: ${String(err)}`,
      );
    });

  /**
   * Inject a server->client event via the captured WebSocket.
   *
   * `meta` is STAMPED here rather than written into the fixtures, because that
   * is where it comes from in production: the server mints an event id when it
   * writes the event (`evt_` + a ULID) and the client only validates the
   * prefix. Freezing forty invented ids into six JSON files would read as data
   * the assertions care about, and none of them do — while a fixture that
   * omits `meta` is rejected by `SessionEventSchema` before any handler runs,
   * which is the shape of the failure this replaced.
   */
  let injected = 0;
  const inject = (msg: Record<string, unknown>) =>
    page.evaluate(
      (json) => {
        const ws = (globalThis as Record<string, unknown>).__aai_test_ws as WebSocket;
        ws.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(json) }));
      },
      { meta: { id: `evt_e2e${++injected}`, at: Date.now() }, ...msg },
    );

  /** Replay a fixture file (from aai-ui/fixtures/). */
  const replayFixture = async (fixtureName: string) => {
    // Anchored on THIS file rather than on an imported package root, so the
    // literal resolves the same way for a reader as it does at runtime —
    // `guard-invariants` rule 14 proves this directory has a reader by
    // resolving exactly this string against exactly this file.
    const fixturePath = path.resolve(import.meta.dirname, "../../aai-ui/src/fixtures", fixtureName);
    const messages = JSON.parse(fs.readFileSync(fixturePath, "utf-8")) as Record<string, unknown>[];
    for (const msg of messages) {
      // Skip the handshake frame: the test server already sent one on connect,
      // and re-injecting one re-runs initAudioCapture, whose async failure
      // (headless Chromium has no microphone) races later fixture events and
      // can overwrite state they set — e.g. the error-recovery banner.
      if (msg.type === "session.configured") continue;
      await inject(msg);
      await sleep(50);
    }
  };

  return { page, inject, replayFixture, clientFrames };
}

/**
 * Serve a built `.aai/client` over http, with a WebSocket server on the same
 * listener that answers `session.configured`.
 *
 * **A stub rather than `aai dev`, and that is the trade this file exists to
 * make.** It is what lets the fixture suites be deterministic: no live session
 * emits frames of its own, and `/__sever` cuts a socket without the server
 * going away. It is also faster than vite dev. The cost is that nothing here
 * exercises the real dev server — `e2e.test.ts` carries one test for that.
 *
 * Extracted from a `beforeAll` where it was 60 lines of embedded program in a
 * test file that had reached 99% of the 700-line cap. It is scaffolding, not a
 * test.
 */
export async function startStubClientServer(
  clientDir: string,
): Promise<{ child: ChildProcess; port: number }> {
  const child = spawn(
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
  const port = await new Promise<number>((resolve, reject) => {
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

  return { child, port };
}
