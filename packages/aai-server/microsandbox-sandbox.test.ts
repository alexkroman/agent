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
import { GUEST_ROUTES } from "./guest-routes.ts";
import { HOST_ALIAS } from "./microsandbox-network.ts";
import {
  _internals,
  LOCAL_GUEST_IMAGE_TAG,
  type MicrosandboxCreateParams,
  type MicrosandboxHandle,
  type MicrosandboxSpawnContext,
  microsandboxHarnessImageTag,
  microsandboxImageRef,
  spawnMicrosandboxAgentServer,
  spawnMicrosandboxWarm,
} from "./microsandbox-sandbox.ts";
import type { GuestFetch } from "./warm-harness.ts";

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
    // A studio guest carries no tenant DSNs, so it opens no host port at all.
    expect(created?.hostPorts).toEqual([]);
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

// ── Agent-server spawning ────────────────────────────────────────────────────

describe("spawnMicrosandboxAgentServer", () => {
  // `vi.fn<T>` rather than a widen-and-renarrow cast: the generic IS the
  // affordance for typing a stub as the thing it stands in for.
  const okFetch = (): GuestFetch =>
    vi.fn<GuestFetch>(async () => new Response("ok", { status: 200 }));

  it("rewrites the agent's loopback env and opens exactly those host ports", async () => {
    const fake = makeCtx();
    const handle = await spawnMicrosandboxAgentServer(
      {
        harnessPath: await makeHarnessFile(),
        slug: "demo",
        name: "agent-demo-v1",
        worker: { kind: "inline", code: "// worker", sha256: "abc" },
        agentEnv: {
          DATABASE_URL: "postgresql://app@127.0.0.1:54322/app",
          STORAGE_URL: "http://localhost:54321/storage",
          ASSEMBLYAI_API_KEY: "sk-test",
        },
      },
      fake.ctx,
      okFetch(),
    );

    // The env the guest READS is a boot file, so that is where the rewrite has
    // to land — this is the difference between ctx.db working and pointing at
    // the VM's own loopback.
    const envWrite = fake.writes.find((w) => w.path.endsWith("env.json"));
    const written = JSON.parse(envWrite?.data ?? "{}") as Record<string, string>;
    expect(written.DATABASE_URL).toBe(`postgresql://app@${HOST_ALIAS}:54322/app`);
    expect(written.STORAGE_URL).toBe(`http://${HOST_ALIAS}:54321/storage`);
    expect(written.ASSEMBLYAI_API_KEY).toBe("sk-test");
    // Derived from the rewrite, not from a maintained list — and nothing else.
    expect(fake.created[0]?.hostPorts).toEqual([54_321, 54_322]);
    await handle.shutdown();
  });

  it("writes the bundle before the exec, and only when it holds the bytes", async () => {
    const fake = makeCtx();
    const handle = await spawnMicrosandboxAgentServer(
      {
        harnessPath: await makeHarnessFile(),
        slug: "demo",
        name: "agent-demo-v2",
        worker: { kind: "url", url: "https://blobs/worker.mjs", sha256: "abc" },
        agentEnv: {},
      },
      fake.ctx,
      okFetch(),
    );
    // A URL worker is fetched BY the guest; writing it would move the bytes
    // through this process for nothing.
    expect(fake.writes.map((w) => w.path)).toEqual([expect.stringContaining("env.json")]);
    expect(fake.execs).toHaveLength(1);
    await handle.shutdown();
  });

  it("publishes a kill BEFORE readiness, so a booting guest is killable", async () => {
    const fake = makeCtx();
    let published: (() => Promise<void>) | undefined;
    const handle = await spawnMicrosandboxAgentServer(
      {
        harnessPath: await makeHarnessFile(),
        slug: "demo",
        name: "agent-demo-v3",
        worker: { kind: "inline", code: "// w", sha256: "abc" },
        agentEnv: {},
        onSpawned: (terminate) => {
          published = terminate;
        },
      },
      fake.ctx,
      okFetch(),
    );
    // A teardown must not depend on the boot it is tearing down.
    expect(published).toBeTypeOf("function");
    await published?.();
    expect(fake.stops).toBe(1);
    await handle.shutdown();
  });
});
