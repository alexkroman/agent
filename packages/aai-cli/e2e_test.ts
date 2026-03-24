// Copyright 2025 the AAI authors. MIT license.
//
// End-to-end test: builds CLI, then for every template:
//   init → link → dev --check (builds, starts server, hits /health, exits)
//
// Run via: pnpm test:e2e

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const dir = import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname);
const templatesDir = path.join(dir, "templates");

const templates = fs
  .readdirSync(templatesDir, { withFileTypes: true })
  .filter((d) => d.isDirectory() && d.name !== "_shared")
  .map((d) => d.name);

// Build CLI once
execFileSync("npx", ["tsup", "--silent"], { cwd: dir, stdio: "inherit" });
const aaiBin = path.resolve(dir, "dist/cli.js");

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

const tmpDir = fs.mkdtempSync("/tmp/aai-e2e-test-");
const BASE_PORT = 4567;

let passed = 0;
const failed: string[] = [];

try {
  for (let i = 0; i < templates.length; i++) {
    const template = templates[i] as string;
    const projectDir = path.join(tmpDir, template);
    process.stdout.write(`${template}... `);
    try {
      aai(["init", projectDir, "-t", template, "--skip-api", "--skip-deploy"], tmpDir);
      aai(["link"], projectDir);
      aai(["dev", "--check", "--port", String(BASE_PORT + i)], projectDir);

      console.log("ok");
      passed++;
    } catch {
      console.log("FAILED");
      failed.push(template);
    }
  }
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log(`\n${passed}/${templates.length} passed`);
if (failed.length > 0) {
  console.error(`Failed: ${failed.join(", ")}`);
  process.exit(1);
}
