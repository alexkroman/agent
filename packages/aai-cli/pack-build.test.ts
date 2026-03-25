// Copyright 2025 the AAI authors. MIT license.
/**
 * Integration test: builds CLI + packs SDK tarballs, then for every template:
 *   1. aai init -> link -> build  (dev workflow: local source)
 *   2. unlink -> install tarballs -> build  (user workflow: published packages)
 *
 * Run via: pnpm test:integration
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, test } from "vitest";

const dir = import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname);
const packagesDir = path.resolve(dir, "..");
const templatesDir = path.join(dir, "templates");

const templates = fs
  .readdirSync(templatesDir, { withFileTypes: true })
  .filter((d) => d.isDirectory() && d.name !== "_shared")
  .map((d) => d.name);

let aaiBin: string;
let tmpDir: string;
let tarballs: Record<string, string>;

function aai(args: string[], cwd: string): void {
  execFileSync(process.execPath, [aaiBin, ...args], {
    cwd,
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
    stdio: "inherit",
  });
}

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

beforeAll(() => {
  // Build CLI
  execFileSync("npx", ["tsup", "--silent"], { cwd: dir, stdio: "inherit" });
  aaiBin = path.resolve(dir, "dist/cli.js");
  tmpDir = fs.mkdtempSync("/tmp/aai-build-test-");
  const tarballDir = path.join(tmpDir, "_tarballs");
  fs.mkdirSync(tarballDir);

  // Pack SDK packages into tarballs
  tarballs = {};
  for (const pkgDir of ["aai", "aai-ui"]) {
    const pkgPath = path.join(packagesDir, pkgDir);
    execFileSync("pnpm", ["run", "build"], { cwd: pkgPath, stdio: "inherit" });
    const output = execFileSync("npm", ["pack", "--pack-destination", tarballDir], {
      cwd: pkgPath,
      encoding: "utf-8",
    }).trim();
    const filename = output.split("\n").pop() ?? "";
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgPath, "package.json"), "utf-8"));
    tarballs[pkg.name] = path.join(tarballDir, filename);
  }
});

afterAll(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("pack + build: dev and user workflows", () => {
  test.each(templates)("template %s", (template) => {
    const projectDir = path.join(tmpDir, template);

    // Dev workflow: init -> link -> build
    aai(["init", projectDir, "-t", template, "--skip-api", "--skip-deploy"], tmpDir);
    aai(["link"], projectDir);
    aai(["build"], projectDir);

    // User workflow: unlink -> install tarballs -> build
    aai(["unlink"], projectDir);
    installFromTarballs(projectDir);
    aai(["build"], projectDir);
  });
});
