// Copyright 2026 the AAI authors. MIT license.
/**
 * The Modal spawn path for DEPLOYED AGENTS — `spawnModalAgentServer`, against
 * an injected `ModalSpawnContext` (no real Modal calls).
 *
 * This is the one production path for every deployed agent, and it was the
 * lifecycle module with no test of its own. What it gets right is almost
 * entirely ORDERING and ENV, neither of which any other suite can see:
 *
 * - the boot artifacts land on the filesystem BEFORE the exec, because the
 *   guest reads and hash-verifies them at boot and nothing arrives over a
 *   channel afterwards (there is no channel — see "Agent guests are servers");
 * - the exec env carries the bundle digest the guest verifies against, a
 *   per-sandbox token, and the containment flag;
 * - a spawn that fails anywhere never leaks the sandbox.
 *
 * The complementary halves are covered elsewhere and deliberately not
 * duplicated here: the guest's side of the boot contract (hash mismatch, env
 * scrub, manage surface, drain, idle exit) is `aai-guest/
 * harness-agent-mode.test.ts`; `raceGuestExit` in isolation is
 * `guest-readiness.test.ts`; slot attach/detach is `sandbox.test.ts`.
 */

import { sleep } from "@alexkroman1/aai/internal";
import { CONTAINED_ENV } from "@alexkroman1/aai-runtime/internal";
import { describe, expect, it } from "vitest";
import {
  type FakeProc,
  makeCtx,
  makeFakeProc,
  makeFakeSandbox,
  makeHarnessFile,
} from "./_sandbox-vm-test-utils.ts";
import {
  AGENT_BUNDLE_REMOTE_PATH,
  AGENT_ENV_REMOTE_PATH,
  spawnModalAgentServer,
} from "./modal-agent-sandbox.ts";
import { GUEST_PORT, type ModalSpawnContext } from "./modal-context.ts";
import type { WorkerSource } from "./sandbox-vm.ts";

const WORKER = 'export default { name: "deployed" };';
/** Any 64-hex value: the host forwards it, the guest is what verifies it. */
const SHA = "a".repeat(64);

async function spawn(
  overrides: {
    ctx?: ModalSpawnContext;
    agentEnv?: Record<string, string>;
    imageTag?: string;
    name?: string;
    slug?: string;
    worker?: WorkerSource;
  } = {},
  fake?: FakeProc,
) {
  const proc = fake ?? makeFakeProc();
  const sb = makeFakeSandbox(proc);
  const harnessPath = await makeHarnessFile("// agent harness");
  const handle = await spawnModalAgentServer(
    {
      harnessPath,
      slug: overrides.slug ?? "deployed-agent",
      worker: overrides.worker ?? { kind: "inline", code: WORKER, sha256: SHA },
      agentEnv: overrides.agentEnv ?? { ASSEMBLYAI_API_KEY: "k" },
      name: overrides.name ?? "agent-abc123-v7",
      ...(overrides.imageTag ? { imageTag: overrides.imageTag } : {}),
    },
    overrides.ctx ?? makeCtx(sb),
  );
  return { handle, sb, proc };
}

/** The one exec the spawner issues — the harness boot. */
function execEnv(sb: Awaited<ReturnType<typeof spawn>>["sb"]): Record<string, string> {
  const call = sb.execCalls[0];
  if (!call) throw new Error("the harness was never exec'd");
  return call.params.env ?? {};
}

describe("spawnModalAgentServer", () => {
  // The kill has to be reachable BEFORE readiness, and this is the only place
  // that can see it: `sandbox.test.ts` mocks the spawner, so a backend that
  // stopped publishing `onSpawned` would leave `Sandbox.shutdown()` with
  // nothing to call and every one of its tests still green — which is how the
  // production race this closes went unseen (a DELETE dropped the app's
  // Postgres role while a ~17s boot was in flight, and the abandoned guest came
  // up to a `28P01` on credentials that had been valid at spawn).
  it("publishes a terminate before the guest is ready, and it really terminates", async () => {
    const proc = makeFakeProc();
    const sb = makeFakeSandbox(proc);
    const harnessPath = await makeHarnessFile("// agent harness");

    let killAtSpawn: (() => Promise<void>) | undefined;
    /** What the sandbox had done by the time the kill was handed over. */
    let execsWhenPublished = -1;
    let readyWhenPublished = true;
    let ready = false;
    const waitUntilReady = sb.waitUntilReady.bind(sb);
    sb.waitUntilReady = async (timeoutMs?: number) => {
      const result = await waitUntilReady(timeoutMs);
      ready = true;
      return result;
    };

    await spawnModalAgentServer(
      {
        harnessPath,
        slug: "killable",
        worker: { kind: "inline", code: WORKER, sha256: SHA },
        agentEnv: {},
        name: "agent-killable-v1",
        onSpawned: (terminate) => {
          killAtSpawn = terminate;
          execsWhenPublished = sb.execCalls.length;
          readyWhenPublished = ready;
        },
      },
      makeCtx(sb),
    );

    // Published at the earliest moment there is something to kill: the sandbox
    // exists, the harness has not been exec'd, and nothing has waited on the
    // readiness probe.
    expect(execsWhenPublished).toBe(0);
    expect(readyWhenPublished).toBe(false);

    expect(sb.terminate).not.toHaveBeenCalled();
    await killAtSpawn?.();
    expect(sb.terminate).toHaveBeenCalledTimes(1);
  });

  it("writes both boot artifacts CONCURRENTLY, and both before exec'ing the harness", async () => {
    // Two properties in one sequence, because they constrain each other.
    //
    // BEFORE is the correctness half and the contract: agent mode reads its
    // bundle and env from disk at boot, so an exec that raced the writes would
    // boot a guest with no agent. Nothing arrives afterwards — there is no
    // control channel.
    //
    // CONCURRENTLY is the latency half, and it needs its own assertion because
    // the obvious one cannot see it: the writes are issued in array order
    // either way, so a `write, write, exec` transcript reads identically
    // whether the second write waited for the first or not. Serialized, the
    // tiny env write paid a full Modal round trip queued behind the ~8 MB
    // bundle's, on the critical path of every cold session.
    const order: string[] = [];
    let writesInFlight = 0;
    let maxWritesInFlight = 0;
    const fake = makeFakeProc();
    const sb = makeFakeSandbox(fake);
    const write = sb.filesystem.writeText.bind(sb.filesystem);
    sb.filesystem.writeText = async (data, remotePath) => {
      order.push(`write:${remotePath}`);
      writesInFlight += 1;
      maxWritesInFlight = Math.max(maxWritesInFlight, writesInFlight);
      try {
        // A macrotask, not a microtask: a serialized caller resumes on the
        // first write's resolution, so only a real gap lets the second write
        // start while this one is still counted in flight.
        await sleep(0);
        await write(data, remotePath);
      } finally {
        writesInFlight -= 1;
      }
    };
    const exec = sb.exec.bind(sb);
    sb.exec = async (command, params) => {
      order.push("exec");
      return await exec(command, params);
    };

    const harnessPath = await makeHarnessFile();
    await spawnModalAgentServer(
      {
        harnessPath,
        slug: "ordered",
        worker: { kind: "inline", code: WORKER, sha256: SHA },
        agentEnv: {},
        name: "agent-ordered-v1",
      },
      makeCtx(sb),
    );

    expect(order).toEqual([
      `write:${AGENT_BUNDLE_REMOTE_PATH}`,
      `write:${AGENT_ENV_REMOTE_PATH}`,
      "exec",
    ]);
    expect(maxWritesInFlight).toBe(2);
  });

  it("starts the tunnel lookup before the boot-artifact writes", async () => {
    // The lookup needs nothing but the sandbox, so it belongs ahead of the
    // ~8 MB bundle write rather than beside the exec that follows it — that
    // way its round trip runs inside the write's window instead of after it.
    // Asserted on the SEQUENCE rather than on wall-clock: the win is entirely
    // in where the call is issued, and a timing assertion would only measure
    // the fake.
    const order: string[] = [];
    const fake = makeFakeProc();
    const sb = makeFakeSandbox(fake);
    const tunnels = sb.tunnels.bind(sb);
    sb.tunnels = async () => {
      order.push("tunnels");
      return await tunnels();
    };
    const write = sb.filesystem.writeText.bind(sb.filesystem);
    sb.filesystem.writeText = async (data, remotePath) => {
      order.push(`write:${remotePath}`);
      await write(data, remotePath);
    };

    const harnessPath = await makeHarnessFile();
    await spawnModalAgentServer(
      {
        harnessPath,
        slug: "tunnel-first",
        worker: { kind: "inline", code: WORKER, sha256: SHA },
        agentEnv: {},
        name: "agent-tunnel-first-v1",
      },
      makeCtx(sb),
    );

    expect(order[0]).toBe("tunnels");
  });

  it("does not leave the tunnel lookup unhandled when a boot write fails", async () => {
    // The lookup is started before the writes and awaited after the exec, so a
    // write that throws skips the await entirely. Without the containing
    // `.catch`, a tunnel lookup that rejects afterwards takes the process down
    // via unhandledRejection — a spawn failure turning into a server crash.
    const fake = makeFakeProc();
    const sb = makeFakeSandbox(fake);
    const { promise: tunnelFailure, reject: failTunnels } =
      Promise.withResolvers<Record<number, { host: string; port: number }>>();
    sb.tunnels = () => tunnelFailure;
    sb.filesystem.writeText = () => Promise.reject(new Error("write refused"));

    const unhandled: unknown[] = [];
    const onUnhandled = (err: unknown): void => {
      unhandled.push(err);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const harnessPath = await makeHarnessFile();
      await expect(
        spawnModalAgentServer(
          {
            harnessPath,
            slug: "write-fails",
            worker: { kind: "inline", code: WORKER, sha256: SHA },
            agentEnv: {},
            name: "agent-write-fails-v1",
          },
          makeCtx(sb),
        ),
      ).rejects.toThrow("write refused");
      failTunnels(new Error("tunnel lookup failed"));
      // Unhandled rejections are reported a macrotask after the fact.
      await sleep(0);
      await sleep(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }

    expect(unhandled).toEqual([]);
    expect(sb.terminate).toHaveBeenCalled();
  });

  it("delivers the worker bundle and the agent env as files", async () => {
    const { sb } = await spawn({ agentEnv: { ASSEMBLYAI_API_KEY: "k", EXTRA: "1" } });
    expect(sb.files.get(AGENT_BUNDLE_REMOTE_PATH)).toBe(WORKER);
    // JSON, because the guest parses it and then deletes the file.
    expect(JSON.parse(sb.files.get(AGENT_ENV_REMOTE_PATH) ?? "null")).toEqual({
      ASSEMBLYAI_API_KEY: "k",
      EXTRA: "1",
    });
  });

  it("forwards the bundle digest the guest verifies against", async () => {
    // A guest whose delivered bundle does not match this digest refuses to
    // boot (harness-agent-mode.test.ts). That guard is worth nothing if the
    // host forwards the wrong digest, or none.
    const { sb } = await spawn();
    expect(execEnv(sb).AAI_BUNDLE_SHA256).toBe(SHA);
    expect(execEnv(sb).AAI_BUNDLE_PATH).toBe(AGENT_BUNDLE_REMOTE_PATH);
    expect(execEnv(sb).AAI_AGENT_ENV_PATH).toBe(AGENT_ENV_REMOTE_PATH);
  });

  it("declares containment, so the guest's builtins skip the SSRF screen", async () => {
    // Containment is DECLARED by the spawner, never sniffed by the guest: the
    // subprocess backend runs a guest with no container at all, so inferring
    // it would open egress on a developer's machine. `ssrf.test.ts` pins the
    // consuming half (flag → which fetch); this is the half that sets it.
    const { sb } = await spawn();
    expect(execEnv(sb)[CONTAINED_ENV]).toBe("1");
  });

  it("derives the manage token from the sandbox NAME, delivered on the EXEC env", async () => {
    // The tunnel URL is public, so this token is the only thing gating
    // /manage/*. On the exec env rather than the sandbox's, so it is not
    // visible to anything else that might later run in the container.
    //
    // Derived rather than random, which is what lets a replica that did NOT
    // spawn this sandbox still read its logs — see guest-token.ts. So the
    // property is reproducibility from the name, not per-spawn uniqueness.
    const first = await spawn({ name: "agent-aaa-v1" });
    const again = await spawn({ name: "agent-aaa-v1" });
    const other = await spawn({ name: "agent-bbb-v1" });
    const a = execEnv(first.sb).AAI_GUEST_TOKEN;
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(execEnv(again.sb).AAI_GUEST_TOKEN).toBe(a);
    // Distinct per NAME: one leaked token must not open another guest's manage
    // surface, and a redeploy bumps the version half of the name. (The handle
    // deliberately does not expose it — it is the host's to spend on /manage/*.)
    expect(execEnv(other.sb).AAI_GUEST_TOKEN).not.toBe(a);
  });

  it("creates the sandbox under its fleet-wide name, with a readiness probe", async () => {
    // The name is what makes Modal itself refuse a second sandbox for one
    // deploy (see sandbox-directory.ts) — there is no lease table behind it.
    const fake = makeFakeProc();
    const sb = makeFakeSandbox(fake);
    const params: Record<string, unknown>[] = [];
    const ctx: ModalSpawnContext = {
      lookupGuestSandbox: () => Promise.resolve(null),
      prepareGuestImage: () => Promise.resolve(),
      createGuestSandbox: async (_code, p) => {
        params.push(p as unknown as Record<string, unknown>);
        return sb;
      },
    };
    const harnessPath = await makeHarnessFile();
    await spawnModalAgentServer(
      {
        harnessPath,
        slug: "named",
        worker: { kind: "inline", code: WORKER, sha256: SHA },
        agentEnv: {},
        name: "agent-deadbeef-v3",
      },
      ctx,
    );
    expect(params[0]?.name).toBe("agent-deadbeef-v3");
    // Readiness is Modal's to evaluate inside the container, and the guest
    // binds its port only after loading the bundle — so the probe passing
    // means "sessions can be served".
    expect(params[0]?.readinessProbe).toBeDefined();
    expect(params[0]?.encryptedPorts).toEqual([GUEST_PORT]);
  });

  it("spawns from the deploy's pinned harness image", async () => {
    // Per-deploy environment pinning: a platform upgrade must not change the
    // image under an already-deployed bundle.
    const tags: (string | undefined)[] = [];
    const fake = makeFakeProc();
    const sb = makeFakeSandbox(fake);
    const ctx: ModalSpawnContext = {
      lookupGuestSandbox: () => Promise.resolve(null),
      prepareGuestImage: () => Promise.resolve(),
      createGuestSandbox: async (_code, _p, imageTag) => {
        tags.push(imageTag);
        return sb;
      },
    };
    const harnessPath = await makeHarnessFile();
    await spawnModalAgentServer(
      {
        harnessPath,
        slug: "pinned",
        worker: { kind: "inline", code: WORKER, sha256: SHA },
        agentEnv: {},
        name: "agent-pinned-v1",
        imageTag: "aai-guest-harness:cafebabe",
      },
      ctx,
    );
    expect(tags).toEqual(["aai-guest-harness:cafebabe"]);
  });

  it("fails the spawn and terminates the sandbox when the guest exits at boot", async () => {
    // The readiness wait is raced against process exit, so a bundle that
    // throws at load fails HERE with the guest's own reason — rather than
    // burning the whole readiness budget and blaming the network. And a
    // sandbox whose agent never came up must not be left billing.
    const fake = makeFakeProc();
    const sb = makeFakeSandbox(fake);
    sb.waitUntilReady = () => new Promise<void>(() => undefined);
    const harnessPath = await makeHarnessFile();
    fake.exit(1);

    await expect(
      spawnModalAgentServer(
        {
          harnessPath,
          slug: "crashes",
          worker: { kind: "inline", code: WORKER, sha256: SHA },
          agentEnv: {},
          name: "agent-crashes-v1",
        },
        makeCtx(sb),
      ),
    ).rejects.toThrow(/Modal agent-server spawn failed/);
    expect(sb.terminate).toHaveBeenCalled();
  });

  it("fails the spawn and terminates the sandbox when no tunnel exists", async () => {
    const fake = makeFakeProc();
    const sb = makeFakeSandbox(fake);
    sb.tunnels = () => Promise.resolve({});
    const harnessPath = await makeHarnessFile();

    await expect(
      spawnModalAgentServer(
        {
          harnessPath,
          slug: "untunneled",
          worker: { kind: "inline", code: WORKER, sha256: SHA },
          agentEnv: {},
          name: "agent-untunneled-v1",
        },
        makeCtx(sb),
      ),
    ).rejects.toThrow(/no tunnel for guest port/);
    expect(sb.terminate).toHaveBeenCalled();
  });

  it("hands back a handle on the guest's own tunnel origin", async () => {
    const { handle } = await spawn();
    // wss:, because the manage surface and the public session surface are both
    // reached through Modal's TLS-terminating tunnel.
    expect(handle.guestOrigin).toBe("wss://tunnel.modal.test:12345");
  });
});
