// Copyright 2026 the AAI authors. MIT license.
/**
 * The agents-row change stream driving sandbox invalidation
 * (`watchAgentInvalidation` in sandbox-invalidate.ts): blue-green handover on
 * a deploy, termination on a delete, and the REJOIN resync that covers what
 * the stream could not deliver while it was down.
 *
 * Split from sandbox-resolve.test.ts, which keeps the resolution/broker paths
 * — the same cut the source made.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryPlatformEvents } from "./platform-events.ts";
import type { Sandbox } from "./sandbox.ts";
import { watchAgentInvalidation } from "./sandbox-invalidate.ts";
import { resolveSandbox } from "./sandbox-resolve.ts";
import { createSlotCache } from "./sandbox-slots.ts";
import { captureLogs, createTestStore, spawnedAgent } from "./test-utils.ts";

const { mockSpawnAgentServer } = vi.hoisted(() => {
  const mockSpawnAgentServer = vi.fn();
  return { mockSpawnAgentServer };
});

vi.mock("./sandbox-vm.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./sandbox-vm.ts")>()),
  spawnAgentServer: mockSpawnAgentServer,
}));

// Armed here rather than in the `vi.hoisted` factory above — see `spawnedAgent`.
beforeEach(() => {
  mockSpawnAgentServer.mockReset().mockResolvedValue(spawnedAgent());
});

async function seedAgent(slug: string) {
  const memory = createMemoryPlatformEvents();
  // The real signal that a change event has been delivered AND its handler
  // has finished — this file used to spin 20 microtasks and hope.
  const settleEvents = (): Promise<void> => memory.settled();
  // Models a Realtime OUTAGE, which is the one thing the memory emitter cannot
  // do on its own: the row write still lands, its notification is simply not
  // delivered. Dropping the emit rather than the write is the whole point —
  // the database is the source of truth and stays correct; what breaks is this
  // replica's knowledge of it.
  let streamDown = false;
  const store = createTestStore(undefined, {
    ...memory,
    emitAgent: (changed: string) => {
      if (!streamDown) memory.emitAgent(changed);
    },
  });
  const put = (worker: string) =>
    store.putAgent({
      slug,
      env: {},
      worker,
      clientFiles: {},
      credential_hashes: ["hash"],
    });
  await put('export default { name: "t" };');
  await settleEvents();
  // Spy that calls through: the watcher's cache drop must actually happen
  // for the rebuild to read the freshly deployed record.
  const invalidate = vi.spyOn(store, "invalidate");
  const deps = { slots: createSlotCache(), store };
  const unwatch = watchAgentInvalidation(memory.events, deps);
  return {
    ...deps,
    invalidate,
    unwatch,
    settleEvents,
    /**
     * Write a new deploy's row WITHOUT waiting for the change event to be
     * handled. Separate from `redeploy` because the handler queues on the
     * slug lock: a caller holding that lock must commit, release, and only
     * then settle — awaiting settlement first deadlocks.
     */
    commitDeploy: () => put('export default { name: "t2" };'),
    redeploy: async () => {
      await put('export default { name: "t2" };');
      await settleEvents();
    },
    /** A duplicated/self-echoed change event with no row change behind it. */
    reEmit: async () => {
      memory.emitAgent(slug);
      await settleEvents();
    },
    deleteAgent: async () => {
      await store.deleteAgent(slug);
      await settleEvents();
    },
    /** Take the change stream down / bring it back — see `streamDown`. */
    setStreamDown: (down: boolean) => {
      streamDown = down;
    },
    /** The stream re-joined: `subscribe()` acked SUBSCRIBED. */
    rejoin: async () => {
      memory.emitAgentResync();
      await settleEvents();
    },
  };
}

describe("agents-row change stream drives sandbox invalidation", () => {
  const logs = captureLogs();
  it("reuses the resident sandbox while nothing changed", async () => {
    const deps = await seedAgent("stable");
    const first = await resolveSandbox("stable", deps);
    // The cold rebuild itself reads fresh (one invalidate); a warm resident
    // costs nothing more.
    deps.invalidate.mockClear();
    const second = await resolveSandbox("stable", deps);
    expect(second).toBe(first);
    expect(deps.invalidate).not.toHaveBeenCalled();
    await first?.shutdown();
    deps.unwatch();
  });

  it("a deploy's change event hands over BLUE-GREEN: the replacement is attached before the old resident detaches", async () => {
    const deps = await seedAgent("redeployed");
    const first = await resolveSandbox("redeployed", deps);
    expect(first).not.toBeNull();

    // A deploy elsewhere upserts the agents row → change event. The handler
    // boots the NEW deploy's sandbox, waits for its readiness, and swaps —
    // the slot is never empty, so the next caller pays no cold start.
    await deps.redeploy();

    const replacement = deps.slots.get("redeployed")?.sandbox;
    expect(replacement).toBeDefined();
    expect(replacement).not.toBe(first);
    // The rebuild read a fresh row, not a pre-mutation cached one.
    expect(deps.invalidate).toHaveBeenCalledWith("redeployed");

    // The broker serves the ready replacement as-is — no rebuild, and its
    // own deploy event (already handled) leaves it alone.
    await expect(resolveSandbox("redeployed", deps)).resolves.toBe(replacement);
    await (replacement as Sandbox).shutdown();
    deps.unwatch();
  });

  it("a replacement that fails to boot retires the old resident — the failure stays visible", async () => {
    const deps = await seedAgent("bad-redeploy");
    const first = (await resolveSandbox("bad-redeploy", deps)) as Sandbox;
    expect(first).not.toBeNull();
    const drain = vi.spyOn(first, "drain");
    const shutdown = vi.spyOn(first, "shutdown");

    // The NEW deploy crashes on boot. Blue-green must not cut over to a
    // corpse, and must not keep serving superseded code silently either:
    // the old resident retires and the slot empties, so the next broker
    // call rebuilds and surfaces the boot failure.
    mockSpawnAgentServer.mockReturnValueOnce(Promise.reject(new Error("boot crash")));
    await deps.redeploy();

    await vi.waitFor(() => {
      expect(deps.slots.get("bad-redeploy")?.sandbox).toBeUndefined();
    });
    // RETIRED, not killed. An empty slot on its own says nothing about how the
    // old guest went — a straight `shutdown()` empties it identically — and
    // cutting a guest that is serving live calls because SOMEONE ELSE's boot
    // crashed is the failure this branch exists to avoid. Same claim, same
    // shape, as the success-path handover below.
    await vi.waitFor(() => {
      expect(drain).toHaveBeenCalledWith(expect.any(Number));
    });
    expect(shutdown).not.toHaveBeenCalled();
    deps.unwatch();
  });

  it("a duplicated change event does not touch a resident already at the row's version", async () => {
    const deps = await seedAgent("self-echo");
    const sandbox = await resolveSandbox("self-echo", deps);
    expect(sandbox).not.toBeNull();
    // A duplicated (or reordered) event re-reads the version, compares it
    // against the slot's stamp, and leaves the current resident alone.
    await deps.reEmit();
    expect(deps.slots.get("self-echo")?.sandbox).toBe(sandbox);
    await sandbox?.shutdown();
    deps.unwatch();
  });

  // ── Rejoin resync ─────────────────────────────────────────────────────────
  //
  // `subscribe()` only SENDS the join; nothing is delivered until the server
  // acks it, and realtime-js rejoins after any socket drop. Because this
  // stream is the only thing that moves resident sandboxes — the per-broker
  // version check and the idle sweep's superseded probe were both deleted when
  // it took the job — a change inside that window reaches nobody and nothing
  // later notices. So the join itself has to be a signal.

  it("a deploy missed during a stream outage is reconciled on the rejoin", async () => {
    const deps = await seedAgent("missed-deploy");
    const first = await resolveSandbox("missed-deploy", deps);
    expect(first).not.toBeNull();

    // The socket drops, a deploy lands elsewhere, and this replica hears
    // nothing: it keeps serving the superseded bundle indefinitely, because
    // the guest stays non-idle exactly while it is busy.
    deps.setStreamDown(true);
    await deps.commitDeploy();
    await deps.settleEvents();
    expect(deps.slots.get("missed-deploy")?.sandbox).toBe(first);

    // The rejoin is the only notification that will ever come.
    deps.setStreamDown(false);
    await deps.rejoin();

    const replacement = deps.slots.get("missed-deploy")?.sandbox;
    expect(replacement).toBeDefined();
    expect(replacement).not.toBe(first);
    await (replacement as Sandbox).shutdown();
    deps.unwatch();
  });

  it("a delete missed during a stream outage is reconciled on the rejoin", async () => {
    const deps = await seedAgent("missed-delete");
    const first = (await resolveSandbox("missed-delete", deps)) as Sandbox;
    const shutdown = vi.spyOn(first, "shutdown");

    // A deleted agent that keeps answering is the worse half of this bug —
    // it serves a slug the platform no longer knows about.
    deps.setStreamDown(true);
    await deps.deleteAgent();
    expect(shutdown).not.toHaveBeenCalled();

    deps.setStreamDown(false);
    await deps.rejoin();

    expect(shutdown).toHaveBeenCalled();
    expect(deps.slots.get("missed-delete")).toBeUndefined();
    deps.unwatch();
  });

  it("a rejoin with nothing stale leaves the resident alone", async () => {
    const deps = await seedAgent("still-current");
    const sandbox = await resolveSandbox("still-current", deps);
    expect(sandbox).not.toBeNull();

    // Every reconnect fires this, so the common case must be a cheap re-read
    // that changes nothing — not a respawn of every resident on the replica.
    await deps.rejoin();

    expect(deps.slots.get("still-current")?.sandbox).toBe(sandbox);
    await sandbox?.shutdown();
    deps.unwatch();
  });

  it("a rejoin with no residents does no work at all", async () => {
    const deps = await seedAgent("untouched");
    // The join fires on every replica, including ones that have brokered
    // nothing — the cost there must be zero reads, not one per agent row.
    deps.invalidate.mockClear();
    await deps.rejoin();
    expect(deps.invalidate).not.toHaveBeenCalled();
    deps.unwatch();
  });

  it("a delete's change event terminates the resident and drops the slot", async () => {
    const deps = await seedAgent("gone");
    const first = (await resolveSandbox("gone", deps)) as Sandbox;
    expect(first).not.toBeNull();
    const shutdown = vi.spyOn(first, "shutdown");

    await deps.deleteAgent();

    // Terminated (a deleted agent must stop answering), slot dropped, and
    // the next resolve finds no record → 404 upstream.
    expect(shutdown).toHaveBeenCalled();
    expect(deps.slots.get("gone")).toBeUndefined();
    await expect(resolveSandbox("gone", deps)).resolves.toBeNull();
    deps.unwatch();
  });

  it("a deploy landing mid-rebuild is not dropped: the event queues on the slug lock and retires the stale build", async () => {
    const deps = await seedAgent("mid-rebuild");
    // Park the rebuild between its record read and the sandbox attach.
    const { promise: gate, resolve: release } = Promise.withResolvers<void>();
    const realGetWorkerCode = deps.store.getWorkerCode.bind(deps.store);
    deps.store.getWorkerCode = async (slug) => {
      await gate;
      return realGetWorkerCode(slug);
    };

    const resolving = resolveSandbox("mid-rebuild", deps);
    // NOT an event wait — nothing has been emitted yet. This waits for the
    // parked rebuild to reach its slot claim, which happens before any read,
    // so the event pre-filter below sees a slot with no sandbox attached.
    await vi.waitFor(() => expect(deps.slots.get("mid-rebuild")).toBeDefined());
    expect(deps.slots.get("mid-rebuild")?.sandbox).toBeUndefined();

    // A deploy elsewhere commits while the rebuild is in flight. Its change
    // event queues behind the rebuild's slug lock instead of being skipped —
    // so the commit cannot be settled until the rebuild releases the lock.
    await deps.commitDeploy();
    release();
    const stale = await resolving;
    expect(stale).not.toBeNull();

    // The queued handler ran after the attach: version mismatch → blue-green
    // handover to a replacement at the row's current version.
    await deps.settleEvents();
    const fresh = deps.slots.get("mid-rebuild")?.sandbox;
    expect(fresh).toBeDefined();
    expect(fresh).not.toBe(stale);
    await expect(resolveSandbox("mid-rebuild", deps)).resolves.toBe(fresh);
    await (fresh as Sandbox).shutdown();
    deps.unwatch();
  });

  it("a failed rebuild of an unknown slug leaves no empty slot behind", async () => {
    const deps = await seedAgent("known");
    await expect(resolveSandbox("never-deployed", deps)).resolves.toBeNull();
    expect(deps.slots.get("never-deployed")).toBeUndefined();
    deps.unwatch();
  });

  it("nor does a rebuild for a slug that was deleted since it was last served", async () => {
    // The half the `created` guard missed: a slot that ALREADY existed and has
    // no sandbox (its guest exited, or the delete event tore the sandbox off)
    // takes the same no-bundle branch, and leaving it there is permanent —
    // `reconcileSlug` returns early on `!slot?.sandbox`, so nothing looks at
    // that shell again for the life of the container.
    const deps = await seedAgent("deleted-later");
    const first = await resolveSandbox("deleted-later", deps);
    expect(first).not.toBeNull();

    // Detach the sandbox without removing the slot, which is what an idle
    // self-exit's async teardown or a mid-flight rebuild leaves behind.
    const slot = deps.slots.get("deleted-later");
    expect(slot).toBeDefined();
    await first?.shutdown();
    delete slot?.sandbox;

    await deps.store.deleteAgent("deleted-later");
    await expect(resolveSandbox("deleted-later", deps)).resolves.toBeNull();
    expect(deps.slots.get("deleted-later")).toBeUndefined();
    deps.unwatch();
  });

  it("a secret change does NOT retire the resident sandbox", async () => {
    const deps = await seedAgent("secretly-updated");
    const first = await resolveSandbox("secretly-updated", deps);
    expect(first).not.toBeNull();

    // Secret mutations write Vault, not the agents row: no change event.
    await deps.store.putEnv("secretly-updated", { NEW_KEY: "v" });
    await deps.settleEvents();

    await expect(resolveSandbox("secretly-updated", deps)).resolves.toBe(first);
    await first?.shutdown();
    deps.unwatch();
  });

  it("an unreadable version store never takes down a healthy sandbox", async () => {
    const deps = await seedAgent("db-blip");
    const first = await resolveSandbox("db-blip", deps);
    deps.store.getAgentVersion = () => Promise.reject(new Error("db down"));

    await deps.redeploy();

    // The handler logged and left the resident alone; sessions continue.
    expect(logs.warns()).not.toHaveLength(0);
    await expect(resolveSandbox("db-blip", deps)).resolves.toBe(first);
    await first?.shutdown();
    deps.unwatch();
  });

  it("retirement hands the old sandbox its drain budget instead of cutting it", async () => {
    const deps = await seedAgent("draining");
    const sandbox = (await resolveSandbox("draining", deps)) as Sandbox;
    const drain = vi.spyOn(sandbox, "drain");
    const shutdown = vi.spyOn(sandbox, "shutdown");

    await deps.redeploy();

    // Handed over: the slot holds the READY replacement (no new session
    // can reach the old sandbox), and the old one was told to drain — the
    // GUEST finishes its calls and exits itself; the host never hangs up.
    expect(deps.slots.get("draining")?.sandbox).toBeDefined();
    expect(deps.slots.get("draining")?.sandbox).not.toBe(sandbox);
    await vi.waitFor(() => {
      expect(drain).toHaveBeenCalledWith(expect.any(Number));
    });
    expect(shutdown).not.toHaveBeenCalled();
    deps.unwatch();
  });
});
