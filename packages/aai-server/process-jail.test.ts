// Copyright 2025 the AAI authors. MIT license.
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { buildJailConfig, type JailOptions } from "./jail-config.ts";
import { createJailedLauncher, isJailAvailable } from "./process-jail.ts";
import { buildSeccompPolicy } from "./seccomp-policy.ts";

describe("buildSeccompPolicy", () => {
  test("generates ALLOW block with syscalls", () => {
    const policy = buildSeccompPolicy();
    expect(policy).toContain("ALLOW");
    expect(policy).toContain("read");
    expect(policy).toContain("write");
    expect(policy).toContain("mmap");
  });

  test("sets default action to KILL", () => {
    const policy = buildSeccompPolicy();
    expect(policy).toContain("DEFAULT KILL");
  });
});

const TEST_OPTIONS: JailOptions = {
  binaryPath: "/usr/local/bin/secure-exec-v8",
  socketDir: "/tmp/aai-abc123",
  memoryLimitMb: 256,
  sandboxId: "abc123",
};

describe("buildJailConfig", () => {
  test("sets mode to ONCE", () => {
    const config = buildJailConfig(TEST_OPTIONS);
    expect(config).toContain("mode: ONCE");
  });

  test("bind-mounts binary read-only", () => {
    const config = buildJailConfig(TEST_OPTIONS);
    expect(config).toContain('src: "/usr/local/bin/secure-exec-v8"');
    expect(config).toContain("rw: false");
  });

  test("bind-mounts socket dir read-write", () => {
    const config = buildJailConfig(TEST_OPTIONS);
    expect(config).toContain('src: "/tmp/aai-abc123"');
  });

  test("enables all namespace types", () => {
    const config = buildJailConfig(TEST_OPTIONS);
    expect(config).toContain("clone_newnet: true");
    expect(config).toContain("clone_newpid: true");
    expect(config).toContain("clone_newns: true");
    expect(config).toContain("clone_newuser: true");
  });

  test("sets memory cgroup limit", () => {
    const config = buildJailConfig(TEST_OPTIONS);
    expect(config).toContain("cgroup_mem_max: 268435456");
  });

  test("sets PID limit to 1", () => {
    const config = buildJailConfig(TEST_OPTIONS);
    expect(config).toContain("cgroup_pids_max: 1");
  });

  test("passes required env vars through", () => {
    const config = buildJailConfig(TEST_OPTIONS);
    expect(config).toContain('envar: "SECURE_EXEC_V8_TOKEN"');
  });

  test("drops all capabilities", () => {
    const config = buildJailConfig(TEST_OPTIONS);
    expect(config).toContain("keep_caps: false");
  });

  test("includes seccomp policy", () => {
    const config = buildJailConfig(TEST_OPTIONS);
    expect(config).toContain("seccomp_string:");
  });
});

describe("isJailAvailable", () => {
  test("returns false on non-linux platforms", () => {
    if (process.platform === "linux") return;
    expect(isJailAvailable()).toBe(false);
  });
});

describe("createJailedLauncher", () => {
  test("writes wrapper script and config to temp dir", async () => {
    if (process.platform !== "linux") return;

    const socketDir = await fs.mkdtemp(path.join(os.tmpdir(), "aai-jail-test-"));
    try {
      const launcher = await createJailedLauncher({
        binaryPath: "/usr/bin/true",
        socketDir,
        memoryLimitMb: 256,
        sandboxId: "test01",
      });

      expect(launcher.binaryPath).toContain("aai-jail-test01");
      expect(existsSync(launcher.binaryPath)).toBe(true);

      const script = await fs.readFile(launcher.binaryPath, "utf-8");
      expect(script).toContain("#!/bin/sh");
      expect(script).toContain("nsjail");
      expect(script).toContain("jail.cfg");

      await launcher.cleanup();
      expect(existsSync(launcher.binaryPath)).toBe(false);
    } finally {
      await fs.rm(socketDir, { recursive: true, force: true });
    }
  });
});
