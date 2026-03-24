// Copyright 2025 the AAI authors. MIT license.
/**
 * End-to-end test: builds CLI, then for every template:
 *   init -> link -> dev --check (builds, starts server, hits /health, exits)
 *
 * Run via: pnpm test:e2e
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, test } from "vitest";

const dir = import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname);
const templatesDir = path.join(dir, "templates");

const templates = fs
  .readdirSync(templatesDir, { withFileTypes: true })
  .filter((d) => d.isDirectory() && d.name !== "_shared")
  .map((d) => d.name);

let aaiBin: string;
let tmpDir: string;
const BASE_PORT = 4567;

function aai(args: string[], cwd: string, timeoutMs = 120_000): void {
  execFileSync(process.execPath, [aaiBin, ...args], {
    cwd,
    env: {
      ...process.env,
      NO_COLOR: "1",
      FORCE_COLOR: "0",
      ASSEMBLYAI_API_KEY: process.env.ASSEMBLYAI_API_KEY || "test",
    },
    stdio: "inherit",
    timeout: timeoutMs,
  });
}

beforeAll(() => {
  execFileSync("npx", ["tsup", "--silent"], { cwd: dir, stdio: "inherit" });
  aaiBin = path.resolve(dir, "dist/cli.js");
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
