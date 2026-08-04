// Copyright 2026 the AAI authors. MIT license.
/**
 * Tests for the Modal sandbox backend: env-derived limits, WarmHarness
 * wiring over the dialed guest WebSocket, exit/cleanup semantics, and the
 * spawn flow against an injected ModalSpawnContext (no real Modal calls).
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeGuestSocket, type FakeGuestSocket } from "./_sandbox-vm-test-utils.ts";
import {
  _internals,
  GUEST_PORT,
  type ModalProcLike,
  type ModalSandboxLike,
  type ModalSpawnContext,
  spawnModalWarm,
} from "./modal-sandbox.ts";
import {
  assertModalResourcePairs,
  DEFAULT_SANDBOX_IDLE_TIMEOUT_MS,
  DEFAULT_SANDBOX_TIMEOUT_MS,
  parseSandboxLimitsFromEnv,
  parseSandboxRegionsFromEnv,
} from "./modal-sandbox-env.ts";
import type { RpcConnection } from "./rpc-transport.ts";

// ── Fakes ────────────────────────────────────────────────────────────────────

type FakeProc = {
  proc: ModalProcLike;
  /** Push bytes onto the guest's stderr. */
  pushStderr(text: string): void;
  /** Settle proc.wait(). */
  exit(code: number): void;
};

function makeFakeProc(): FakeProc {
  const encoder = new TextEncoder();
  let stderrController!: ReadableStreamDefaultController<Uint8Array>;
  const stderr = new ReadableStream<Uint8Array>({
    start(c) {
      stderrController = c;
    },
  });
  const stdout = new ReadableStream<Uint8Array>({
    start(c) {
      c.close();
    },
  });
  let resolveWait!: (code: number) => void;
  const waitPromise = new Promise<number>((resolve) => {
    resolveWait = resolve;
  });
  return {
    proc: { stdout, stderr, wait: () => waitPromise },
    pushStderr: (text) => stderrController.enqueue(encoder.encode(text)),
    exit: (code) => resolveWait(code),
  };
}

function makeFakeSandbox(fakeProc: FakeProc): ModalSandboxLike & {
  execCalls: { command: string[]; params: Record<string, unknown> }[];
  updateNetworkPolicy: ReturnType<typeof vi.fn>;
  setTags: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn>;
} {
  const execCalls: { command: string[]; params: Record<string, unknown> }[] = [];
  return {
    sandboxId: "sb-test",
    execCalls,
    exec: async (command, params) => {
      execCalls.push({ command, params: params as unknown as Record<string, unknown> });
      return fakeProc.proc;
    },
    tunnels: async () => ({
      [GUEST_PORT]: { host: "tunnel.modal.test", port: 12_345 },
    }),
    updateNetworkPolicy: vi.fn().mockResolvedValue(undefined),
    setTags: vi.fn().mockResolvedValue(undefined),
    terminate: vi.fn().mockResolvedValue(undefined),
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
  const dir = await mkdtemp(join(tmpdir(), "aai-modal-test-"));
  const path = join(dir, "harness.mjs");
  await writeFile(path, content, "utf-8");
  return path;
}

function makeCtx(sb: ModalSandboxLike): ModalSpawnContext & { codes: string[] } {
  const codes: string[] = [];
  return {
    codes,
    createGuestSandbox: async (code, _params) => {
      codes.push(code);
      return sb;
    },
  };
}

beforeEach(() => {
  _internals.resetModalContext();
});

// ── parseSandboxLimitsFromEnv ────────────────────────────────────────────────

describe("parseSandboxLimitsFromEnv", () => {
  it("returns empty object when no env vars are set", () => {
    expect(parseSandboxLimitsFromEnv({})).toEqual({});
  });

  // Caps are read with their reservation alongside, as production sets them;
  // these exercise the clamp, not the pairing (covered separately below).
  const withMemCap = (mb: string) =>
    parseSandboxLimitsFromEnv({ SANDBOX_MEMORY_MB: "128", SANDBOX_MEMORY_LIMIT_MB: mb });
  const withCpuCap = (cores: string) =>
    parseSandboxLimitsFromEnv({ SANDBOX_CPU: "0.125", SANDBOX_CPU_LIMIT: cores });

  it("parses SANDBOX_MEMORY_LIMIT_MB", () => {
    expect(withMemCap("256").memoryLimitMiB).toBe(256);
  });

  it("clamps SANDBOX_MEMORY_LIMIT_MB to [128, 4096]", () => {
    expect(withMemCap("1").memoryLimitMiB).toBe(128);
    expect(withMemCap("99999").memoryLimitMiB).toBe(4096);
  });

  it("parses and clamps SANDBOX_CPU_LIMIT to [0.125, 16]", () => {
    expect(withCpuCap("2").cpuLimit).toBe(2);
    expect(withCpuCap("0.01").cpuLimit).toBe(0.125);
    expect(withCpuCap("64").cpuLimit).toBe(16);
  });

  it("clamps the reservation vars to the same bounds as their caps", () => {
    expect(parseSandboxLimitsFromEnv({ SANDBOX_MEMORY_MB: "1" }).memoryMiB).toBe(128);
    expect(parseSandboxLimitsFromEnv({ SANDBOX_MEMORY_MB: "99999" }).memoryMiB).toBe(4096);
    expect(parseSandboxLimitsFromEnv({ SANDBOX_CPU: "0.01" }).cpu).toBe(0.125);
    expect(parseSandboxLimitsFromEnv({ SANDBOX_CPU: "64" }).cpu).toBe(16);
  });

  it("passes a bare cap through — pairing is Modal's rule, not the parser's", () => {
    // The subprocess backend honors memoryLimitMiB alone and has nothing to
    // reserve, so the parser stays backend-agnostic; assertModalResourcePairs
    // (below) is what rejects a bare cap, at the Modal spawn.
    const limits = parseSandboxLimitsFromEnv({ SANDBOX_MEMORY_LIMIT_MB: "4096" });
    expect(limits).toEqual({ memoryLimitMiB: 4096 });
  });

  it("rejects a cap with no matching reservation, naming the env var to set", () => {
    // Modal fails creation on a bare cap either way; this names the variable.
    expect(() => assertModalResourcePairs({ memoryLimitMiB: 4096 })).toThrow(
      /SANDBOX_MEMORY_LIMIT_MB requires SANDBOX_MEMORY_MB/,
    );
    expect(() => assertModalResourcePairs({ cpuLimit: 4 })).toThrow(
      /SANDBOX_CPU_LIMIT requires SANDBOX_CPU/,
    );
    expect(() =>
      assertModalResourcePairs({ memoryMiB: 1024, memoryLimitMiB: 4096, cpu: 1, cpuLimit: 4 }),
    ).not.toThrow();
  });

  it("keeps a reservation below its cap — the burst range builds need", () => {
    // A guest idles as a voice session (~260 MB) and spikes to ~1.7 GB only
    // while rolldown bundles. Reserving the peak would bill every idle
    // sandbox for it; the cap is what has to clear the peak.
    const limits = parseSandboxLimitsFromEnv({
      SANDBOX_MEMORY_MB: "1024",
      SANDBOX_MEMORY_LIMIT_MB: "4096",
      SANDBOX_CPU: "1",
      SANDBOX_CPU_LIMIT: "4",
    });
    expect(limits).toMatchObject({ memoryMiB: 1024, memoryLimitMiB: 4096, cpu: 1, cpuLimit: 4 });
  });

  it("clamps a reservation that exceeds its cap (Modal rejects reservation > limit)", () => {
    const limits = parseSandboxLimitsFromEnv({
      SANDBOX_MEMORY_MB: "4096",
      SANDBOX_MEMORY_LIMIT_MB: "1024",
      SANDBOX_CPU: "8",
      SANDBOX_CPU_LIMIT: "2",
    });
    expect(limits).toMatchObject({ memoryMiB: 1024, memoryLimitMiB: 1024, cpu: 2, cpuLimit: 2 });
  });

  it("allows a bare reservation with no cap", () => {
    const limits = parseSandboxLimitsFromEnv({ SANDBOX_MEMORY_MB: "512", SANDBOX_CPU: "2" });
    expect(limits).toEqual({ memoryMiB: 512, cpu: 2 });
  });

  it("parses SANDBOX_TIMEOUT_SECS into milliseconds, clamped to [300, 86400] secs", () => {
    expect(parseSandboxLimitsFromEnv({ SANDBOX_TIMEOUT_SECS: "3600" }).timeoutMs).toBe(3_600_000);
    expect(parseSandboxLimitsFromEnv({ SANDBOX_TIMEOUT_SECS: "1" }).timeoutMs).toBe(300_000);
    expect(parseSandboxLimitsFromEnv({ SANDBOX_TIMEOUT_SECS: "999999" }).timeoutMs).toBe(
      86_400_000,
    );
  });

  it("parses SANDBOX_IDLE_TIMEOUT_SECS into milliseconds, clamped to [60, 86400] secs", () => {
    expect(parseSandboxLimitsFromEnv({ SANDBOX_IDLE_TIMEOUT_SECS: "600" }).idleTimeoutMs).toBe(
      600_000,
    );
    expect(parseSandboxLimitsFromEnv({ SANDBOX_IDLE_TIMEOUT_SECS: "1" }).idleTimeoutMs).toBe(
      60_000,
    );
    expect(parseSandboxLimitsFromEnv({ SANDBOX_IDLE_TIMEOUT_SECS: "999999" }).idleTimeoutMs).toBe(
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

// ── parseSandboxRegionsFromEnv ───────────────────────────────────────────────

describe("parseSandboxRegionsFromEnv", () => {
  it("returns undefined when MODAL_SANDBOX_REGION is unset or empty", () => {
    expect(parseSandboxRegionsFromEnv({})).toBeUndefined();
    expect(parseSandboxRegionsFromEnv({ MODAL_SANDBOX_REGION: "" })).toBeUndefined();
    expect(parseSandboxRegionsFromEnv({ MODAL_SANDBOX_REGION: " , " })).toBeUndefined();
  });

  it("parses a single region", () => {
    expect(parseSandboxRegionsFromEnv({ MODAL_SANDBOX_REGION: "us-east-1" })).toEqual([
      "us-east-1",
    ]);
  });

  it("parses a comma-separated list, trimming whitespace and dropping empties", () => {
    expect(
      parseSandboxRegionsFromEnv({ MODAL_SANDBOX_REGION: "us-east-1, us-east-2,,us-west-1 " }),
    ).toEqual(["us-east-1", "us-east-2", "us-west-1"]);
  });
});

// ── warmFromModal ────────────────────────────────────────────────────────────

describe("warmFromModal", () => {
  it("carries JSON-RPC requests and responses over the guest socket", async () => {
    const fake = makeFakeProc();
    const sb = makeFakeSandbox(fake);
    const socket = createFakeGuestSocket();
    const warm = _internals.warmFromModal(
      sb,
      fake.proc,
      socket.ws,
      "wss://tunnel.test:443/websocket",
    );
    warm.conn.listen();

    // "probe" is not a real guest method — widen past the typed method map
    // for this plumbing test.
    const untyped = warm.conn as RpcConnection;
    const pending = untyped.sendRequest("probe", { n: 1 }) as Promise<{ pong: boolean }>;
    const req = socket.sentMessages().find((m) => m.method === "probe");
    expect(req?.params).toEqual({ n: 1 });

    socket.receive({ jsonrpc: "2.0", id: req?.id, result: { pong: true } });
    await expect(pending).resolves.toEqual({ pong: true });

    warm.conn.dispose();
  });

  it("notifies exit listeners once when the guest process ends", async () => {
    const fake = makeFakeProc();
    const socket = createFakeGuestSocket();
    const warm = _internals.warmFromModal(
      makeFakeSandbox(fake),
      fake.proc,
      socket.ws,
      "wss://tunnel.test:443/websocket",
    );
    const exits: string[] = [];
    warm.onExit(() => exits.push("exit"));

    expect(warm.alive()).toBe(true);
    fake.exit(1);
    await vi.waitFor(() => {
      if (warm.alive()) throw new Error("still alive");
    });
    expect(exits).toEqual(["exit"]);
  });

  it("marks the harness dead when the guest socket closes", async () => {
    const fake = makeFakeProc();
    const socket = createFakeGuestSocket();
    const warm = _internals.warmFromModal(
      makeFakeSandbox(fake),
      fake.proc,
      socket.ws,
      "wss://tunnel.test:443/websocket",
    );
    expect(warm.alive()).toBe(true);
    socket.close();
    expect(warm.alive()).toBe(false);
  });

  it("cleanup terminates the sandbox, marks the harness dead, and is memoized", async () => {
    const fake = makeFakeProc();
    const sb = makeFakeSandbox(fake);
    const socket = createFakeGuestSocket();
    const warm = _internals.warmFromModal(
      sb,
      fake.proc,
      socket.ws,
      "wss://tunnel.test:443/websocket",
    );

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
    const socket = createFakeGuestSocket();
    const warm = _internals.warmFromModal(
      sb,
      fake.proc,
      socket.ws,
      "wss://tunnel.test:443/websocket",
    );
    await expect(warm.cleanup()).resolves.toBeUndefined();
  });

  it("rejects pending requests when the guest socket closes", async () => {
    const fake = makeFakeProc();
    const socket = createFakeGuestSocket();
    const warm = _internals.warmFromModal(
      makeFakeSandbox(fake),
      fake.proc,
      socket.ws,
      "wss://tunnel.test:443/websocket",
    );
    warm.conn.listen();
    const pending = (warm.conn as RpcConnection).sendRequest("probe");
    socket.close();
    await expect(pending).rejects.toThrow(/Connection closed/);
  });
});

// ── spawnModalWarm ───────────────────────────────────────────────────────────

describe("spawnModalWarm", () => {
  it("creates a tunneled sandbox and dials the harness", async () => {
    const fake = makeFakeProc();
    const sb = makeFakeSandbox(fake);
    const createParams: Record<string, unknown>[] = [];
    const ctx: ModalSpawnContext = {
      createGuestSandbox: async (_code, params) => {
        createParams.push(params as unknown as Record<string, unknown>);
        return sb;
      },
    };
    const harnessPath = await makeHarnessFile("// the harness code");
    const socket = createFakeGuestSocket();
    const { dial, calls } = makeFakeDial(socket);

    const warm = await spawnModalWarm({ harnessPath, slug: "my-agent" }, ctx, dial);

    expect(createParams).toHaveLength(1);
    expect(createParams[0]).toMatchObject({
      command: ["sleep", "infinity"],
      encryptedPorts: [GUEST_PORT],
      timeoutMs: DEFAULT_SANDBOX_TIMEOUT_MS,
      idleTimeoutMs: DEFAULT_SANDBOX_IDLE_TIMEOUT_MS,
      tags: { service: "aai-guest", role: "agent", slug: "my-agent" },
    });
    // Tunnels replaced blockNetwork — they are mutually exclusive in Modal.
    expect(createParams[0]).not.toHaveProperty("blockNetwork");

    // The harness runs on Node with the per-sandbox token in the EXEC env.
    expect(sb.execCalls).toHaveLength(1);
    const { command, params } = sb.execCalls[0] as {
      command: string[];
      params: Record<string, unknown>;
    };
    expect(command).toEqual(["node", expect.stringContaining("harness.mjs")]);
    const env = params.env as Record<string, string>;
    expect(env.AAI_GUEST_PORT).toBe(String(GUEST_PORT));
    expect(env.AAI_GUEST_TOKEN).toMatch(/^[0-9a-f]{64}$/);

    // The dial went to the tunnel with that same token.
    expect(calls).toEqual([
      { url: "wss://tunnel.modal.test:12345/ws", token: env.AAI_GUEST_TOKEN },
    ]);

    expect(warm.alive()).toBe(true);
    await warm.cleanup();
  });

  it("forwards the deploy's pinned image tag to the spawn context", async () => {
    const fake = makeFakeProc();
    const sb = makeFakeSandbox(fake);
    const tags: (string | undefined)[] = [];
    const ctx: ModalSpawnContext = {
      createGuestSandbox: async (_code, _params, imageTag) => {
        tags.push(imageTag);
        return sb;
      },
    };
    const harnessPath = await makeHarnessFile();
    const socket = createFakeGuestSocket();
    const { dial } = makeFakeDial(socket);

    const warm = await spawnModalWarm(
      { harnessPath, slug: "pinned-agent", imageTag: "aai-guest-harness:abcd1234" },
      ctx,
      dial,
    );
    expect(tags).toEqual(["aai-guest-harness:abcd1234"]);
    await warm.cleanup();
  });

  it("mints a distinct token per sandbox", async () => {
    const harnessPath = await makeHarnessFile();
    const tokens: string[] = [];
    const spawnOnce = async (): Promise<void> => {
      const fake = makeFakeProc();
      const sb = makeFakeSandbox(fake);
      const socket = createFakeGuestSocket();
      const { dial } = makeFakeDial(socket);
      const warm = await spawnModalWarm({ harnessPath }, makeCtx(sb), dial);
      const env = (sb.execCalls[0] as unknown as { params: { env: Record<string, string> } }).params
        .env;
      tokens.push(env.AAI_GUEST_TOKEN as string);
      await warm.cleanup();
    };
    await spawnOnce();
    await spawnOnce();
    expect(tokens[0]).not.toBe(tokens[1]);
  });

  it("tags sandboxes by role: pool default, preview by slug suffix, explicit role", async () => {
    const harnessPath = await makeHarnessFile();
    const spawnOnce = async (identity: {
      slug?: string;
      role?: "studio" | "inspect";
    }): Promise<Record<string, unknown>> => {
      const fake = makeFakeProc();
      const sb = makeFakeSandbox(fake);
      const createParams: Record<string, unknown>[] = [];
      const socket = createFakeGuestSocket();
      const { dial } = makeFakeDial(socket);
      const warm = await spawnModalWarm(
        { harnessPath, ...identity },
        {
          createGuestSandbox: async (_code, params) => {
            createParams.push(params as unknown as Record<string, unknown>);
            return sb;
          },
        },
        dial,
      );
      await warm.cleanup();
      return (createParams[0] as { tags: Record<string, unknown> }).tags;
    };

    // No slug (a warm-pool spare): role "pool", no slug tag.
    expect(await spawnOnce({})).toEqual({ service: "aai-guest", role: "pool" });
    // A `-preview` slug is a studio preview agent.
    expect(await spawnOnce({ slug: "contact-form-x7k2mq-preview" })).toEqual({
      service: "aai-guest",
      role: "preview",
      slug: "contact-form-x7k2mq-preview",
    });
    // An explicit role wins over slug inference.
    expect(await spawnOnce({ slug: "contact-form-x7k2mq", role: "studio" })).toEqual({
      service: "aai-guest",
      role: "studio",
      slug: "contact-form-x7k2mq",
    });
  });

  it("exposes the sandbox's setTags on the WarmHarness for pooled retagging", async () => {
    const fake = makeFakeProc();
    const sb = makeFakeSandbox(fake);
    const harnessPath = await makeHarnessFile();
    const socket = createFakeGuestSocket();
    const { dial } = makeFakeDial(socket);

    const warm = await spawnModalWarm({ harnessPath }, makeCtx(sb), dial);
    await warm.setTags?.({ service: "aai-guest", role: "agent", slug: "acquired" });
    expect(sb.setTags).toHaveBeenCalledWith({
      service: "aai-guest",
      role: "agent",
      slug: "acquired",
    });
    await warm.cleanup();
  });

  it("omits region pinning by default and passes regions when MODAL_SANDBOX_REGION is set", async () => {
    const harnessPath = await makeHarnessFile();
    const spawnOnce = async (): Promise<Record<string, unknown>> => {
      const fake = makeFakeProc();
      const sb = makeFakeSandbox(fake);
      const createParams: Record<string, unknown>[] = [];
      const socket = createFakeGuestSocket();
      const { dial } = makeFakeDial(socket);
      const warm = await spawnModalWarm(
        { harnessPath },
        {
          createGuestSandbox: async (_code, params) => {
            createParams.push(params as unknown as Record<string, unknown>);
            return sb;
          },
        },
        dial,
      );
      await warm.cleanup();
      return createParams[0] as Record<string, unknown>;
    };

    expect(await spawnOnce()).not.toHaveProperty("regions");

    vi.stubEnv("MODAL_SANDBOX_REGION", "us-east-1");
    try {
      expect(await spawnOnce()).toMatchObject({ regions: ["us-east-1"] });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("passes a matching reservation alongside each hard cap (Modal rejects a bare cap)", async () => {
    // Modal's SDK throws "must also specify cpu when cpuLimit is specified"
    // (and the memoryMiB analog) at sandbox creation, so a bare cap would
    // fail every guest spawn in environments that set SANDBOX_CPU_LIMIT /
    // SANDBOX_MEMORY_LIMIT_MB — which production does.
    vi.stubEnv("SANDBOX_CPU", "1");
    vi.stubEnv("SANDBOX_CPU_LIMIT", "1");
    vi.stubEnv("SANDBOX_MEMORY_MB", "1024");
    vi.stubEnv("SANDBOX_MEMORY_LIMIT_MB", "1024");
    try {
      const fake = makeFakeProc();
      const sb = makeFakeSandbox(fake);
      const createParams: Record<string, unknown>[] = [];
      const ctx: ModalSpawnContext = {
        createGuestSandbox: async (_code, params) => {
          createParams.push(params as unknown as Record<string, unknown>);
          return sb;
        },
      };
      const harnessPath = await makeHarnessFile();
      const socket = createFakeGuestSocket();
      const { dial } = makeFakeDial(socket);

      const warm = await spawnModalWarm({ harnessPath }, ctx, dial);
      expect(createParams[0]).toMatchObject({
        cpu: 1,
        cpuLimit: 1,
        memoryMiB: 1024,
        memoryLimitMiB: 1024,
      });
      await warm.cleanup();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("forwards a burst range — reservation below cap — when both are configured", async () => {
    // The guest must be able to burst to the bundler's ~1.7 GB peak without
    // every idle voice sandbox reserving it. Pinning reservation == cap made
    // the cap the only affordable number, and 1 GiB does not fit a build.
    vi.stubEnv("SANDBOX_CPU", "1");
    vi.stubEnv("SANDBOX_CPU_LIMIT", "4");
    vi.stubEnv("SANDBOX_MEMORY_MB", "1024");
    vi.stubEnv("SANDBOX_MEMORY_LIMIT_MB", "4096");
    try {
      const fake = makeFakeProc();
      const sb = makeFakeSandbox(fake);
      const createParams: Record<string, unknown>[] = [];
      const ctx: ModalSpawnContext = {
        createGuestSandbox: async (_code, params) => {
          createParams.push(params as unknown as Record<string, unknown>);
          return sb;
        },
      };
      const harnessPath = await makeHarnessFile();
      const socket = createFakeGuestSocket();
      const { dial } = makeFakeDial(socket);

      const warm = await spawnModalWarm({ harnessPath }, ctx, dial);
      expect(createParams[0]).toMatchObject({
        cpu: 1,
        cpuLimit: 4,
        memoryMiB: 1024,
        memoryLimitMiB: 4096,
      });
      await warm.cleanup();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("omits cpu/memory reservations entirely when no limits are configured", async () => {
    const fake = makeFakeProc();
    const sb = makeFakeSandbox(fake);
    const createParams: Record<string, unknown>[] = [];
    const ctx: ModalSpawnContext = {
      createGuestSandbox: async (_code, params) => {
        createParams.push(params as unknown as Record<string, unknown>);
        return sb;
      },
    };
    const harnessPath = await makeHarnessFile();
    const socket = createFakeGuestSocket();
    const { dial } = makeFakeDial(socket);

    const warm = await spawnModalWarm({ harnessPath }, ctx, dial);
    for (const key of ["cpu", "cpuLimit", "memoryMiB", "memoryLimitMiB"]) {
      expect(createParams[0]).not.toHaveProperty(key);
    }
    await warm.cleanup();
  });

  it("honors SANDBOX_IDLE_TIMEOUT_SECS over the default idle timeout", async () => {
    vi.stubEnv("SANDBOX_IDLE_TIMEOUT_SECS", "600");
    try {
      const fake = makeFakeProc();
      const sb = makeFakeSandbox(fake);
      const createParams: Record<string, unknown>[] = [];
      const ctx: ModalSpawnContext = {
        createGuestSandbox: async (_code, params) => {
          createParams.push(params as unknown as Record<string, unknown>);
          return sb;
        },
      };
      const harnessPath = await makeHarnessFile();
      const socket = createFakeGuestSocket();
      const { dial } = makeFakeDial(socket);

      const warm = await spawnModalWarm({ harnessPath }, ctx, dial);
      expect(createParams[0]).toMatchObject({ idleTimeoutMs: 600_000 });
      await warm.cleanup();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("terminates the sandbox when the dial fails, and wraps the error", async () => {
    const fake = makeFakeProc();
    const sb = makeFakeSandbox(fake);
    const harnessPath = await makeHarnessFile();
    const dial = vi.fn().mockRejectedValue(new Error("guest never came up"));

    await expect(spawnModalWarm({ harnessPath }, makeCtx(sb), dial)).rejects.toThrow(
      /Modal sandbox spawn failed: guest never came up/,
    );
    expect(sb.terminate).toHaveBeenCalled();
  });

  it("terminates the sandbox when no tunnel exists for the guest port", async () => {
    const fake = makeFakeProc();
    const sb = makeFakeSandbox(fake);
    sb.tunnels = async () => ({});
    const harnessPath = await makeHarnessFile();
    const socket = createFakeGuestSocket();
    const { dial } = makeFakeDial(socket);

    await expect(spawnModalWarm({ harnessPath }, makeCtx(sb), dial)).rejects.toThrow(
      /no tunnel for guest port/,
    );
    expect(sb.terminate).toHaveBeenCalled();
  });

  it("reads the harness file once and reuses it across spawns", async () => {
    const harnessPath = await makeHarnessFile("// v1");
    const spawnOnce = async (): Promise<string> => {
      const fake = makeFakeProc();
      const sb = makeFakeSandbox(fake);
      const ctx = makeCtx(sb);
      const socket = createFakeGuestSocket();
      const { dial } = makeFakeDial(socket);
      const warm = await spawnModalWarm({ harnessPath }, ctx, dial);
      await warm.cleanup();
      return ctx.codes[0] ?? "";
    };
    expect(await spawnOnce()).toBe("// v1");
    await writeFile(harnessPath, "// v2", "utf-8");
    // Cached: the harness is stable per process, so v1 is still shipped.
    expect(await spawnOnce()).toBe("// v1");
  });

  it("propagates a missing harness file as a spawn failure", async () => {
    const fake = makeFakeProc();
    const sb = makeFakeSandbox(fake);
    const socket = createFakeGuestSocket();
    const { dial } = makeFakeDial(socket);
    await expect(
      spawnModalWarm({ harnessPath: "/nonexistent/harness.mjs" }, makeCtx(sb), dial),
    ).rejects.toThrow(/ENOENT/);
    // The harness is read before any sandbox is created — nothing to leak.
    expect(sb.execCalls).toHaveLength(0);
  });
});
