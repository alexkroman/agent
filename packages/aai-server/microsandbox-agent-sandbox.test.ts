// Copyright 2026 the AAI authors. MIT license.
/**
 * The deployed-agent spawn on the microVM backend, against an injected context.
 *
 * Split from `microsandbox-sandbox.test.ts` with the module it covers. What is
 * worth pinning here is the BOOT contract: which artifacts are written before
 * the exec, that the agent's own env and its bundle URL are both rewritten for
 * the VM's network namespace, and that a kill exists before readiness does.
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { spawnMicrosandboxAgentServer } from "./microsandbox-agent-sandbox.ts";
import { HOST_ALIAS } from "./microsandbox-network.ts";
import type {
  MicrosandboxCreateParams,
  MicrosandboxHandle,
  MicrosandboxSpawnContext,
} from "./microsandbox-sandbox.ts";
import type { GuestFetch } from "./warm-harness.ts";

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
  const dir = await mkdtemp(join(tmpdir(), "aai-microsandbox-agent-test-"));
  const path = join(dir, "harness.mjs");
  await writeFile(path, content, "utf-8");
  return path;
}

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

  it("rewrites a LOOPBACK bundle URL, and opens its port too", async () => {
    // The bug this exists for: the bundle URL rides the boot env as
    // `AAI_BUNDLE_URL`, not in `agentEnv`, so rewriting only the agent env left
    // the guest fetching its OWN loopback — `agent-mode boot failed: bundle
    // fetch failed`. A dev platform database signs exactly such a URL.
    const fake = makeCtx();
    const handle = await spawnMicrosandboxAgentServer(
      {
        harnessPath: await makeHarnessFile(),
        slug: "demo",
        name: "agent-demo-v4",
        worker: {
          kind: "url",
          url: "http://127.0.0.1:54321/storage/v1/object/sign/blobs/abc",
          sha256: "abc",
        },
        agentEnv: { DATABASE_URL: "postgresql://app@127.0.0.1:54322/app" },
      },
      fake.ctx,
      okFetch(),
    );

    const env = fake.created[0]?.env ?? {};
    expect(env.AAI_BUNDLE_URL).toBe(`http://${HOST_ALIAS}:54321/storage/v1/object/sign/blobs/abc`);
    // One port set, from every value rewritten — the URL's AND the env's.
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
