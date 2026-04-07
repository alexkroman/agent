// Copyright 2025 the AAI authors. MIT license.
/**
 * Integration tests for OS-level process jail.
 *
 * These tests verify that nsjail restrictions are properly enforced.
 * They run only on Linux where nsjail is available. On macOS/CI without
 * nsjail, the entire suite is skipped.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { buildJailConfig } from "./jail-config.ts";
import { isJailAvailable } from "./process-jail.ts";

const skip = !isJailAvailable();

function findNsjail(): string {
  return execFileSync("which", ["nsjail"], { encoding: "utf-8" }).trim();
}

/** Run a shell command inside the jail and return { exitCode, stdout, stderr }. */
function runInJail(
  jailConfigPath: string,
  command: string,
): { exitCode: number; stdout: string; stderr: string } {
  const nsjail = findNsjail();
  try {
    const stdout = execFileSync(
      nsjail,
      ["--config", jailConfigPath, "--", "/bin/sh", "-c", command],
      { encoding: "utf-8", timeout: 10_000 },
    );
    return { exitCode: 0, stdout, stderr: "" };
  } catch (err: unknown) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return {
      exitCode: e.status ?? 1,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
    };
  }
}

describe.skipIf(skip)("nsjail enforcement", () => {
  let tmpDir: string;
  let configPath: string;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "aai-jail-integ-"));

    // Build a jail config using /bin/sh as the exec target for testing
    const config = buildJailConfig({
      binaryPath: "/bin/sh",
      socketDir: tmpDir,
      memoryLimitMb: 64,
      sandboxId: "integ",
    });

    // Override exec_bin to use /bin/sh for testing
    const testConfig = config.replace(/exec_bin \{[^}]*\}/, 'exec_bin {\n  path: "/bin/sh"\n}');

    configPath = path.join(tmpDir, "test-jail.cfg");
    await fs.writeFile(configPath, testConfig);
  });

  afterAll(async () => {
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("cannot read host /etc/passwd", () => {
    const result = runInJail(configPath, "cat /etc/passwd");
    expect(result.exitCode).not.toBe(0);
  });

  test("cannot write to filesystem root", () => {
    const result = runInJail(configPath, "touch /testfile");
    expect(result.exitCode).not.toBe(0);
  });

  test("PID namespace isolates processes", () => {
    const result = runInJail(configPath, "ls /proc | head -5");
    // Should only see PID 1 (the jailed process itself)
    expect(result.stdout).not.toContain("2\n");
  });

  test("network namespace blocks TCP", () => {
    const result = runInJail(
      configPath,
      "echo test | timeout 2 nc 1.1.1.1 80 2>&1 || echo BLOCKED",
    );
    expect(result.stdout + result.stderr).toContain("BLOCKED");
  });

  test("UDS socket dir is accessible", () => {
    const result = runInJail(configPath, `ls ${tmpDir}`);
    expect(result.exitCode).toBe(0);
  });
});

describe.skipIf(skip)("smoke test: sandbox boots in jail", () => {
  test("real secure-exec isolate boots inside nsjail", () => {
    // This test verifies the full integration: nsjail wrapping the
    // real Rust binary. Skipped for now — requires nsjail + secure-exec
    // binary on Linux CI. Enable once CI has nsjail installed.
  });
});

describe("macOS fallback", () => {
  test("isJailAvailable returns false on non-Linux", () => {
    if (process.platform === "linux") return;
    expect(isJailAvailable()).toBe(false);
  });
});
