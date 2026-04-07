// Copyright 2025 the AAI authors. MIT license.
/**
 * Docker build test for the aai-server Dockerfile.
 *
 * Verifies that the multi-stage production image builds successfully
 * from the repo root context.
 *
 * Run via: pnpm --filter @alexkroman1/aai-server test:docker
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { afterAll, describe, expect, test } from "vitest";

const repoRoot = path.resolve(import.meta.dirname ?? ".", "../..");
const dockerfile = path.resolve(import.meta.dirname ?? ".", "Dockerfile");
const imageName = "aai-server-build-test";

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

describe.runIf(dockerReady())("aai-server Dockerfile", () => {
  afterAll(() => {
    try {
      execFileSync("docker", ["rmi", "-f", imageName], {
        stdio: "ignore",
        timeout: 30_000,
      });
    } catch {
      // image may not exist if test failed before build completed
    }
  });

  test("builds successfully", () => {
    execFileSync("docker", ["build", "-f", dockerfile, "-t", imageName, "."], {
      cwd: repoRoot,
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
