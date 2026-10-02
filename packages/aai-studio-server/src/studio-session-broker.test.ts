// Copyright 2026 the AAI authors. MIT license.
/**
 * The studio session broker's lifecycle: refresh, the per-project lock,
 * evict, and the cross-replica adopt ladder. The local reuse → spawn ladder is
 * studio-session-ensure.test.ts, the guest RPCs studio-session-wire.test.ts,
 * and the `workspace/deploy` (Publish) path studio-session-publish.test.ts;
 * all share the fakes in _studio-session-test-utils.ts.
 */

import { omitUndefined } from "@alexkroman1/aai/utils";
import { createMemoryChatStore, createMemoryWorkspaceStore } from "aai-server/stores";
import { describe, expect, onTestFinished, test, vi } from "vitest";
import {
  type FakeGuest,
  fakeGuest,
  fakeSpawn,
  makeBroker,
  PROJECT,
  SCOPE,
} from "./_studio-session-test-utils.ts";
import { createMemoryPreviewQueue } from "./studio-preview-queue.ts";
import type { adoptPeerSession } from "./studio-session-adopt.ts";
import { createStudioSessionBroker } from "./studio-session-broker.ts";
import { createMemoryStudioSessionRegistry } from "./studio-session-registry.ts";
import { createWorkspace, syncWorkspaceSource } from "./studio-workspace.ts";

describe("studio session broker", () => {
  test("refreshSession re-installs a live sandbox with the pushed files", async () => {
    // `aai push` writes the workspace from outside the studio. The live
    // guest materialized its tree at install, so without this the agent
    // reads pre-push files — and syncs them back at end of turn.
    const guest = fakeGuest();
    const { broker, workspaces, spawn } = await makeBroker([guest]);
    await broker.ensureSession(SCOPE, PROJECT, "k");
    await syncWorkspaceSource(workspaces, SCOPE, PROJECT, { "agent.ts": "// pushed" });

    expect(await broker.refreshSession(SCOPE, PROJECT, "k")).toBe(true);
    expect(spawn).toHaveBeenCalledTimes(1);
    const inits = guest.requests.filter((r) => r.method === "studio/session-init");
    expect(inits).toHaveLength(2);
    const reinit = (inits[1]?.params ?? {}) as { files?: Record<string, string> };
    expect(reinit.files?.["agent.ts"]).toBe("// pushed");
    await broker.dispose();
  });

  test("refreshSession never spawns — no live sandbox means nothing is stale", async () => {
    const { broker, spawn } = await makeBroker([fakeGuest()]);
    expect(await broker.refreshSession(SCOPE, PROJECT, "k")).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
    await broker.dispose();
  });

  const TARGET = { serverUrl: "https://platform.example", apiKey: "caller-key", slug: "proj" };

  test("deployWorkspace reuses the project's live sandbox", async () => {
    const guest = fakeGuest();
    const { broker, spawn } = await makeBroker([guest]);
    await broker.ensureSession(SCOPE, PROJECT, "k");
    const outcome = await broker.deployWorkspace(SCOPE, PROJECT, { "agent.ts": "x" }, TARGET);
    expect(outcome).toEqual({
      ok: true,
      slug: "proj",
      url: "https://platform.example/proj",
      output: "Deployed https://platform.example/proj",
    });
    // Rode the live session sandbox — nothing new spawned.
    expect(spawn).toHaveBeenCalledTimes(1);
    const deploy = guest.requests.find((r) => r.method === "workspace/deploy");
    expect(deploy?.params).toEqual({
      files: { "agent.ts": "x" },
      serverUrl: "https://platform.example",
      apiKey: "caller-key",
      slug: "proj",
      skipTypecheck: false,
    });
  });

  test("deployWorkspace without a live session uses an ephemeral sandbox", async () => {
    const guest = fakeGuest();
    const { broker, spawn } = await makeBroker([guest]);
    const outcome = await broker.deployWorkspace(SCOPE, PROJECT, { "agent.ts": "x" }, TARGET);
    expect(outcome.ok).toBe(true);
    expect(spawn).toHaveBeenCalledTimes(1);
    // Torn down after the publish — no orphaned sandbox for the broker to own.
    expect(guest.disposed()).toBe(true);
  });

  test("deployWorkspace passes a failed CLI run through as-is", async () => {
    const guest = fakeGuest();
    (guest.warm.conn as { sendRequest: unknown }).sendRequest = async () => ({
      ok: false,
      output: "Build failed:\nagent.ts:1: oops",
    });
    const { broker } = await makeBroker([guest]);
    const outcome = await broker.deployWorkspace(SCOPE, PROJECT, { "agent.ts": "x" }, TARGET);
    expect(outcome).toEqual({ ok: false, output: "Build failed:\nagent.ts:1: oops" });
  });

  test("deployWorkspace rejects a malformed guest response", async () => {
    const guest = fakeGuest();
    (guest.warm.conn as { sendRequest: unknown }).sendRequest = async () => ({ ok: "yes" });
    const { broker } = await makeBroker([guest]);
    const outcome = await broker.deployWorkspace(SCOPE, PROJECT, { "agent.ts": "x" }, TARGET);
    expect(outcome).toMatchObject({
      ok: false,
      output:
        "Malformed deploy response from sandbox: ok: Invalid input: expected boolean, received string; output: Invalid input: expected string, received undefined",
    });
    // Not the JSON blob (see sync-workspace) — the Publish menu renders this
    // string to the user verbatim.
    expect(outcome.output).not.toContain("\n");
    expect(outcome.output).not.toContain('"code"');
  });

  /**
   * Two `POST /studio/projects/:project/session` calls for one project can
   * overlap (double-click, a StrictMode double-effect, a refresh landing on
   * an in-flight broker). Unserialized, both take the cold path and the
   * loser's sandbox is orphaned: it never lands in `sessions`, so neither
   * the idle sweeper nor `dispose()` can reach it — it burns its orphan
   * timeout billed, while its still-wired `studio/sync-workspace` handler
   * keeps writing the project behind the tracked sandbox's back.
   */
  test("concurrent sessions for one project share a single sandbox", async () => {
    const first = fakeGuest();
    const second = fakeGuest("wss://tunnel2.example:443");
    const { broker, spawn } = await makeBroker([first, second]);

    const [a, b] = await Promise.all([
      broker.ensureSession(SCOPE, PROJECT, "k"),
      broker.ensureSession(SCOPE, PROJECT, "k"),
    ]);

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(a?.url).toBe(b?.url);
    // The unused guest was never spawned, so nothing is left untracked.
    expect(second.disposed()).toBe(false);
    await broker.dispose();
    expect(first.disposed()).toBe(true);
  });

  test("sessions for different projects are not serialized against each other", async () => {
    const first = fakeGuest();
    const second = fakeGuest("wss://tunnel2.example:443");
    const { broker, workspaces, spawn } = await makeBroker([first, second]);
    await createWorkspace(workspaces, SCOPE, "other", {
      kind: "agent",
      files: { "agent.ts": "// o" },
    });

    const [a, b] = await Promise.all([
      broker.ensureSession(SCOPE, PROJECT, "k"),
      broker.ensureSession(SCOPE, "other", "k"),
    ]);

    expect(spawn).toHaveBeenCalledTimes(2);
    expect(a?.url).not.toBe(b?.url);
    await broker.dispose();
  });

  /**
   * `deployWorkspace` drops the project's entry when its sandbox fails
   * mid-publish. That cleanup runs after an await, so it must remove its OWN
   * entry — by then the client may have re-brokered and installed a
   * replacement, and evicting that one strands a live sandbox nothing owns.
   */
  test("a failed publish does not evict a session installed while it ran", async () => {
    const first = fakeGuest();
    const second = fakeGuest("wss://tunnel2.example:443");
    const stalledDeploy = Promise.withResolvers<never>();
    (first.warm.conn as { sendRequest: unknown }).sendRequest = (method: string) => {
      if (method === "workspace/deploy") return stalledDeploy.promise;
      // Once the sandbox is gone, re-init rejects — as the real one does.
      return first.disposed()
        ? Promise.reject(new Error("Connection disposed"))
        : Promise.resolve({ ok: true });
    };

    // 3rd: the ephemeral sandbox the failed publish retries on. A 4th is
    // only ever reached if the publish's cleanup evicted the replacement.
    const ephemeral = fakeGuest("wss://tunnel3.example:443");
    const fourth = fakeGuest("wss://tunnel4.example:443");
    const { broker } = await makeBroker([first, second, ephemeral, fourth]);
    await broker.ensureSession(SCOPE, PROJECT, "k");

    // Publish starts against the live sandbox and stalls.
    const publish = broker.deployWorkspace(SCOPE, PROJECT, { "agent.ts": "x" }, TARGET);
    // The sandbox dies, the client re-brokers, a replacement is installed.
    await first.warm[Symbol.asyncDispose]();
    const replacement = await broker.ensureSession(SCOPE, PROJECT, "k");
    expect(replacement?.url).toBe("https://tunnel2.example/studio/chat");

    // Only now does the stalled publish notice and run its cleanup.
    stalledDeploy.reject(new Error("sandbox gone"));
    await publish.catch(() => undefined);

    // The replacement must still be the project's session — reusable, and
    // reachable by dispose().
    const after = await broker.ensureSession(SCOPE, PROJECT, "k");
    expect(after?.url).toBe("https://tunnel2.example/studio/chat");
    await broker.dispose();
    expect(second.disposed()).toBe(true);
  });
});

describe("cross-replica studio sessions", () => {
  /** A broker wired as one replica of a fleet sharing `registry`. */
  async function makeReplica(
    replicaId: string,
    guests: FakeGuest[],
    shared: {
      workspaces: ReturnType<typeof createMemoryWorkspaceStore>;
      chats: ReturnType<typeof createMemoryChatStore>;
      registry: ReturnType<typeof createMemoryStudioSessionRegistry>;
    },
    adopt?: typeof adoptPeerSession,
  ) {
    const spawn = fakeSpawn(guests);
    const broker = createStudioSessionBroker({
      workspaces: shared.workspaces,
      chats: shared.chats,
      registry: shared.registry,
      replicaId,
      spawn,
      harnessPath: "/fake/harness.mjs",
      previewQueue: createMemoryPreviewQueue(),
      ...omitUndefined({ adopt }),
    });
    return { broker, spawn };
  }

  async function sharedFleet(leaseMs?: number) {
    const workspaces = createMemoryWorkspaceStore();
    const chats = createMemoryChatStore();
    await createWorkspace(workspaces, SCOPE, PROJECT, {
      kind: "agent",
      files: { "agent.ts": "// v1" },
    });
    return {
      workspaces,
      chats,
      registry: createMemoryStudioSessionRegistry(leaseMs === undefined ? {} : { leaseMs }),
    };
  }

  test("a second replica adopts the first's sandbox instead of spawning", async () => {
    // The reported bug, at the studio layer: replica B's `sessions` map is
    // empty, so before the registry it took the cold path and spawned a
    // duplicate guest for a project already running on replica A.
    const shared = await sharedFleet();
    const guestA = fakeGuest("wss://guest-a.example:443");
    const a = await makeReplica("replica-a", [guestA], shared);
    const first = await a.broker.ensureSession(SCOPE, PROJECT, "caller-key");

    // Typed as the real peer install, so the params it was handed are read off
    // the fake's own recorded call rather than re-narrowed by a cast — which
    // would stop reporting the day `AdoptSessionParams` gains a field.
    const adopt = vi.fn<typeof adoptPeerSession>(async () => ({
      url: "https://guest-a.example/studio/chat",
      token: first?.token as string,
    }));
    const b = await makeReplica(
      "replica-b",
      [fakeGuest("wss://guest-b.example:443")],
      shared,
      adopt,
    );
    const second = await b.broker.ensureSession(SCOPE, PROJECT, "caller-key");

    expect(b.spawn).not.toHaveBeenCalled();
    // Same URL and the SAME chat token — a tab brokered by either replica
    // must be able to keep using the token it already holds.
    expect(second).toEqual(first);
    // And the peer got the workspace, so it never edits a stale tree.
    expect(adopt.mock.calls[0]?.[1].files).toEqual({ "agent.ts": "// v1" });
  });

  test("a peer whose guest is unreachable falls back to a local spawn", async () => {
    const shared = await sharedFleet();
    const guestA = fakeGuest("wss://guest-a.example:443");
    const a = await makeReplica("replica-a", [guestA], shared);
    await a.broker.ensureSession(SCOPE, PROJECT, "caller-key");

    const adopt = vi.fn<typeof adoptPeerSession>(async () => null);
    const guestB = fakeGuest("wss://guest-b.example:443");
    const b = await makeReplica("replica-b", [guestB], shared, adopt);
    const session = await b.broker.ensureSession(SCOPE, PROJECT, "caller-key");

    expect(adopt).toHaveBeenCalled();
    expect(b.spawn).toHaveBeenCalledTimes(1);
    expect(session?.url).toBe("https://guest-b.example/studio/chat");
    // The dead row was dropped and replaced by the new owner's.
    expect(await shared.registry.get(SCOPE, PROJECT)).toMatchObject({ owner: "replica-b" });
  });

  test("the owning replica reuses its own sandbox rather than adopting", async () => {
    const shared = await sharedFleet();
    const guest = fakeGuest();
    const adopt = vi.fn<typeof adoptPeerSession>(async () => null);
    const a = await makeReplica("replica-a", [guest], shared, adopt);
    await a.broker.ensureSession(SCOPE, PROJECT, "caller-key");
    await a.broker.ensureSession(SCOPE, PROJECT, "caller-key");
    expect(a.spawn).toHaveBeenCalledTimes(1);
    expect(adopt).not.toHaveBeenCalled();
  });

  test("a cold spawn claims the registry row with the guest's own credentials", async () => {
    const shared = await sharedFleet();
    const guest = fakeGuest("wss://guest-a.example:443");
    const a = await makeReplica("replica-a", [guest], shared);
    const session = await a.broker.ensureSession(SCOPE, PROJECT, "caller-key");
    expect(await shared.registry.get(SCOPE, PROJECT)).toEqual({
      chatUrl: session?.url,
      chatToken: session?.token,
      guestOrigin: "wss://guest-a.example:443",
      sandboxToken: "sandbox-token",
      owner: "replica-a",
    });
  });

  /**
   * The reported bug: `reuseSession` moved `lastUsed` and touched nothing on
   * the fleet, so a user reloading every few minutes without completing a turn
   * kept the sandbox locally fresh while `expires_at` ran out under it. The
   * next broker call landing on a PEER read `sessions` miss → `fleet.adopt` →
   * `registry.get` null → cold path → `spawnNamed` → Modal refuses the
   * duplicate name → null → **404 "Project not found"** for a live project.
   *
   * Asserted as EXPIRY rather than as a `touch` call count: the invariant is
   * that the row outlives a lease window a reuse spans, which is what a peer
   * actually reads.
   */
  test("reusing a sandbox refreshes the fleet lease", async () => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const lease = 10_000;
    const shared = await sharedFleet(lease);
    const a = await makeReplica("replica-a", [fakeGuest("wss://guest-a.example:443")], shared);
    const first = await a.broker.ensureSession(SCOPE, PROJECT, "caller-key");

    // Two reloads, each well inside the lease but together well past it.
    vi.advanceTimersByTime(lease * 0.7);
    await a.broker.ensureSession(SCOPE, PROJECT, "caller-key");
    vi.advanceTimersByTime(lease * 0.7);

    // The row is what a peer reads. Untouched, it expired one reload ago.
    expect(await shared.registry.get(SCOPE, PROJECT)).toMatchObject({ owner: "replica-a" });

    const adopt = vi.fn<typeof adoptPeerSession>(async () => ({
      url: "https://guest-a.example/studio/chat",
      token: first?.token as string,
    }));
    const b = await makeReplica(
      "replica-b",
      [fakeGuest("wss://guest-b.example:443")],
      shared,
      adopt,
    );
    expect(await b.broker.ensureSession(SCOPE, PROJECT, "caller-key")).toEqual(first);
    expect(adopt).toHaveBeenCalled();
    // The failure this prevents: a cold spawn under a name Modal refuses.
    expect(b.spawn).not.toHaveBeenCalled();
  });

  test("disposing releases the row so the next broker call spawns fresh", async () => {
    const shared = await sharedFleet();
    const a = await makeReplica("replica-a", [fakeGuest()], shared);
    await a.broker.ensureSession(SCOPE, PROJECT, "caller-key");
    await a.broker.dispose();
    expect(await shared.registry.get(SCOPE, PROJECT)).toBeNull();
  });
});
