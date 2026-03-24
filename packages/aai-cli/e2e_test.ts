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
