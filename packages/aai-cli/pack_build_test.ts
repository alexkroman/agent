// Copyright 2025 the AAI authors. MIT license.
//
// Integration test: builds CLI, then runs `aai init → link → build → unlink → build`
// for every template. Run via: pnpm test:integration

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const dir = import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname);
const templatesDir = path.join(dir, "templates");

const templates = fs
  .readdirSync(templatesDir, { withFileTypes: true })
  .filter((d) => d.isDirectory() && d.name !== "_shared")
  .map((d) => d.name);

// Build CLI once, then use dist/cli.js directly for all tests
execFileSync("npx", ["tsup", "--silent"], { cwd: dir, stdio: "inherit" });
const aaiBin = path.resolve(dir, "dist/cli.js");

function aai(args: string[], cwd: string): void {
  execFileSync(process.execPath, [aaiBin, ...args], {
    cwd,
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
    stdio: "inherit",
  });
}

const tmpDir = fs.mkdtempSync("/tmp/aai-build-test-");
let passed = 0;
const failed: string[] = [];

try {
  for (const template of templates) {
    const projectDir = path.join(tmpDir, template);
    process.stdout.write(`${template}... `);
    try {
      aai(["init", projectDir, "-t", template, "--skip-api", "--skip-deploy"], tmpDir);
      aai(["link"], projectDir);
      aai(["build"], projectDir);
      aai(["unlink"], projectDir);
      aai(["build"], projectDir);
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
