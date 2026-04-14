// Copyright 2025 the AAI authors. MIT license.
/**
 * Docker build test for the aai-server Dockerfile.
 *
 * Verifies that the multi-stage production image builds successfully
 * from the repo root context.
 *
 * Run via: pnpm --filter aai-server test:docker
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

  test("container starts and health endpoint responds", () => {
    // Start container in background
    const containerId = execFileSync(
      "docker",
      [
        "run",
        "-d",
        "--rm",
        "-p",
        "0:8080",
        "-e",
        "AAI_API_KEY=test-key",
        "-e",
        "ALLOWED_ORIGINS=*",
        imageName,
      ],
      { encoding: "utf-8", timeout: 10_000 },
    ).trim();

    try {
      // Find the mapped port
      const portOutput = execFileSync("docker", ["port", containerId, "8080"], {
        encoding: "utf-8",
        timeout: 5000,
      }).trim();
      const port = portOutput.split(":").pop();

      // Wait for health endpoint (up to 10s)
      let healthy = false;
      for (let i = 0; i < 20; i++) {
        try {
          const res = execFileSync("curl", ["-sf", `http://localhost:${port}/health`], {
            encoding: "utf-8",
            timeout: 2000,
          });
          if (res.includes('"ok"')) {
            healthy = true;
            break;
          }
        } catch {
          execFileSync("sleep", ["0.5"]);
        }
      }
      expect(healthy).toBe(true);
    } finally {
      execFileSync("docker", ["kill", containerId], {
        stdio: "ignore",
        timeout: 10_000,
      });
    }
  });

  test("GUEST_HARNESS_PATH points to an existing file", () => {
    // Extract the configured harness path from the image's env
    const inspectOut = execFileSync("docker", ["image", "inspect", imageName], {
      encoding: "utf-8",
      timeout: 10_000,
    });
    const env: string[] = JSON.parse(inspectOut)[0].Config.Env;
    const harnessEntry = env.find((e: string) => e.startsWith("GUEST_HARNESS_PATH="));
    expect(harnessEntry).toBeDefined();
    const harnessPath = harnessEntry?.split("=")[1];
    expect(harnessPath).toBeTruthy();

    // Distroless has no shell — use node to check the file exists.
    // The distroless nodejs image uses /nodejs/bin/node as entrypoint,
    // so we pass a -e script as the CMD.
    execFileSync(
      "docker",
      [
        "run",
        "--rm",
        "--entrypoint",
        "",
        imageName,
        "/nodejs/bin/node",
        "-e",
        `require("fs").accessSync(${JSON.stringify(harnessPath)})`,
      ],
      { timeout: 30_000 },
    );
  });
});
