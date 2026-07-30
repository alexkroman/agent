// Copyright 2026 the AAI authors. MIT license.
/**
 * Tests for the Modal sandbox backend: env-derived limits, WarmHarness
 * wiring over web streams, exit/cleanup semantics, and the spawn flow
 * against an injected ModalSpawnContext (no real Modal calls).
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  _internals,
  DEFAULT_SANDBOX_TIMEOUT_MS,
  type ModalProcLike,
  type ModalSandboxLike,
  type ModalSpawnContext,
  parseSandboxLimitsFromEnv,
  spawnModalWarm,
} from "./modal-sandbox.ts";

// ── Fakes ────────────────────────────────────────────────────────────────────

type FakeProc = {
  proc: ModalProcLike;
  /** Push a line (already newline-terminated) onto the guest's stdout. */
  pushStdout(text: string): void;
  closeStdout(): void;
  /** Everything the host wrote to the guest's stdin, decoded. */
  stdinText(): string;
  /** Settle proc.wait(). */
  exit(code: number): void;
};

function makeFakeProc(): FakeProc {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let stdoutController!: ReadableStreamDefaultController<Uint8Array>;
  const stdout = new ReadableStream<Uint8Array>({
    start(c) {
      stdoutController = c;
    },
  });
  const written: string[] = [];
  const stdin = new WritableStream<Uint8Array>({
    write(chunk) {
      written.push(decoder.decode(chunk));
    },
  });
  const stderr = new ReadableStream<Uint8Array>({
    start(c) {
      c.close();
    },
  });
  let resolveWait!: (code: number) => void;
  const waitPromise = new Promise<number>((resolve) => {
    resolveWait = resolve;
  });
  let stdoutClosed = false;
  return {
    proc: { stdin, stdout, stderr, wait: () => waitPromise },
    pushStdout: (text) => stdoutController.enqueue(encoder.encode(text)),
    closeStdout: () => {
      if (!stdoutClosed) {
        stdoutClosed = true;
        stdoutController.close();
      }
    },
    stdinText: () => written.join(""),
    exit: (code) => resolveWait(code),
  };
}

function makeFakeSandbox(fakeProc: FakeProc): ModalSandboxLike & {
  writtenFiles: Map<string, string>;
  execCalls: { command: string[]; params: unknown }[];
  terminate: ReturnType<typeof vi.fn>;
} {
  const writtenFiles = new Map<string, string>();
  const execCalls: { command: string[]; params: unknown }[] = [];
  return {
    sandboxId: "sb-test",
    writtenFiles,
    execCalls,
    filesystem: {
      writeText: async (text: string, path: string) => {
        writtenFiles.set(path, text);
      },
    },
    exec: async (command, params) => {
      execCalls.push({ command, params });
      return fakeProc.proc;
    },
    terminate: vi.fn().mockResolvedValue(undefined),
  };
}

async function makeHarnessFile(content = "// harness"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "aai-modal-test-"));
  const path = join(dir, "harness.mjs");
  await writeFile(path, content, "utf-8");
  return path;
}

beforeEach(() => {
  _internals.resetModalContext();
});

// ── parseSandboxLimitsFromEnv ────────────────────────────────────────────────

describe("parseSandboxLimitsFromEnv", () => {
  it("returns empty object when no env vars are set", () => {
    expect(parseSandboxLimitsFromEnv({})).toEqual({});
  });

  it("parses SANDBOX_MEMORY_LIMIT_MB", () => {
    expect(parseSandboxLimitsFromEnv({ SANDBOX_MEMORY_LIMIT_MB: "256" }).memoryLimitMiB).toBe(256);
  });

  it("clamps SANDBOX_MEMORY_LIMIT_MB to [128, 4096]", () => {
    expect(parseSandboxLimitsFromEnv({ SANDBOX_MEMORY_LIMIT_MB: "1" }).memoryLimitMiB).toBe(128);
    expect(parseSandboxLimitsFromEnv({ SANDBOX_MEMORY_LIMIT_MB: "99999" }).memoryLimitMiB).toBe(
      4096,
    );
  });

  it("parses and clamps SANDBOX_CPU_LIMIT to [0.125, 16]", () => {
    expect(parseSandboxLimitsFromEnv({ SANDBOX_CPU_LIMIT: "2" }).cpuLimit).toBe(2);
    expect(parseSandboxLimitsFromEnv({ SANDBOX_CPU_LIMIT: "0.01" }).cpuLimit).toBe(0.125);
    expect(parseSandboxLimitsFromEnv({ SANDBOX_CPU_LIMIT: "64" }).cpuLimit).toBe(16);
  });

  it("parses SANDBOX_TIMEOUT_SECS into milliseconds, clamped to [300, 86400] secs", () => {
    expect(parseSandboxLimitsFromEnv({ SANDBOX_TIMEOUT_SECS: "3600" }).timeoutMs).toBe(3_600_000);
    expect(parseSandboxLimitsFromEnv({ SANDBOX_TIMEOUT_SECS: "1" }).timeoutMs).toBe(300_000);
    expect(parseSandboxLimitsFromEnv({ SANDBOX_TIMEOUT_SECS: "999999" }).timeoutMs).toBe(
      86_400_000,
    );
  });

  it("ignores non-numeric and undefined values", () => {
    expect(
      parseSandboxLimitsFromEnv({
        SANDBOX_MEMORY_LIMIT_MB: "not-a-number",
        SANDBOX_CPU_LIMIT: undefined,
      }),
    ).toEqual({});
  });
});

// ── warmFromModal ────────────────────────────────────────────────────────────

describe("warmFromModal", () => {
  it("carries JSON-RPC requests and responses over the exec streams", async () => {
    const fake = makeFakeProc();
    const sb = makeFakeSandbox(fake);
    const warm = _internals.warmFromModal(sb, fake.proc);
    warm.conn.listen();

    const pending = warm.conn.sendRequest<{ pong: boolean }>("ping", { n: 1 });
    await vi.waitFor(() => {
      if (!fake.stdinText().includes('"ping"')) throw new Error("request not written yet");
    });
    const req = JSON.parse(
      fake
        .stdinText()
        .split("\n")
        .find((l) => l.includes('"ping"')) ?? "",
    );
    expect(req.params).toEqual({ n: 1 });

    fake.pushStdout(`${JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { pong: true } })}\n`);
    await expect(pending).resolves.toEqual({ pong: true });

    warm.conn.dispose();
  });

  it("notifies exit listeners once when the guest process ends", async () => {
    const fake = makeFakeProc();
    const warm = _internals.warmFromModal(makeFakeSandbox(fake), fake.proc);
    const exits: string[] = [];
    warm.onExit(() => exits.push("exit"));

    expect(warm.alive()).toBe(true);
    fake.exit(1);
    await vi.waitFor(() => {
      if (warm.alive()) throw new Error("still alive");
    });
    expect(exits).toEqual(["exit"]);
  });

  it("cleanup terminates the sandbox, marks the harness dead, and is memoized", async () => {
    const fake = makeFakeProc();
    const sb = makeFakeSandbox(fake);
    const warm = _internals.warmFromModal(sb, fake.proc);

    const p1 = warm.cleanup();
    const p2 = warm.cleanup();
    expect(p2).toBe(p1);
    await p1;

    expect(sb.terminate).toHaveBeenCalledTimes(1);
    expect(warm.alive()).toBe(false);
  });

  it("cleanup swallows terminate failures (sandbox already gone)", async () => {
    const fake = makeFakeProc();
    const sb = makeFakeSandbox(fake);
    sb.terminate.mockRejectedValue(new Error("sandbox not found"));
    const warm = _internals.warmFromModal(sb, fake.proc);
    await expect(warm.cleanup()).resolves.toBeUndefined();
  });

  it("rejects pending requests when the guest's stdout closes", async () => {
    const fake = makeFakeProc();
    const warm = _internals.warmFromModal(makeFakeSandbox(fake), fake.proc);
    warm.conn.listen();
    const pending = warm.conn.sendRequest("ping");
    await vi.waitFor(() => {
      if (!fake.stdinText().includes('"ping"')) throw new Error("request not written yet");
    });
    fake.closeStdout();
    await expect(pending).rejects.toThrow(/Connection closed/);
  });
});

// ── spawnModalWarm ───────────────────────────────────────────────────────────

describe("spawnModalWarm", () => {
  it("creates a network-blocked sandbox, writes the harness, and execs deno", async () => {
    const fake = makeFakeProc();
    const sb = makeFakeSandbox(fake);
    const createParams: unknown[] = [];
    const ctx: ModalSpawnContext = {
      createSandbox: async (params) => {
        createParams.push(params);
        return sb;
      },
    };
    const harnessPath = await makeHarnessFile("// the harness code");

    const warm = await spawnModalWarm({ harnessPath, slug: "my-agent" }, ctx);

    expect(createParams).toHaveLength(1);
    expect(createParams[0]).toMatchObject({
      blockNetwork: true,
      timeoutMs: DEFAULT_SANDBOX_TIMEOUT_MS,
      tags: { service: "aai-guest", slug: "my-agent" },
    });
    expect([...sb.writtenFiles.values()]).toEqual(["// the harness code"]);
    expect(sb.execCalls).toHaveLength(1);
    const { command, params } = sb.execCalls[0] as { command: string[]; params: unknown };
    expect(command[0]).toBe("deno");
    expect(command).toContain("--no-prompt");
    expect(command.filter((a) => a.startsWith("--allow"))).toEqual([]);
    expect(command.at(-1)).toBe([...sb.writtenFiles.keys()][0]);
    expect(params).toMatchObject({ mode: "binary", stdout: "pipe", stderr: "pipe" });
    expect(warm.alive()).toBe(true);
    await warm.cleanup();
  });

  it("terminates the sandbox when harness setup fails, and wraps the error", async () => {
    const fake = makeFakeProc();
    const sb = makeFakeSandbox(fake);
    sb.filesystem.writeText = vi.fn().mockRejectedValue(new Error("fs boom"));
    const ctx: ModalSpawnContext = { createSandbox: async () => sb };
    const harnessPath = await makeHarnessFile();

    await expect(spawnModalWarm({ harnessPath }, ctx)).rejects.toThrow(
      /Modal sandbox spawn failed: fs boom/,
    );
    expect(sb.terminate).toHaveBeenCalled();
  });

  it("reads the harness file once and reuses it across spawns", async () => {
    const harnessPath = await makeHarnessFile("// v1");
    const spawnOnce = async (): Promise<string> => {
      const fake = makeFakeProc();
      const sb = makeFakeSandbox(fake);
      const warm = await spawnModalWarm({ harnessPath }, { createSandbox: async () => sb });
      await warm.cleanup();
      return [...sb.writtenFiles.values()][0] ?? "";
    };
    expect(await spawnOnce()).toBe("// v1");
    await writeFile(harnessPath, "// v2", "utf-8");
    // Cached: the harness is stable per process, so v1 is still shipped.
    expect(await spawnOnce()).toBe("// v1");
  });

  it("propagates a missing harness file as a spawn failure", async () => {
    const fake = makeFakeProc();
    const sb = makeFakeSandbox(fake);
    const ctx: ModalSpawnContext = { createSandbox: async () => sb };
    await expect(spawnModalWarm({ harnessPath: "/nonexistent/harness.mjs" }, ctx)).rejects.toThrow(
      /ENOENT/,
    );
    // The harness is read before any sandbox is created — nothing to leak.
    expect(sb.execCalls).toHaveLength(0);
  });
});
