// Copyright 2025 the AAI authors. MIT license.
/**
 * Docker build test for the scaffold Dockerfile (packages/aai-templates/scaffold/Dockerfile).
 *
 * Assembles a scaffolded project from the "simple" template, starts a local
 * npm registry (Verdaccio) with workspace packages published, then runs
 * `docker build --network=host` so the Dockerfile can `npm install` from
 * the local registry.
 *
 * Run via: pnpm --filter @alexkroman1/aai-cli test:docker
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { MockRegistry } from "./_mock-registry.ts";

const dir = import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname);
const packagesDir = path.resolve(dir, "..");
const scaffoldDir = path.resolve(packagesDir, "aai-templates/scaffold");
const templateDir = path.resolve(packagesDir, "aai-templates/templates/simple");

const imageName = "aai-scaffold-build-test";

let tmpDir: string;
let registry: MockRegistry;

function dockerReady(): boolean {
  try {
    // Check daemon is running
    execFileSync("docker", ["info"], { stdio: "ignore", timeout: 10_000 });
    // Check we can reach the Docker registry (need network access to pull base images)
    execFileSync("docker", ["pull", "node:22-slim"], {
      stdio: "ignore",
      timeout: 60_000,
    });
    return true;
  } catch {
    return false;
  }
}

/** Copy all files from src into dest (non-recursive merge, no overwrite). */
function copyDir(src: string, dest: string): void {
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(destPath, { recursive: true });
      copyDir(srcPath, destPath);
    } else if (!fs.existsSync(destPath)) {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

describe.runIf(dockerReady())("scaffold Dockerfile", () => {
  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aai-docker-scaffold-"));
    const projectDir = path.join(tmpDir, "project");
    fs.mkdirSync(projectDir);

    // Layer scaffold base files, then template files on top
    copyDir(scaffoldDir, projectDir);
    copyDir(templateDir, projectDir);

    // Rewrite @alexkroman1/* versions to the mock registry's test version
    const { startMockRegistry } = await import("./_mock-registry.ts");
    registry = await startMockRegistry(packagesDir, ["aai", "aai-ui", "aai-cli"]);

    const pkgJsonPath = path.join(projectDir, "package.json");
    const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"));
    for (const depField of ["dependencies", "devDependencies"] as const) {
      if (!pkgJson[depField]) continue;
      for (const dep of Object.keys(pkgJson[depField])) {
        if (dep.startsWith("@alexkroman1/")) {
          pkgJson[depField][dep] = registry.testVersion;
        }
      }
    }
    // Use npm (matches scaffold Dockerfile)
    delete pkgJson.packageManager;
    fs.writeFileSync(pkgJsonPath, `${JSON.stringify(pkgJson, null, 2)}\n`);

    // Write .npmrc pointing to the local registry so `npm install` inside
    // the Docker build resolves @alexkroman1/* packages from Verdaccio
    const registryUrl = registry.registryUrl;
    fs.writeFileSync(path.join(projectDir, ".npmrc"), `registry=${registryUrl}\n`);
  }, 120_000);

  afterAll(async () => {
    try {
      execFileSync("docker", ["rmi", "-f", imageName], {
        stdio: "ignore",
        timeout: 30_000,
      });
    } catch {
      // ignore
    }
    await registry?.stop();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("builds successfully", () => {
    const projectDir = path.join(tmpDir, "project");

    execFileSync("docker", ["build", "--network=host", "-t", imageName, "."], {
      cwd: projectDir,
      stdio: "inherit",
      timeout: 600_000, // 10 minutes
    });

    // Verify the image was created and exposes port 8080
    const output = execFileSync("docker", ["image", "inspect", imageName], {
      encoding: "utf-8",
      timeout: 10_000,
    });
    const inspected = JSON.parse(output);
    expect(inspected).toHaveLength(1);
    expect(inspected[0].Config.ExposedPorts).toHaveProperty("8080/tcp");
  });
});
