// Copyright 2025 the AAI authors. MIT license.
/**
 * Unit tests that verify the security-critical spawn arguments used by
 * `createGvisorSandbox()`. These run everywhere (macOS, Linux, CI) by
 * mocking child_process.spawn, so regressions in sandbox flags are
 * caught immediately — no Docker or gVisor required.
 */

import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import type { Readable, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async (importOriginal) => {
  const orig = await importOriginal<typeof import("node:child_process")>();
  return {
    ...orig,
    spawn: vi.fn(),
    execFileSync: vi.fn((cmd: string, args: string[]) => {
      // Stub `which runsc` and `which deno` to return paths
      if (cmd === "which" && args[0] === "runsc") return "/usr/local/bin/runsc\n";
      if (cmd === "which" && args[0] === "deno") return "/usr/local/bin/deno\n";
      throw new Error(`unexpected execFileSync: ${cmd} ${args.join(" ")}`);
    }),
  };
});

// Force platform to linux so isGvisorAvailable() returns true
const originalPlatform = process.platform;

function makeFakeProcess(): ChildProcess {
  const proc = new EventEmitter() as ChildProcess;
  proc.stdin = { write: vi.fn(), end: vi.fn() } as unknown as Writable;
  proc.stdout = new EventEmitter() as unknown as Readable;
  proc.stderr = new EventEmitter() as unknown as Readable;
  proc.kill = vi.fn();
  Object.defineProperty(proc, "pid", { value: 12_345, writable: true });
  Object.defineProperty(proc, "exitCode", { value: null, writable: true });
  return proc;
}

describe("createGvisorSandbox spawn arguments", () => {
  beforeEach(() => {
    Object.defineProperty(process, "platform", { value: "linux", writable: true });
    vi.mocked(spawn).mockReturnValue(makeFakeProcess());

    // Clear cached paths from prior runs — gvisor.ts caches findRunsc/findDeno
    vi.resetModules();
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform, writable: true });
    vi.restoreAllMocks();
  });

  async function getSpawnArgs(): Promise<{
    cmd: string;
    args: string[];
    opts: SpawnOptions;
  }> {
    // Dynamic import so module-level caches re-evaluate per test
    const mod = await import("./gvisor.ts");
    const callsBefore = vi.mocked(spawn).mock.calls.length;
    mod.createGvisorSandbox({ slug: "test-agent", harnessPath: "/app/harness.mjs" });

    const call = vi.mocked(spawn).mock.calls[callsBefore];
    if (!call) throw new Error("spawn was not called");
    const [cmd, args, opts] = call;
    return { cmd: cmd as string, args: args as string[], opts: opts as SpawnOptions };
  }

  it("uses runsc binary", async () => {
    const { cmd } = await getSpawnArgs();
    expect(cmd).toBe("/usr/local/bin/runsc");
  });

  it("passes --network=none to disable all networking", async () => {
    const { args } = await getSpawnArgs();
    expect(args).toContain("--network=none");
  });

  it("passes --rootless for unprivileged execution", async () => {
    const { args } = await getSpawnArgs();
    expect(args).toContain("--rootless");
  });

  it("passes --ignore-cgroups for cgroup v1/v2 compatibility", async () => {
    const { args } = await getSpawnArgs();
    expect(args).toContain("--ignore-cgroups");
  });

  it("sets CWD to /tmp, not host directory", async () => {
    const { args } = await getSpawnArgs();
    const cwdIdx = args.indexOf("-cwd");
    expect(cwdIdx).toBeGreaterThan(-1);
    expect(args[cwdIdx + 1]).toBe("/tmp");
  });

  it("runs Deno with --allow-env --no-prompt (no net/fs/run)", async () => {
    const { args } = await getSpawnArgs();
    expect(args).toContain("--allow-env");
    expect(args).toContain("--no-prompt");
    // These dangerous permissions must NOT be present
    expect(args).not.toContain("--allow-net");
    expect(args).not.toContain("--allow-read");
    expect(args).not.toContain("--allow-write");
    expect(args).not.toContain("--allow-run");
    expect(args).not.toContain("--allow-all");
    expect(args).not.toContain("-A");
  });

  it("passes the harness path as the script argument", async () => {
    const { args } = await getSpawnArgs();
    expect(args).toContain("/app/harness.mjs");
  });

  it("spawns with empty env to prevent host secret leakage", async () => {
    const { opts } = await getSpawnArgs();
    expect(opts.env).toEqual({});
  });

  it("uses stdio pipes for NDJSON communication", async () => {
    const { opts } = await getSpawnArgs();
    expect(opts.stdio).toEqual(["pipe", "pipe", "pipe"]);
  });

  it("includes -quiet flag to suppress runsc noise on stdout", async () => {
    const { args } = await getSpawnArgs();
    expect(args).toContain("-quiet");
  });
});
