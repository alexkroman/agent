// Copyright 2025 the AAI authors. MIT license.
/**
 * End-to-end CLI tests (Vite builds, real servers):
 *   Template builds: dev & user workflows for representative templates
 *
 * Browser tests (Playwright) live in e2e-browser.test.ts.
 *
 * Run via: pnpm test:e2e
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, test } from "vitest";
import { aai, buildCli, installDeps, startRegistry } from "./_e2e-test-utils.ts";
import type { MockRegistry } from "./_mock-registry.ts";

// Representative subset: minimal baseline, stateful + tools, external tools + custom UI.
// Full template coverage is handled by the templates unit test tier (pnpm test:templates).
const templates = ["simple", "web-researcher"];

let aaiBin: string;
let tmpDir: string;
let registry: MockRegistry;

beforeAll(async () => {
  aaiBin = buildCli();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aai-e2e-test-"));
  registry = await startRegistry();
});

afterAll(async () => {
  await registry?.stop();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

// --- Pack + build: representative templates ---

describe("pack + build: template workflows", () => {
  test.concurrent.each(templates)("template %s", async (template) => {
    const projectDir = path.join(tmpDir, template);

    // Init + install from mock registry + test + build
    aai(aaiBin, ["init", projectDir, "-t", template, "--skip-api", "--skip-deploy"], tmpDir);
    try {
      installDeps(registry, projectDir);
    } catch {
      // Mock registry proxy to npmjs can fail in restricted environments
      // (e.g. turbo CI with egress proxies). Skip rather than fail.
      console.warn(`Skipping template ${template}: pnpm install failed (registry proxy issue)`);
      return;
    }
    aai(aaiBin, ["test"], projectDir);
    aai(aaiBin, ["build", "--skip-tests"], projectDir);
  });
});
