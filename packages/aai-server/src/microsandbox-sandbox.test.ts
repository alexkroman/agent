// Copyright 2026 the AAI authors. MIT license.
/**
 * The microVM backend, against an injected `MicrosandboxSpawnContext` — so no
 * real microVM boots and the suite stays in the unit tier.
 *
 * What is worth pinning here is the parity surface: the image a guest boots
 * from, the env it does and does NOT receive, and the boot artifacts written
 * before the exec. Each of those is a place where a plausible-looking change
 * makes this backend quietly stop resembling production.
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createFakeGuestSocket } from "./_sandbox-vm-test-utils.ts";
import { GUEST_SCRATCH_DIR } from "./guest-exec-env.ts";
import { GUEST_ROUTES } from "./guest-routes.ts";
import {
  _internals,
  LOCAL_GUEST_IMAGE_TAG,
  type MicrosandboxCreateParams,
  type MicrosandboxHandle,
  type MicrosandboxSpawnContext,
  microsandboxHarnessImageTag,
  microsandboxImageRef,
  spawnMicrosandboxWarm,
} from "./microsandbox-sandbox.ts";
import { SandboxNameTakenError } from "./sandbox-directory.ts";

// ── Fakes ────────────────────────────────────────────────────────────────────

/** Named so an intentional no-op is not an empty block. */
const noop = (): undefined => undefined;

const emptyStream = (): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });

type FakeSandbox = {
  ctx: MicrosandboxSpawnContext;
  created: MicrosandboxCreateParams[];
  execs: string[][];
  writes: { path: string; data: string }[];
  stops: number;
};

function makeCtx(): FakeSandbox {
  const created: MicrosandboxCreateParams[] = [];
  const execs: string[][] = [];
  const writes: { path: string; data: string }[] = [];
  const state = { stops: 0 };
  const handle: MicrosandboxHandle = {
    exec: async (command) => {
      execs.push(command);
      return {
        stdout: emptyStream(),
        stderr: emptyStream(),
        // Never settles: a spawned guest does not exit during a spawn test.
        wait: () => new Promise<number>(noop),
        kill: noop,
      };
    },
    writeFile: async (path, data) => {
      writes.push({ path, data });
    },
    stop: async () => {
      state.stops += 1;
    },
  };
  return {
    created,
    execs,
    writes,
    get stops() {
      return state.stops;
    },
    ctx: {
      createSandbox: async (params) => {
        created.push(params);
        return handle;
      },
    },
  };
}

async function makeHarnessFile(content = "// harness"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "aai-microsandbox-test-"));
  const path = join(dir, "harness.mjs");
  await writeFile(path, content, "utf-8");
  return path;
}

// ── The image a guest boots from ─────────────────────────────────────────────

describe("microsandboxImageRef", () => {
  it("uses the LOCAL build when no registry is configured", () => {
    expect(microsandboxImageRef("// code", {})).toBe(LOCAL_GUEST_IMAGE_TAG);
  });

  it("pulls the content-addressed image when a registry is", () => {
    // The whole point of the shared OCI recipe: a dev pointed at a registry
    // boots the byte-identical image a deploy would.
    const ref = microsandboxImageRef("// code", { GUEST_IMAGE_REGISTRY: "ghcr.io/owner" });
    expect(ref).toMatch(/^ghcr\.io\/owner\/aai-guest-harness:[0-9a-f]{16}$/);
  });
});

describe("microsandboxHarnessImageTag", () => {
  it("pins nothing for the local image", async () => {
    // `:local` is a MUTABLE tag that `pnpm build:guest-image` overwrites, so
    // recording it would promise an environment nothing can reproduce.
    vi.stubEnv("GUEST_IMAGE_REGISTRY", undefined);
    await expect(microsandboxHarnessImageTag(await makeHarnessFile())).resolves.toBeNull();
  });

  it("pins the content-addressed tag when a registry is configured", async () => {
    vi.stubEnv("GUEST_IMAGE_REGISTRY", "ghcr.io/owner");
    const tag = await microsandboxHarnessImageTag(await makeHarnessFile("// pinned"));
    // The BARE tag, as Modal records it — the registry is a resolution-time
    // prefix, deliberately outside the hashed byte stream.
    expect(tag).toMatch(/^aai-guest-harness:[0-9a-f]{16}$/);
  });
});

// ── The stdio adapter ────────────────────────────────────────────────────────

describe("procFromExec", () => {
  /** Drain a stream to one string. */
  async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
    let text = "";
    for await (const chunk of stream) text += new TextDecoder().decode(chunk);
    return text;
  }

  it("splits one tagged event stream into stdout, stderr and an exit code", async () => {
    const encode = (s: string) => new TextEncoder().encode(s);
    const events = [
      { kind: "started" as const, pid: 7 },
      { kind: "stdout" as const, data: encode("out-1") },
      { kind: "stderr" as const, data: encode("err-1") },
      { kind: "stdout" as const, data: encode("out-2") },
      { kind: "exited" as const, code: 3 },
    ];
    const proc = _internals.procFromExec({
      async *[Symbol.asyncIterator]() {
        yield* events;
      },
      kill: async () => undefined,
    });

    await expect(drain(proc.stdout)).resolves.toBe("out-1out-2");
    await expect(drain(proc.stderr)).resolves.toBe("err-1");
    await expect(proc.wait()).resolves.toBe(3);
  });

  it("reports an exit even when the stream ends without one", async () => {
    // A VM that dies mid-stream must still settle `wait()`, or every caller
    // that awaits a guest's exit hangs to its own timeout.
    const proc = _internals.procFromExec({
      async *[Symbol.asyncIterator]() {
        yield { kind: "stdout" as const, data: new Uint8Array() };
      },
      kill: async () => undefined,
    });
    await expect(proc.wait()).resolves.toBe(-1);
  });

  it("survives a stream that throws", async () => {
    const proc = _internals.procFromExec({
      async *[Symbol.asyncIterator]() {
        yield { kind: "stdout" as const, data: new Uint8Array() };
        throw new Error("vm died");
      },
      kill: async () => undefined,
    });
    await expect(proc.wait()).resolves.toBe(-1);
  });
});

// ── Warm spawning ────────────────────────────────────────────────────────────

describe("spawnMicrosandboxWarm", () => {
  it("boots the guest image and dials the control channel with its bearer", async () => {
    const fake = makeCtx();
    const socket = createFakeGuestSocket();
    const dialed: { url: string; token: string }[] = [];
    vi.stubEnv("GUEST_IMAGE_REGISTRY", undefined);

    const warm = await spawnMicrosandboxWarm(
      { harnessPath: await makeHarnessFile(), name: "warm-1", role: "studio" },
      fake.ctx,
      async (url, token) => {
        dialed.push({ url, token });
        return socket.ws;
      },
    );

    const created = fake.created[0];
    expect(created?.imageRef).toBe(LOCAL_GUEST_IMAGE_TAG);
    expect(fake.execs[0]).toEqual(["node", "/opt/aai/harness.mjs"]);
    expect(dialed[0]?.url).toContain(GUEST_ROUTES.control);
    expect(dialed[0]?.token).toBe(warm.token);
    // A studio guest carries no tenant DSNs — but it DOES deploy, and the
    // in-guest `aai deploy` POSTs back to this platform. Without the port open
    // that is a 404 the guest returns to itself, which is what the retired
    // local-container backend was retired over.
    expect(created?.hostPorts).toEqual([8080]);
    await warm.cleanup();
  });

  it("sizes the VM for the BUILD shape when the env declares no limits", async () => {
    // microsandbox's own defaults are 480 MiB and one core (measured in a
    // booted guest). A workspace build there does not fail, it WEDGES — RSS
    // pinned, no progress — and reads as a hung build. `subprocess` cannot see
    // this: there the limit is V8's --max-old-space-size on a process with the
    // whole machine behind it, so leaving it unset costs nothing.
    const fake = makeCtx();
    vi.stubEnv("SANDBOX_MEMORY_LIMIT_MB", undefined);
    vi.stubEnv("SANDBOX_CPU_LIMIT", undefined);

    const warm = await spawnMicrosandboxWarm(
      { harnessPath: await makeHarnessFile(), name: "warm-res" },
      fake.ctx,
      async () => createFakeGuestSocket().ws,
    );

    // Modal reserves 1 core / 1024 MiB and caps at 4 / 4096 for builds; a VM
    // has no burst, so the cap is the number to take.
    expect(fake.created[0]?.memoryLimitMiB).toBe(4096);
    expect(fake.created[0]?.cpus).toBe(4);
    await warm.cleanup();
  });

  it("lets a declared limit win over the default", async () => {
    const fake = makeCtx();
    vi.stubEnv("SANDBOX_MEMORY_MB", "512");
    vi.stubEnv("SANDBOX_MEMORY_LIMIT_MB", "2048");

    const warm = await spawnMicrosandboxWarm(
      { harnessPath: await makeHarnessFile(), name: "warm-res-env" },
      fake.ctx,
      async () => createFakeGuestSocket().ws,
    );

    expect(fake.created[0]?.memoryLimitMiB).toBe(2048);
    await warm.cleanup();
  });

  it("hands the guest a MINIMAL env — never the server's own", async () => {
    const fake = makeCtx();
    const socket = createFakeGuestSocket();
    // The parity rule: agent code that wrongly reads process.env must fail here
    // the way it fails in production.
    vi.stubEnv("SUPABASE_DB_URL", "postgres://platform-secret");

    const warm = await spawnMicrosandboxWarm(
      { harnessPath: await makeHarnessFile(), name: "warm-2" },
      fake.ctx,
      async () => socket.ws,
    );

    const env = fake.created[0]?.env ?? {};
    expect(env.SUPABASE_DB_URL).toBeUndefined();
    expect(env.AAI_GUEST_TOKEN).toBe(warm.token);
    // Absent on purpose: the harness binds 0.0.0.0 exactly as under Modal, and
    // the override `subprocess` needs is a workaround for having no namespace.
    expect(env.AAI_GUEST_HOST).toBeUndefined();
    // A real VM surrounds this guest, so the SDK drops its SSRF screen.
    expect(env.AAI_SANDBOX_CONTAINED).toBe("1");
    await warm.cleanup();
  });

  it("names the guest's scratch directory rather than inheriting one", async () => {
    // Measured in a live microVM booted from this very image with the studio
    // guest's own exec env: `/tmp` is `tmpfs … size=524288k` — a 512 MiB RAM
    // disk — beside the 3.9 GB overlay `/var/tmp` sits on, and `os.tmpdir()`
    // answers `/tmp`. So the studio guest's build path (the aai CLI's worker
    // bundler writes into `mkdtemp(join(tmpdir(), …))`) and any workspace tool
    // `test_agent` invokes (`@alexkroman1/aai/step-files` is `join(tmpdir(),
    // …)`) were spending the VM's MEMORY: MemAvailable fell 508,632 kB for a
    // 512 MiB write to `/tmp` and not at all for the same write to `/var/tmp`.
    // It arrives through `guestExecBaseEnv()`, the one env every contained guest
    // gets, for the same reason containment does — which runtime mounts what over
    // `/tmp` is not a fact a spawner should know. It was named HERE and in two
    // other builders until that function had room for it (`guest-exec-env.ts`),
    // and `guest-exec-env.test.ts` is what keeps the copies from coming back.
    const fake = makeCtx();
    const socket = createFakeGuestSocket();

    const warm = await spawnMicrosandboxWarm(
      { harnessPath: await makeHarnessFile(), name: "warm-scratch" },
      fake.ctx,
      async () => socket.ws,
    );

    expect(fake.created[0]?.env.TMPDIR).toBe(GUEST_SCRATCH_DIR);
    await warm.cleanup();
  });

  it("stops the VM when the dial fails, rather than leaking it", async () => {
    const fake = makeCtx();
    await expect(
      spawnMicrosandboxWarm(
        { harnessPath: await makeHarnessFile(), name: "warm-3" },
        fake.ctx,
        async () => {
          throw new Error("dial refused");
        },
      ),
    ).rejects.toThrow(/Microsandbox spawn failed/);
    expect(fake.stops).toBe(1);
  });

  it("fails with the missing path when the harness was never built", async () => {
    const fake = makeCtx();
    await expect(
      spawnMicrosandboxWarm(
        { harnessPath: join(tmpdir(), "aai-does-not-exist", "harness.mjs"), name: "warm-4" },
        fake.ctx,
        async () => createFakeGuestSocket().ws,
      ),
    ).rejects.toThrow(/Microsandbox spawn failed/);
    // Nothing was created, so there is nothing to stop.
    expect(fake.created).toHaveLength(0);
  });
});

// ── Reclaiming a name from a dead holder ─────────────────────────────────────

describe("createReclaimingName", () => {
  /**
   * `sandbox-directory.ts` rests on "a name is released when the sandbox
   * stops". That is MODAL's property, and microsandbox does not share it: its
   * store keeps the row, and `.ephemeral(true)` cannot run when the VM is
   * SIGKILLed. Measured on a real dev server — kill a running agent's
   * `msb sandbox` process and every later spawn answers `sandbox
   * 'agent-<hash>-v2' already exists`, so the slug is permanently unreachable
   * (`/client-config`, `/workflows` and the durable-run wake all answering
   * `agent unavailable, retry shortly`, a 503 that can never succeed).
   */
  const taken = new Error("sandbox already exists: sandbox 'agent-x-v2' already exists");

  /**
   * A FACTORY whose first create fails with `err`, then succeeds — and which
   * hands back a FRESH builder each time, because the real `SandboxBuilder` is
   * single-use (a reused one fails `SandboxBuilder already consumed`, which is
   * how the first draft of this fix stayed broken).
   */
  function builderFailingOnce(err: unknown) {
    let calls = 0;
    const build = () => ({
      create: async () => {
        calls += 1;
        if (calls === 1) throw err;
        return "sandbox" as const;
      },
    });
    return Object.assign(build, { calls: () => calls });
  }

  it("removes a CRASHED holder and retries the create", async () => {
    const builder = builderFailingOnce(taken);
    const removed: string[] = [];
    await expect(
      _internals.createReclaimingName(builder, "agent-x-v2", {
        get: async () => ({ status: "crashed" }),
        remove: async (name: string) => void removed.push(name),
      }),
    ).resolves.toBe("sandbox");
    expect(removed).toEqual(["agent-x-v2"]);
    expect(builder.calls()).toBe(2);
  });

  it("removes a STOPPED holder too", async () => {
    const builder = builderFailingOnce(taken);
    const removed: string[] = [];
    await expect(
      _internals.createReclaimingName(builder, "agent-x-v2", {
        get: async () => ({ status: "stopped" }),
        remove: async (name: string) => void removed.push(name),
      }),
    ).resolves.toBe("sandbox");
    expect(removed).toEqual(["agent-x-v2"]);
  });

  it.each(["running", "draining"])(
    "leaves a %s holder alone — that is a real peer",
    async (status) => {
      // Blue-green handover depends on this: a slug legitimately has two live
      // sandboxes for minutes, and the broker routes to the peer rather than
      // retrying a create that can only lose again.
      const builder = builderFailingOnce(taken);
      const removed: string[] = [];
      await expect(
        _internals.createReclaimingName(builder, "agent-x-v2", {
          get: async () => ({ status }),
          remove: async (name: string) => void removed.push(name),
        }),
      ).rejects.toThrow(SandboxNameTakenError);
      expect(removed).toEqual([]);
      expect(builder.calls()).toBe(1);
    },
  );

  it("retries without removing when the holder is already gone", async () => {
    // The name freed itself between the failure and the read; there is nothing
    // to remove and the create should simply be retried.
    const builder = builderFailingOnce(taken);
    const removed: string[] = [];
    await expect(
      _internals.createReclaimingName(builder, "agent-x-v2", {
        get: async () => {
          throw new Error("no such sandbox");
        },
        remove: async (name: string) => void removed.push(name),
      }),
    ).resolves.toBe("sandbox");
    expect(removed).toEqual([]);
    expect(builder.calls()).toBe(2);
  });

  it("rethrows any OTHER create failure untouched, reading no status", async () => {
    const builder = builderFailingOnce(new Error("no space left on device"));
    const get = vi.fn(async () => ({ status: "stopped" }));
    await expect(
      _internals.createReclaimingName(builder, "agent-x-v2", {
        get,
        remove: async () => undefined,
      }),
    ).rejects.toThrow("no space left on device");
    expect(get).not.toHaveBeenCalled();
  });
});
