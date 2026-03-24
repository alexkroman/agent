// Copyright 2025 the AAI authors. MIT license.
/**
 * End-to-end test: builds CLI, then for every template:
 *   init -> link -> dev --check (builds, starts server, hits /health, exits)
 *
 * Run via: pnpm test:e2e
 */
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
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

const aaiEnv = {
  ...process.env,
  NO_COLOR: "1",
  FORCE_COLOR: "0",
  ASSEMBLYAI_API_KEY: process.env.ASSEMBLYAI_API_KEY || "test",
};

function aai(args: string[], cwd: string, timeoutMs = 120_000): void {
  execFileSync(process.execPath, [aaiBin, ...args], {
    cwd,
    env: aaiEnv,
    stdio: "inherit",
    timeout: timeoutMs,
  });
}

function aaiSpawn(args: string[], cwd: string): ChildProcess {
  return spawn(process.execPath, [aaiBin, ...args], {
    cwd,
    env: aaiEnv,
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

describe("e2e: init -> link -> dev --check", () => {
  test.each(templates.map((t, i) => [t, i] as const))("template %s", (template, i) => {
    const projectDir = path.join(tmpDir, template);
    aai(["init", projectDir, "-t", template, "--skip-api", "--skip-deploy"], tmpDir);
    aai(["link"], projectDir);
    aai(["dev", "--check", "--port", String(BASE_PORT + i)], projectDir);
  });
});

describe("e2e: build produces output files", () => {
  test("init -> link -> build writes .aai/build and .aai/client", () => {
    const projectDir = path.join(tmpDir, "_build-test");
    aai(["init", projectDir, "-t", "simple", "--skip-api", "--skip-deploy"], tmpDir);
    aai(["link"], projectDir);
    aai(["build"], projectDir);

    expect(fs.existsSync(path.join(projectDir, ".aai", "build", "worker.js"))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, ".aai", "client", "index.html"))).toBe(true);
  });
});

describe("e2e: build -> start serves health", () => {
  test("start responds to /health after build", async () => {
    const projectDir = path.join(tmpDir, "_start-test");
    const port = BASE_PORT + 100;
    aai(["init", projectDir, "-t", "simple", "--skip-api", "--skip-deploy"], tmpDir);
    aai(["link"], projectDir);
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
  test("init -> link -> deploy --dry-run succeeds without a server", () => {
    const projectDir = path.join(tmpDir, "_deploy-dry-test");
    aai(["init", projectDir, "-t", "simple", "--skip-api", "--skip-deploy"], tmpDir);
    aai(["link"], projectDir);
    aai(["deploy", "--dry-run"], projectDir);
  });
});

describe("e2e: unlink reverses link", () => {
  test("link adds file: deps, unlink restores them", () => {
    const projectDir = path.join(tmpDir, "_unlink-test");
    aai(["init", projectDir, "-t", "simple", "--skip-api", "--skip-deploy"], tmpDir);
    aai(["link"], projectDir);

    const linkedPkg = JSON.parse(fs.readFileSync(path.join(projectDir, "package.json"), "utf-8"));
    const linkedDeps: Record<string, string> = linkedPkg.dependencies ?? {};
    expect(Object.values(linkedDeps).some((v) => v.startsWith("file:"))).toBe(true);

    aai(["unlink"], projectDir);

    const unlinkedPkg = JSON.parse(
      fs.readFileSync(path.join(projectDir, "package.json"), "utf-8"),
    );
    const unlinkedDeps: Record<string, string> = unlinkedPkg.dependencies ?? {};
    expect(Object.values(unlinkedDeps).some((v) => v.startsWith("file:"))).toBe(false);
  });
});
