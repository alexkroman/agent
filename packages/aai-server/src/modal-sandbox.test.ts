// Copyright 2026 the AAI authors. MIT license.
/**
 * Tests for the Modal sandbox backend: WarmHarness wiring over the dialed
 * guest WebSocket, exit/cleanup semantics, and the spawn flow against an
 * injected ModalSpawnContext (no real Modal calls). The env-derived limit
 * parsing is covered in modal-sandbox-env.test.ts.
 */

import { writeFile } from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createFakeGuestSocket,
  type FakeGuestSocket,
  makeCtx,
  makeFakeProc,
  makeFakeSandbox,
  makeHarnessFile,
} from "./_sandbox-vm-test-utils.ts";
import { GUEST_SCRATCH_DIR } from "./guest-exec-env.ts";
import { GUEST_PORT, type ModalSpawnContext } from "./modal-context.ts";
import { _internals, spawnModalWarm } from "./modal-sandbox.ts";
import {
  DEFAULT_SANDBOX_IDLE_TIMEOUT_MS,
  DEFAULT_SANDBOX_TIMEOUT_MS,
} from "./modal-sandbox-env.ts";
import type { RpcConnection } from "./rpc-transport.ts";

// ── Fakes ────────────────────────────────────────────────────────────────────

/** A dial fn resolving to a fake guest socket, recording its arguments. */
function makeFakeDial(socket: FakeGuestSocket) {
  const calls: { url: string; token: string }[] = [];
  const dial = async (url: string, token: string) => {
    calls.push({ url, token });
    return socket.ws;
  };
  return { dial, calls };
}

/**
 * Widen a `createGuestSandbox` params object for `toMatchObject` assertions.
 * The real type is a struct rather than an index signature, so the widening
 * needs a cast — keep it at this one seam; the escape-hatch ratchet counts
 * every occurrence.
 */
function asRecord(params: object): Record<string, unknown> {
  return params as unknown as Record<string, unknown>;
}

beforeEach(() => {
  _internals.resetModalContext();
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
      "test-token",
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
      "test-token",
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
      "test-token",
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
      "test-token",
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
      "test-token",
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
      "test-token",
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
      lookupGuestSandbox: () => Promise.resolve(null),
      prepareGuestImage: () => Promise.resolve(),
      createGuestSandbox: async (_code, params) => {
        createParams.push(asRecord(params));
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
    // Readiness is Modal's to evaluate, inside the container, rather than N
    // HTTP polls from the host across the public tunnel.
    expect(createParams[0]?.readinessProbe).toBeDefined();
    // Tunnels replaced blockNetwork — they are mutually exclusive in Modal.
    expect(createParams[0]).not.toHaveProperty("blockNetwork");

    // The harness runs on Node with the per-sandbox token in the EXEC env.
    expect(sb.execCalls).toHaveLength(1);
    const { command, params } = sb.execCalls[0] ?? { command: [], params: undefined };
    expect(command).toEqual(["node", expect.stringContaining("harness.mjs")]);
    const env = params?.env ?? {};
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
      lookupGuestSandbox: () => Promise.resolve(null),
      prepareGuestImage: () => Promise.resolve(),
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
      const env = sb.execCalls[0]?.params.env ?? {};
      tokens.push(env.AAI_GUEST_TOKEN as string);
      await warm.cleanup();
    };
    await spawnOnce();
    await spawnOnce();
    expect(tokens[0]).not.toBe(tokens[1]);
  });

  it("tags sandboxes by role: inspect default, preview by slug suffix, explicit role", async () => {
    const harnessPath = await makeHarnessFile();
    const spawnOnce = async (identity: {
      slug?: string;
      role?: "studio" | "studio-publish";
    }): Promise<Record<string, unknown>> => {
      const fake = makeFakeProc();
      const sb = makeFakeSandbox(fake);
      const createParams: Record<string, unknown>[] = [];
      const socket = createFakeGuestSocket();
      const { dial } = makeFakeDial(socket);
      const warm = await spawnModalWarm(
        { harnessPath, ...identity },
        {
          lookupGuestSandbox: () => Promise.resolve(null),
          prepareGuestImage: () => Promise.resolve(),
          createGuestSandbox: async (_code, params) => {
            createParams.push(asRecord(params));
            return sb;
          },
        },
        dial,
      );
      await warm.cleanup();
      return (createParams[0] as { tags: Record<string, unknown> }).tags;
    };

    // No slug and no role: a control-channel guest, i.e. a studio one.
    expect(await spawnOnce({})).toEqual({ service: "aai-guest", role: "studio" });
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
          lookupGuestSandbox: () => Promise.resolve(null),
          prepareGuestImage: () => Promise.resolve(),
          createGuestSandbox: async (_code, params) => {
            createParams.push(asRecord(params));
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
    expect(await spawnOnce()).toMatchObject({ regions: ["us-east-1"] });
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
    const fake = makeFakeProc();
    const sb = makeFakeSandbox(fake);
    const createParams: Record<string, unknown>[] = [];
    const ctx: ModalSpawnContext = {
      lookupGuestSandbox: () => Promise.resolve(null),
      prepareGuestImage: () => Promise.resolve(),
      createGuestSandbox: async (_code, params) => {
        createParams.push(asRecord(params));
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
  });

  it("forwards a burst range — reservation below cap — when both are configured", async () => {
    // The guest must be able to burst to the bundler's ~1.7 GB peak without
    // every idle voice sandbox reserving it. Pinning reservation == cap made
    // the cap the only affordable number, and 1 GiB does not fit a build.
    vi.stubEnv("SANDBOX_CPU", "1");
    vi.stubEnv("SANDBOX_CPU_LIMIT", "4");
    vi.stubEnv("SANDBOX_MEMORY_MB", "1024");
    vi.stubEnv("SANDBOX_MEMORY_LIMIT_MB", "4096");
    const fake = makeFakeProc();
    const sb = makeFakeSandbox(fake);
    const createParams: Record<string, unknown>[] = [];
    const ctx: ModalSpawnContext = {
      lookupGuestSandbox: () => Promise.resolve(null),
      prepareGuestImage: () => Promise.resolve(),
      createGuestSandbox: async (_code, params) => {
        createParams.push(asRecord(params));
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
  });

  it("omits cpu/memory reservations entirely when no limits are configured", async () => {
    const fake = makeFakeProc();
    const sb = makeFakeSandbox(fake);
    const createParams: Record<string, unknown>[] = [];
    const ctx: ModalSpawnContext = {
      lookupGuestSandbox: () => Promise.resolve(null),
      prepareGuestImage: () => Promise.resolve(),
      createGuestSandbox: async (_code, params) => {
        createParams.push(asRecord(params));
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
    const fake = makeFakeProc();
    const sb = makeFakeSandbox(fake);
    const createParams: Record<string, unknown>[] = [];
    const ctx: ModalSpawnContext = {
      lookupGuestSandbox: () => Promise.resolve(null),
      prepareGuestImage: () => Promise.resolve(),
      createGuestSandbox: async (_code, params) => {
        createParams.push(asRecord(params));
        return sb;
      },
    };
    const harnessPath = await makeHarnessFile();
    const socket = createFakeGuestSocket();
    const { dial } = makeFakeDial(socket);

    const warm = await spawnModalWarm({ harnessPath }, ctx, dial);
    expect(createParams[0]).toMatchObject({ idleTimeoutMs: 600_000 });
    await warm.cleanup();
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

  it("names the guest's scratch directory rather than inheriting one", async () => {
    // Modal has no tmpfs over `/tmp` (probed: one `none / overlay rw` in
    // `/proc/mounts`, 5.1 GB of `dd` into `/var/tmp` without ENOSPC), so this
    // changes nothing in production — and is set anyway, for the reason
    // `GUEST_SCRATCH_DIR` gives: which runtime mounts what over `/tmp` is not a
    // fact a spawner should know. The local microVM DOES mount a 512 MiB RAM
    // disk there, and a studio guest that only got the key on one backend is a
    // dev/prod split in the one place this repo has already paid for it.
    //
    // It arrives through `guestExecBaseEnv()` rather than being named here, which
    // is what `guest-exec-env.test.ts` pins; this spec is the four-sites half of
    // that — the value has to be in the env this backend really execs with.
    const fake = makeFakeProc();
    const sb = makeFakeSandbox(fake);
    const socket = createFakeGuestSocket();
    const { dial } = makeFakeDial(socket);

    const warm = await spawnModalWarm({ harnessPath: await makeHarnessFile() }, makeCtx(sb), dial);

    expect(sb.execCalls[0]?.params.env?.TMPDIR).toBe(GUEST_SCRATCH_DIR);
    await warm.cleanup();
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
