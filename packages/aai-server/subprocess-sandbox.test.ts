// Copyright 2026 the AAI authors. MIT license.
/**
 * Tests for the subprocess sandbox backend: the `node` invocation contract
 * (above all the minimal env, which is the parity guarantee this backend
 * lives or dies on) and the spawn flow against an injected
 * SubprocessSpawnContext, so no real harness is ever started.
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createFakeGuestSocket, type FakeGuestSocket } from "./_sandbox-vm-test-utils.ts";
import {
  _internals,
  buildHarnessSpawn,
  type HarnessProcLike,
  type HarnessSpawnParams,
  type SubprocessSpawnContext,
  spawnSubprocessWarm,
} from "./subprocess-sandbox.ts";

// ── Fakes ────────────────────────────────────────────────────────────────────

type FakeProc = {
  proc: HarnessProcLike;
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

function makeCtx(fake: FakeProc): SubprocessSpawnContext & { runs: HarnessSpawnParams[] } {
  const runs: HarnessSpawnParams[] = [];
  return {
    runs,
    runGuestProcess(params) {
      runs.push(params);
      return fake.proc;
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
  const dir = await mkdtemp(join(tmpdir(), "aai-subprocess-test-"));
  const path = join(dir, "harness.mjs");
  await writeFile(path, content, "utf-8");
  return path;
}

const BASE_PARAMS: HarnessSpawnParams = {
  harnessPath: "/tmp/harness.mjs",
  port: 41_234,
  token: "tok",
};

// ── buildHarnessSpawn ────────────────────────────────────────────────────────

describe("buildHarnessSpawn", () => {
  it("passes the token and port, and binds loopback", () => {
    const { env } = buildHarnessSpawn(BASE_PARAMS);
    expect(env.AAI_GUEST_TOKEN).toBe("tok");
    expect(env.AAI_GUEST_PORT).toBe("41234");
    // The session endpoint is auth-free; without a container namespace around
    // it, binding 0.0.0.0 would publish it to the whole local network.
    expect(env.AAI_GUEST_HOST).toBe("127.0.0.1");
  });

  it("withholds the host environment from the guest", () => {
    // The parity guarantee: production delivers the guest no host env at all
    // (agent env arrives as bundle/load params). Inheriting process.env here
    // would both hand tenant code the platform's credentials and let agent
    // code that wrongly reads process.env pass locally and fail in prod.
    vi.stubEnv("SUPABASE_DB_URL", "postgres://platform-secret");
    vi.stubEnv("MODAL_TOKEN_SECRET", "modal-secret");
    vi.stubEnv("ASSEMBLYAI_API_KEY", "assembly-secret");
    try {
      const { env } = buildHarnessSpawn(BASE_PARAMS);
      expect(Object.keys(env).toSorted()).toEqual([
        "AAI_GUEST_HOST",
        "AAI_GUEST_PORT",
        "AAI_GUEST_TOKEN",
        "PATH",
      ]);
      expect(Object.values(env).join(" ")).not.toMatch(/secret/);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("does not run the guest in the server's working directory", () => {
    expect(buildHarnessSpawn(BASE_PARAMS).cwd).toBe(tmpdir());
    expect(buildHarnessSpawn(BASE_PARAMS).cwd).not.toBe(process.cwd());
  });

  it("maps a memory limit onto the V8 heap cap, and omits it when unset", () => {
    expect(buildHarnessSpawn({ ...BASE_PARAMS, memoryLimitMiB: 512 }).execArgv).toEqual([
      "--max-old-space-size=512",
    ]);
    expect(buildHarnessSpawn(BASE_PARAMS).execArgv).toEqual([]);
  });
});

// ── spawnSubprocessWarm ──────────────────────────────────────────────────────

describe("spawnSubprocessWarm", () => {
  it("runs the harness and dials the port it bound", async () => {
    const fake = makeFakeProc();
    const ctx = makeCtx(fake);
    const socket = createFakeGuestSocket();
    const { dial, calls } = makeFakeDial(socket);
    const harnessPath = await makeHarnessFile();

    const warm = await spawnSubprocessWarm({ harnessPath, slug: "demo" }, ctx, dial);

    expect(ctx.runs).toHaveLength(1);
    const run = ctx.runs[0];
    expect(run?.harnessPath).toBe(harnessPath);
    // Control channel and session endpoint share the one bound port, exactly
    // as they share the tunnel on the containerized backends.
    expect(calls[0]?.url).toBe(`ws://127.0.0.1:${run?.port}/ws`);
    expect(calls[0]?.token).toBe(run?.token);
    expect(warm.sessionUrl).toBe(`ws://127.0.0.1:${run?.port}/websocket`);
    expect(warm.alive()).toBe(true);
    await warm.cleanup();
  });

  it("mints a distinct token and port per spawn", async () => {
    const harnessPath = await makeHarnessFile();
    const spawnOne = async () => {
      const fake = makeFakeProc();
      const ctx = makeCtx(fake);
      const { dial } = makeFakeDial(createFakeGuestSocket());
      const warm = await spawnSubprocessWarm({ harnessPath }, ctx, dial);
      await warm.cleanup();
      return ctx.runs[0];
    };
    const [a, b] = await Promise.all([spawnOne(), spawnOne()]);
    expect(a?.token).not.toBe(b?.token);
    expect(a?.token).toHaveLength(64);
    expect(a?.port).not.toBe(b?.port);
  });

  it("marks the harness dead when the child process exits", async () => {
    const fake = makeFakeProc();
    const ctx = makeCtx(fake);
    const { dial } = makeFakeDial(createFakeGuestSocket());
    const harnessPath = await makeHarnessFile();
    const warm = await spawnSubprocessWarm({ harnessPath }, ctx, dial);

    const onExit = vi.fn();
    warm.onExit(onExit);
    expect(warm.alive()).toBe(true);

    fake.exit(1);
    await vi.waitFor(() => expect(warm.alive()).toBe(false));
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it("honors SANDBOX_MEMORY_LIMIT_MB", async () => {
    vi.stubEnv("SANDBOX_MEMORY_LIMIT_MB", "256");
    try {
      const fake = makeFakeProc();
      const ctx = makeCtx(fake);
      const { dial } = makeFakeDial(createFakeGuestSocket());
      const harnessPath = await makeHarnessFile();
      const warm = await spawnSubprocessWarm({ harnessPath }, ctx, dial);
      expect(ctx.runs[0]).toMatchObject({ memoryLimitMiB: 256 });
      await warm.cleanup();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("kills the harness when the dial fails, and wraps the error", async () => {
    const fake = makeFakeProc();
    const ctx = makeCtx(fake);
    const harnessPath = await makeHarnessFile();
    const dial = vi.fn().mockRejectedValue(new Error("guest never came up"));

    await expect(spawnSubprocessWarm({ harnessPath }, ctx, dial)).rejects.toThrow(
      /Subprocess sandbox spawn failed: guest never came up/,
    );
    expect(fake.kill).toHaveBeenCalled();
  });

  it("reports a missing harness build by path, without spawning anything", async () => {
    // Otherwise this arrives as a 30s dial timeout against a process that
    // exited immediately — the failure mode that motivated this backend.
    const fake = makeFakeProc();
    const ctx = makeCtx(fake);
    const { dial } = makeFakeDial(createFakeGuestSocket());
    await expect(
      spawnSubprocessWarm({ harnessPath: "/nonexistent/harness.mjs" }, ctx, dial),
    ).rejects.toThrow(/Subprocess sandbox spawn failed.*nonexistent\/harness\.mjs/s);
    expect(ctx.runs).toHaveLength(0);
  });

  it("cleanup is memoized: one kill for concurrent callers", async () => {
    const fake = makeFakeProc();
    const ctx = makeCtx(fake);
    const { dial } = makeFakeDial(createFakeGuestSocket());
    const harnessPath = await makeHarnessFile();
    const warm = await spawnSubprocessWarm({ harnessPath }, ctx, dial);

    const p1 = warm.cleanup();
    const p2 = warm.cleanup();
    expect(p2).toBe(p1);
    await p1;
    expect(fake.kill).toHaveBeenCalledTimes(1);
    expect(warm.alive()).toBe(false);
  });

  it("asyncDispose notifies the guest, disposes the connection, and kills the child", async () => {
    const fake = makeFakeProc();
    const ctx = makeCtx(fake);
    const socket = createFakeGuestSocket();
    const { dial } = makeFakeDial(socket);
    const harnessPath = await makeHarnessFile();
    const warm = await spawnSubprocessWarm({ harnessPath }, ctx, dial);

    await warm[Symbol.asyncDispose]();
    expect(socket.sentMessages().some((m) => m.method === "shutdown")).toBe(true);
    expect(fake.kill).toHaveBeenCalled();
    expect(warm.alive()).toBe(false);
  });
});

// ── The real child-process context ───────────────────────────────────────────
// Exercised against a binary that resolves nowhere, so the error paths run
// without starting a real harness.

describe("realContext", () => {
  it("settles wait() and tolerates kill() when the binary is missing", async () => {
    const ctx = _internals.realContext("aai-test-no-such-node-binary");
    const proc = ctx.runGuestProcess(BASE_PARAMS);
    await expect(proc.wait()).resolves.toBe(-1);
    expect(() => proc.kill()).not.toThrow();
    // The pipes exist even though the process never ran; draining them ends.
    await expect(proc.stdout.getReader().read()).resolves.toMatchObject({ done: true });
    await expect(proc.stderr.getReader().read()).resolves.toMatchObject({ done: true });
  });
});
