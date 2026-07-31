// Copyright 2026 the AAI authors. MIT license.
/**
 * Tests for the Apple container sandbox backend: backend selection
 * (SANDBOX_BACKEND override + the developer-mode auto-detection), the
 * `container run` argument contract, and the spawn flow against an injected
 * AppleContainerSpawnContext (the real CLI is never invoked).
 */

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createFakeGuestSocket, type FakeGuestSocket } from "./_sandbox-vm-test-utils.ts";
import {
  _internals,
  type AppleContainerRunParams,
  type AppleContainerSpawnContext,
  type BackendProbe,
  buildContainerRunArgs,
  type ContainerProcLike,
  isAppleContainerCliAvailable,
  resolveSandboxBackend,
  spawnAppleContainerWarm,
} from "./apple-container-sandbox.ts";
import { GUEST_PORT } from "./modal-sandbox.ts";

// ── Fakes ────────────────────────────────────────────────────────────────────

function probe(platform: NodeJS.Platform, hasCli: boolean): BackendProbe {
  return { platform, hasContainerCli: () => hasCli };
}

/** Env shape where local dev is on (no SUPABASE_S3_ENDPOINT). */
const DEV_ENV: NodeJS.ProcessEnv = {};
const PROD_ENV: NodeJS.ProcessEnv = { SUPABASE_S3_ENDPOINT: "https://s3.example" };

type FakeProc = {
  proc: ContainerProcLike;
  kill: ReturnType<typeof vi.fn>;
  exit(code: number): void;
};

function makeFakeProc(): FakeProc {
  const emptyStream = (): ReadableStream<Uint8Array> =>
    new ReadableStream<Uint8Array>({
      start(c) {
        c.close();
      },
    });
  let resolveWait!: (code: number) => void;
  const waitPromise = new Promise<number>((resolve) => {
    resolveWait = resolve;
  });
  const kill = vi.fn();
  return {
    proc: { stdout: emptyStream(), stderr: emptyStream(), wait: () => waitPromise, kill },
    kill,
    exit: (code) => resolveWait(code),
  };
}

function makeCtx(fake: FakeProc): AppleContainerSpawnContext & {
  runs: AppleContainerRunParams[];
  stops: string[];
} {
  const runs: AppleContainerRunParams[] = [];
  const stops: string[] = [];
  return {
    runs,
    stops,
    runGuestContainer(params) {
      runs.push(params);
      return fake.proc;
    },
    async stopGuestContainer(name) {
      stops.push(name);
    },
  };
}

/** A dial fn resolving to a fake guest socket, recording its arguments. */
function makeFakeDial(socket: FakeGuestSocket) {
  const calls: { url: string; token: string }[] = [];
  const dial = async (url: string, token: string) => {
    calls.push({ url, token });
    return socket.ws;
  };
  return { dial, calls };
}

async function makeHarnessFile(content = "// harness"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "aai-apple-test-"));
  const path = join(dir, "harness.mjs");
  await writeFile(path, content, "utf-8");
  return path;
}

// ── resolveSandboxBackend ────────────────────────────────────────────────────

describe("resolveSandboxBackend", () => {
  it("honors an explicit SANDBOX_BACKEND override in both directions", () => {
    // Apple container forced even off-macOS / in prod-shaped envs.
    expect(
      resolveSandboxBackend(
        { ...PROD_ENV, SANDBOX_BACKEND: "apple-container" },
        probe("linux", false),
      ),
    ).toBe("apple-container");
    // Modal forced even where auto-detection would pick Apple containers.
    expect(resolveSandboxBackend({ SANDBOX_BACKEND: "modal" }, probe("darwin", true))).toBe(
      "modal",
    );
  });

  it("normalizes SANDBOX_BACKEND whitespace and case", () => {
    expect(
      resolveSandboxBackend({ SANDBOX_BACKEND: " Apple-Container " }, probe("linux", false)),
    ).toBe("apple-container");
  });

  it("throws on an unknown SANDBOX_BACKEND instead of silently using Modal", () => {
    expect(() =>
      resolveSandboxBackend({ SANDBOX_BACKEND: "docker" }, probe("darwin", true)),
    ).toThrow(/Unknown SANDBOX_BACKEND "docker"/);
  });

  it("auto-selects apple-container only for local dev on darwin with the CLI", () => {
    expect(resolveSandboxBackend(DEV_ENV, probe("darwin", true))).toBe("apple-container");
    expect(resolveSandboxBackend(DEV_ENV, probe("darwin", false))).toBe("modal");
    expect(resolveSandboxBackend(DEV_ENV, probe("linux", true))).toBe("modal");
  });

  it("never auto-selects apple-container in production", () => {
    expect(resolveSandboxBackend(PROD_ENV, probe("darwin", true))).toBe("modal");
  });

  it("treats AAI_LOCAL_DEV=1 as local dev even with storage configured", () => {
    expect(resolveSandboxBackend({ ...PROD_ENV, AAI_LOCAL_DEV: "1" }, probe("darwin", true))).toBe(
      "apple-container",
    );
  });
});

// ── buildContainerRunArgs ────────────────────────────────────────────────────

describe("buildContainerRunArgs", () => {
  const base: AppleContainerRunParams = {
    name: "aai-guest-abc123",
    image: "node:24-slim",
    hostPort: 40_123,
    env: { AAI_GUEST_TOKEN: "tok", AAI_GUEST_PORT: "8080" },
    harnessDir: "/tmp/aai-guest-xyz",
  };

  it("runs attached with --rm, a loopback publish, and the mounted harness", () => {
    expect(buildContainerRunArgs(base)).toEqual([
      "run",
      "--rm",
      "--name",
      "aai-guest-abc123",
      "--volume",
      "/tmp/aai-guest-xyz:/aai-guest",
      "--publish",
      `127.0.0.1:40123:${GUEST_PORT}`,
      "--env",
      "AAI_GUEST_TOKEN=tok",
      "--env",
      "AAI_GUEST_PORT=8080",
      "node:24-slim",
      "node",
      "/aai-guest/harness.mjs",
    ]);
  });

  it("appends memory/cpu limits only when set", () => {
    const args = buildContainerRunArgs({ ...base, memoryLimitMiB: 512, cpuLimit: 2 });
    expect(args).toContain("--memory");
    expect(args[args.indexOf("--memory") + 1]).toBe("512M");
    expect(args).toContain("--cpus");
    expect(args[args.indexOf("--cpus") + 1]).toBe("2");
    // The image must stay last-before-command regardless of limits.
    expect(args.slice(-3)).toEqual(["node:24-slim", "node", "/aai-guest/harness.mjs"]);
  });
});

// ── spawnAppleContainerWarm ──────────────────────────────────────────────────

describe("spawnAppleContainerWarm", () => {
  it("copies the harness, runs the container, and dials the published port", async () => {
    const fake = makeFakeProc();
    const ctx = makeCtx(fake);
    const socket = createFakeGuestSocket();
    const { dial, calls } = makeFakeDial(socket);
    const harnessPath = await makeHarnessFile("// the harness code");

    const warm = await spawnAppleContainerWarm({ harnessPath, slug: "my-agent" }, ctx, dial);

    expect(ctx.runs).toHaveLength(1);
    const run = ctx.runs[0] as AppleContainerRunParams;
    expect(run.image).toBe("node:24-slim");
    expect(run.env.AAI_GUEST_PORT).toBe(String(GUEST_PORT));
    expect(run.env.AAI_GUEST_TOKEN).toMatch(/^[0-9a-f]{64}$/);
    // Per-spawn temp copy, never the source dist dir.
    expect(run.harnessDir).not.toBe(dirname(harnessPath));
    await expect(readFile(join(run.harnessDir, "harness.mjs"), "utf-8")).resolves.toBe(
      "// the harness code",
    );

    // The dial went to the published loopback port with the minted token.
    expect(calls).toEqual([
      { url: `ws://127.0.0.1:${run.hostPort}/ws`, token: run.env.AAI_GUEST_TOKEN },
    ]);
    expect(warm.sessionUrl).toBe(`ws://127.0.0.1:${run.hostPort}/websocket`);

    expect(warm.alive()).toBe(true);
    await warm.cleanup();
    expect(ctx.stops).toEqual([run.name]);
    expect(fake.kill).toHaveBeenCalled();
  });

  it("mints a distinct token and container name per spawn", async () => {
    const harnessPath = await makeHarnessFile();
    const spawnOnce = async (): Promise<{ token: string; name: string }> => {
      const fake = makeFakeProc();
      const ctx = makeCtx(fake);
      const socket = createFakeGuestSocket();
      const { dial } = makeFakeDial(socket);
      const warm = await spawnAppleContainerWarm({ harnessPath }, ctx, dial);
      await warm.cleanup();
      const run = ctx.runs[0] as AppleContainerRunParams;
      return { token: run.env.AAI_GUEST_TOKEN as string, name: run.name };
    };
    const a = await spawnOnce();
    const b = await spawnOnce();
    expect(a.token).not.toBe(b.token);
    expect(a.name).not.toBe(b.name);
  });

  it("marks the harness dead when the container process exits", async () => {
    const fake = makeFakeProc();
    const ctx = makeCtx(fake);
    const socket = createFakeGuestSocket();
    const { dial } = makeFakeDial(socket);
    const harnessPath = await makeHarnessFile();

    const warm = await spawnAppleContainerWarm({ harnessPath }, ctx, dial);
    const exits: string[] = [];
    warm.onExit(() => exits.push("exit"));
    expect(warm.alive()).toBe(true);
    fake.exit(0);
    await vi.waitFor(() => {
      if (warm.alive()) throw new Error("still alive");
    });
    expect(exits).toEqual(["exit"]);
  });

  it("honors APPLE_CONTAINER_IMAGE and SANDBOX_MEMORY_LIMIT_MB/SANDBOX_CPU_LIMIT", async () => {
    vi.stubEnv("APPLE_CONTAINER_IMAGE", "node:22-slim");
    vi.stubEnv("SANDBOX_MEMORY_LIMIT_MB", "256");
    vi.stubEnv("SANDBOX_CPU_LIMIT", "2");
    try {
      const fake = makeFakeProc();
      const ctx = makeCtx(fake);
      const socket = createFakeGuestSocket();
      const { dial } = makeFakeDial(socket);
      const harnessPath = await makeHarnessFile();
      const warm = await spawnAppleContainerWarm({ harnessPath }, ctx, dial);
      expect(ctx.runs[0]).toMatchObject({
        image: "node:22-slim",
        memoryLimitMiB: 256,
        cpuLimit: 2,
      });
      await warm.cleanup();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("stops the container when the dial fails, and wraps the error", async () => {
    const fake = makeFakeProc();
    const ctx = makeCtx(fake);
    const harnessPath = await makeHarnessFile();
    const dial = vi.fn().mockRejectedValue(new Error("guest never came up"));

    await expect(spawnAppleContainerWarm({ harnessPath }, ctx, dial)).rejects.toThrow(
      /Apple container sandbox spawn failed: guest never came up/,
    );
    expect(ctx.stops).toHaveLength(1);
    expect(fake.kill).toHaveBeenCalled();
  });

  it("propagates a missing harness file as a spawn failure without running anything", async () => {
    const fake = makeFakeProc();
    const ctx = makeCtx(fake);
    const socket = createFakeGuestSocket();
    const { dial } = makeFakeDial(socket);
    await expect(
      spawnAppleContainerWarm({ harnessPath: "/nonexistent/harness.mjs" }, ctx, dial),
    ).rejects.toThrow(/ENOENT/);
    expect(ctx.runs).toHaveLength(0);
    expect(ctx.stops).toHaveLength(0);
  });

  it("cleanup is memoized: one stop for concurrent callers", async () => {
    const fake = makeFakeProc();
    const ctx = makeCtx(fake);
    const socket = createFakeGuestSocket();
    const { dial } = makeFakeDial(socket);
    const harnessPath = await makeHarnessFile();
    const warm = await spawnAppleContainerWarm({ harnessPath }, ctx, dial);

    const p1 = warm.cleanup();
    const p2 = warm.cleanup();
    expect(p2).toBe(p1);
    await p1;
    expect(ctx.stops).toHaveLength(1);
    expect(warm.alive()).toBe(false);
  });

  it("asyncDispose notifies the guest, disposes the connection, and stops the container", async () => {
    const fake = makeFakeProc();
    const ctx = makeCtx(fake);
    const socket = createFakeGuestSocket();
    const { dial } = makeFakeDial(socket);
    const harnessPath = await makeHarnessFile();
    const warm = await spawnAppleContainerWarm({ harnessPath }, ctx, dial);

    await warm[Symbol.asyncDispose]();
    expect(socket.sentMessages().some((m) => m.method === "shutdown")).toBe(true);
    expect(ctx.stops).toHaveLength(1);
    expect(warm.alive()).toBe(false);
  });
});

// ── The real CLI context ─────────────────────────────────────────────────────
// Exercised against a binary name that resolves nowhere, so the error paths
// run everywhere without ever invoking a real `container` CLI (which a
// contributor's macOS machine might actually have).

describe("realContext", () => {
  const NO_SUCH_BINARY = "aai-test-no-such-container-cli";

  it("settles wait() and tolerates kill() when the CLI is missing", async () => {
    const ctx = _internals.realContext(NO_SUCH_BINARY);
    const proc = ctx.runGuestContainer({
      name: "aai-guest-test",
      image: "node:24-slim",
      hostPort: 1,
      env: { AAI_GUEST_TOKEN: "tok" },
      harnessDir: "/tmp/nowhere",
    });
    await expect(proc.wait()).resolves.toBe(-1);
    expect(() => proc.kill()).not.toThrow();
    // The pipes exist even though the process never ran; draining them ends.
    await expect(proc.stdout.getReader().read()).resolves.toMatchObject({ done: true });
    await expect(proc.stderr.getReader().read()).resolves.toMatchObject({ done: true });
  });

  it("stopGuestContainer resolves best-effort when the CLI is missing", async () => {
    const ctx = _internals.realContext(NO_SUCH_BINARY);
    await expect(ctx.stopGuestContainer("aai-guest-test")).resolves.toBeUndefined();
  });
});

// ── CLI probe ────────────────────────────────────────────────────────────────

describe("isAppleContainerCliAvailable", () => {
  it("answers a boolean and memoizes it", () => {
    _internals.resetCliProbe();
    const first = isAppleContainerCliAvailable();
    expect(typeof first).toBe("boolean");
    expect(isAppleContainerCliAvailable()).toBe(first);
    _internals.resetCliProbe();
  });
});
