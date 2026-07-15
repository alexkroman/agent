// Copyright 2025 the AAI authors. MIT license.

import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  existsSync: vi.fn<(path: string) => boolean>(() => false),
  spawn: vi.fn(),
  execFile: vi.fn(),
  mkdir: vi.fn(async () => undefined),
  copyFile: vi.fn(async () => undefined),
  chmod: vi.fn(async () => undefined),
  writeFile: vi.fn(async (_path: string, _data: string) => undefined),
  rm: vi.fn(async () => undefined),
}));

vi.mock("node:fs", async (importOriginal) => {
  const orig = await importOriginal<typeof import("node:fs")>();
  return { ...orig, existsSync: (p: string) => mocks.existsSync(p) };
});
vi.mock("node:fs/promises", async (importOriginal) => {
  const orig = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...orig,
    mkdir: mocks.mkdir,
    copyFile: mocks.copyFile,
    chmod: mocks.chmod,
    writeFile: mocks.writeFile,
    rm: mocks.rm,
  };
});
vi.mock("node:child_process", async (importOriginal) => {
  const orig = await importOriginal<typeof import("node:child_process")>();
  return { ...orig, spawn: mocks.spawn, execFile: mocks.execFile };
});

type FakeChild = EventEmitter & { exitCode: number | null };

function makeFakeChild(exitCode: number | null = 0): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.exitCode = exitCode;
  return child;
}

/** Fresh module instance per test — defeats the binary + rootfs caches. */
async function loadGvisor() {
  vi.resetModules();
  return await import("./gvisor.ts");
}

const originalPlatform = process.platform;

function setPlatform(platform: string): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

beforeEach(() => {
  mocks.existsSync.mockReset().mockReturnValue(false);
  mocks.spawn.mockReset().mockReturnValue(makeFakeChild());
  // promisify() wraps the callback signature: (file, args, cb)
  mocks.execFile.mockReset().mockImplementation((...args: unknown[]) => {
    const cb = args.at(-1) as (err: unknown, stdout: string, stderr: string) => void;
    cb(null, "", "");
  });
  mocks.mkdir.mockClear();
  mocks.copyFile.mockClear();
  mocks.chmod.mockClear();
  mocks.writeFile.mockClear();
  mocks.rm.mockClear();
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  setPlatform("linux");
});

afterEach(() => {
  setPlatform(originalPlatform);
  vi.useRealTimers();
});

describe("isGvisorAvailable", () => {
  it("returns a boolean", async () => {
    const { isGvisorAvailable } = await loadGvisor();
    expect(typeof isGvisorAvailable()).toBe("boolean");
  });

  it("returns false on non-Linux platforms even when runsc exists", async () => {
    setPlatform("darwin");
    mocks.existsSync.mockReturnValue(true);
    const { isGvisorAvailable } = await loadGvisor();
    expect(isGvisorAvailable()).toBe(false);
  });

  it("returns true on Linux when runsc exists", async () => {
    mocks.existsSync.mockImplementation((p) => p === "/usr/local/bin/runsc");
    const { isGvisorAvailable } = await loadGvisor();
    expect(isGvisorAvailable()).toBe(true);
  });

  it("caches the runsc lookup", async () => {
    mocks.existsSync.mockReturnValue(true);
    const { isGvisorAvailable } = await loadGvisor();
    isGvisorAvailable();
    isGvisorAvailable();
    expect(mocks.existsSync).toHaveBeenCalledTimes(1);
  });
});

describe("prepareRootfs", () => {
  it("throws when deno is not installed", async () => {
    const { prepareRootfs } = await loadGvisor();
    await expect(prepareRootfs("/srv/harness.mjs")).rejects.toThrow("deno not found on PATH");
  });

  it("copies deno + harness once and reuses the cached rootfs", async () => {
    mocks.existsSync.mockImplementation((p) => p === "/usr/local/bin/deno");
    const { prepareRootfs } = await loadGvisor();
    const first = await prepareRootfs("/srv/harness.mjs");
    const second = await prepareRootfs("/srv/harness.mjs");
    expect(second).toBe(first);
    expect(mocks.copyFile).toHaveBeenCalledTimes(2); // deno + harness, once total
    expect(mocks.copyFile).toHaveBeenCalledWith(
      "/usr/local/bin/deno",
      expect.stringMatching(/\/deno$/),
    );
    expect(mocks.copyFile).toHaveBeenCalledWith(
      "/srv/harness.mjs",
      expect.stringMatching(/harness\.mjs$/),
    );
    expect(first.libMounts).toEqual([]);
  });

  it("resets the cache on failure so a retry can succeed", async () => {
    mocks.existsSync.mockImplementation((p) => p === "/usr/local/bin/deno");
    mocks.copyFile.mockRejectedValueOnce(new Error("disk full"));
    const { prepareRootfs, _resetRootfsCacheForTest } = await loadGvisor();
    _resetRootfsCacheForTest();
    await expect(prepareRootfs("/srv/harness.mjs")).rejects.toThrow("disk full");
    // The failed promise must not be cached — the retry should succeed.
    await expect(prepareRootfs("/srv/harness.mjs")).resolves.toMatchObject({
      libMounts: [],
    });
  });

  it("only bind-mounts host lib dirs that exist", async () => {
    mocks.existsSync.mockImplementation(
      (p) => p === "/usr/local/bin/deno" || p === "/lib" || p === "/usr/lib",
    );
    const { prepareRootfs } = await loadGvisor();
    const { libMounts } = await prepareRootfs("/srv/harness.mjs");
    expect(libMounts.map((m) => m.destination)).toEqual(["/lib", "/usr/lib"]);
    expect(libMounts.every((m) => m.options.includes("ro"))).toBe(true);
  });
});

describe("createGvisorSandbox", () => {
  function installAllBinaries(): void {
    mocks.existsSync.mockImplementation(
      (p) => p === "/usr/local/bin/runsc" || p === "/usr/local/bin/deno" || p === "/lib",
    );
  }

  it("throws when runsc is not installed", async () => {
    const { createGvisorSandbox } = await loadGvisor();
    await expect(
      createGvisorSandbox({ slug: "my-agent", harnessPath: "/srv/harness.mjs" }),
    ).rejects.toThrow("runsc not found on PATH");
  });

  it("spawns runsc with a bundled OCI spec and no host env", async () => {
    installAllBinaries();
    const { createGvisorSandbox } = await loadGvisor();
    const sandbox = await createGvisorSandbox({
      slug: "my-agent",
      harnessPath: "/srv/harness.mjs",
    });

    expect(sandbox.containerId).toMatch(/^aai-my-agent-/);

    // config.json written into the per-container bundle dir
    const [configPath, configJson] = mocks.writeFile.mock.calls[0] as [string, string];
    expect(configPath).toContain(sandbox.containerId);
    expect(configPath).toMatch(/config\.json$/);
    const spec = JSON.parse(configJson);
    // lib bind mounts from the prepared rootfs are appended to the spec
    expect(spec.mounts).toContainEqual({
      destination: "/lib",
      type: "bind",
      source: "/lib",
      options: ["ro"],
    });

    const [bin, args, opts] = mocks.spawn.mock.calls[0] as [
      string,
      string[],
      { env: Record<string, string> },
    ];
    expect(bin).toBe("/usr/local/bin/runsc");
    expect(args).toEqual([
      "--rootless",
      "--network=none",
      "--ignore-cgroups",
      "run",
      "--bundle",
      expect.stringContaining(sandbox.containerId),
      sandbox.containerId,
    ]);
    // Platform secrets must never leak into the sandbox process env.
    expect(opts.env).toEqual({});
  });

  test("cleanup kills, deletes, and removes the bundle dir exactly once", async () => {
    installAllBinaries();
    mocks.spawn.mockReturnValue(makeFakeChild(0)); // already exited
    const { createGvisorSandbox } = await loadGvisor();
    const sandbox = await createGvisorSandbox({ slug: "a", harnessPath: "/srv/harness.mjs" });

    await sandbox.cleanup();

    const runscCalls = mocks.execFile.mock.calls.map((c) => (c[1] as string[]).join(" "));
    expect(runscCalls).toContain(`kill ${sandbox.containerId} SIGTERM`);
    expect(runscCalls).toContain(`delete --force ${sandbox.containerId}`);
    expect(mocks.rm).toHaveBeenCalledWith(
      expect.stringContaining(sandbox.containerId),
      expect.objectContaining({ recursive: true, force: true }),
    );

    // Idempotent: a second cleanup is a no-op.
    const callsAfterFirst = mocks.execFile.mock.calls.length;
    await sandbox.cleanup();
    expect(mocks.execFile.mock.calls.length).toBe(callsAfterFirst);
  });

  test("cleanup escalates to SIGKILL when the process does not exit", async () => {
    vi.useFakeTimers();
    installAllBinaries();
    mocks.spawn.mockReturnValue(makeFakeChild(null)); // still running, never exits
    const { createGvisorSandbox } = await loadGvisor();
    const sandbox = await createGvisorSandbox({ slug: "a", harnessPath: "/srv/harness.mjs" });

    const done = sandbox.cleanup();
    await vi.advanceTimersByTimeAsync(5000); // SIGTERM wait expires
    await vi.advanceTimersByTimeAsync(2000); // SIGKILL wait expires
    await done;

    const runscCalls = mocks.execFile.mock.calls.map((c) => (c[1] as string[]).join(" "));
    expect(runscCalls).toContain(`kill ${sandbox.containerId} SIGTERM`);
    expect(runscCalls).toContain(`kill ${sandbox.containerId} SIGKILL`);
    expect(runscCalls).toContain(`delete --force ${sandbox.containerId}`);
  });

  test("cleanup skips SIGKILL once the child emits exit", async () => {
    installAllBinaries();
    const child = makeFakeChild(null);
    mocks.spawn.mockReturnValue(child);
    const { createGvisorSandbox } = await loadGvisor();
    const sandbox = await createGvisorSandbox({ slug: "a", harnessPath: "/srv/harness.mjs" });

    const done = sandbox.cleanup();
    // Yield so cleanup registers its exit listener before the child exits.
    await new Promise((resolve) => setImmediate(resolve));
    child.exitCode = 0;
    child.emit("exit", 0);
    await done;

    const runscCalls = mocks.execFile.mock.calls.map((c) => (c[1] as string[]).join(" "));
    expect(runscCalls).not.toContain(`kill ${sandbox.containerId} SIGKILL`);
    expect(runscCalls).toContain(`delete --force ${sandbox.containerId}`);
  });
});
