// Copyright 2025 the AAI authors. MIT license.
//
// Integration test: builds CLI + packs SDK tarballs, then for every template:
//   1. aai init → link → build  (dev workflow: local source)
//   2. unlink → install tarballs → build  (user workflow: published packages)
//
// Run via: pnpm test:integration

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const dir = import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname);
const packagesDir = path.resolve(dir, "..");
const templatesDir = path.join(dir, "templates");

const templates = fs
  .readdirSync(templatesDir, { withFileTypes: true })
  .filter((d) => d.isDirectory() && d.name !== "_shared")
  .map((d) => d.name);

// Build CLI once
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
const tarballDir = path.join(tmpDir, "_tarballs");
fs.mkdirSync(tarballDir);

// Build SDK packages and pack into tarballs (simulates what npm publish produces)
console.log("Packing workspace packages...");
const tarballs: Record<string, string> = {};
for (const pkgDir of ["aai", "aai-ui"]) {
  const pkgPath = path.join(packagesDir, pkgDir);
  // Build the package first (produces dist/)
  execFileSync("pnpm", ["run", "build"], { cwd: pkgPath, stdio: "inherit" });
  const output = execFileSync("npm", ["pack", "--pack-destination", tarballDir], {
    cwd: pkgPath,
    encoding: "utf-8",
  }).trim();
  const filename = output.split("\n").pop() ?? "";
  const pkg = JSON.parse(fs.readFileSync(path.join(pkgPath, "package.json"), "utf-8"));
  tarballs[pkg.name] = path.join(tarballDir, filename);
}
console.log(`Packed: ${Object.keys(tarballs).join(", ")}\n`);

/** Rewrite workspace deps in a project to use tarballs instead of * versions. */
function installFromTarballs(projectDir: string): void {
  const pkgJsonPath = path.join(projectDir, "package.json");
  const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"));
  const deps = pkgJson.dependencies ?? {};
  for (const [name, tarball] of Object.entries(tarballs)) {
    if (deps[name]) deps[name] = `file:${tarball}`;
  }
  fs.writeFileSync(pkgJsonPath, `${JSON.stringify(pkgJson, null, 2)}\n`);
  execFileSync("npm", ["install"], { cwd: projectDir, stdio: "inherit" });
}

let passed = 0;
const failed: string[] = [];

try {
  for (const template of templates) {
    const projectDir = path.join(tmpDir, template);
    process.stdout.write(`${template}... `);
    try {
      // Dev workflow: init → link to local source → build
      aai(["init", projectDir, "-t", template, "--skip-api", "--skip-deploy"], tmpDir);
      aai(["link"], projectDir);
      aai(["build"], projectDir);

      // User workflow: unlink → install from tarballs → build
      aai(["unlink"], projectDir);
      installFromTarballs(projectDir);
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
