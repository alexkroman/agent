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
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

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

describe("e2e: init -> dev --check", () => {
  test.each(templates.map((t, i) => [t, i] as const))("template %s", (template, i) => {
    const projectDir = path.join(tmpDir, template);
    initProject(template, projectDir);
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
    const unlinkedPkg = JSON.parse(
      fs.readFileSync(path.join(projectDir, "package.json"), "utf-8"),
    );
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

    // Wait briefly for the config frame to arrive
    await page.waitForTimeout(1000);
    const configFrame = frames.find((f) => {
      try {
        return JSON.parse(f).type === "config";
      } catch {
        return false;
      }
    });
    expect(configFrame).toBeDefined();

    await page.close();
  });
}

describe("e2e: browser on build -> start", () => {
  let browser: Browser;
  let child: ChildProcess;
  const port = BASE_PORT + 200;

  beforeAll(async () => {
    const projectDir = path.join(tmpDir, "_browser-start");
    initProject("simple", projectDir);
    aai(["build"], projectDir);
    child = aaiSpawn(["start", "--port", String(port)], projectDir);
    await waitForHealth(`http://localhost:${port}/health`);
    browser = await chromium.launch();
  });

  afterAll(async () => {
    await browser?.close();
    child?.kill();
  });

  defineBrowserTests(() => ({ browser, port }));
});

describe("e2e: browser on dev server", () => {
  let browser: Browser;
  let child: ChildProcess;
  const port = BASE_PORT + 201;

  beforeAll(async () => {
    const projectDir = path.join(tmpDir, "_browser-dev");
    initProject("simple", projectDir);
    child = aaiSpawn(["dev", "--port", String(port)], projectDir);
    await waitForHealth(`http://localhost:${port}/health`);
    browser = await chromium.launch();
  });

  afterAll(async () => {
    await browser?.close();
    child?.kill();
  });

  defineBrowserTests(() => ({ browser, port }));
});
