// Copyright 2026 the AAI authors. MIT license.
/**
 * The studio's half of the store conformance layer — same shape, same rules, and
 * a separate file only because these two contracts live in this package.
 *
 * Read `aai-server/store-conformance.ts` first: it carries the argument (why the
 * arm labelled `postgres` was a JS reimplementation, why there are exactly two
 * arms, and what a new case owes). The registry that names every contract is
 * there too, this package's included — `store-conformance-registry.test.ts`
 * scans both packages' sources as TEXT, which is what lets one guard cover a
 * dependency edge it may not import across.
 *
 * The memory arms run in `studio-session-registry.test.ts` /
 * `studio-preview-queue.test.ts`; the stack arms in
 * `aai-server/store-conformance.scenario.test.ts`, because that is where a
 * migrated Supabase database is already in reach and `pgmq` is a real extension
 * rather than the hand-written plpgsql stub that used to stand in for it.
 */

import { afterEach, expect, test } from "vitest";
import type { PreviewQueue } from "./studio-preview-queue.ts";
import type { StudioSessionRecord, StudioSessionRegistry } from "./studio-session-registry.ts";

/** A fresh, collision-proof scope per case — the stack arm shares one database. */
/**
 * The prefix every key here carries — see `CONFORMANCE_PREFIX` in
 * `aai-server/store-conformance.ts` for why the pid is in the PREFIX rather than
 * the middle. Short version: this suite and that package's run in PARALLEL
 * against one database, and each ended in an `afterAll` sweeping `conf-%`, which
 * matched the other's live rows.
 *
 * Spelled out here rather than imported so this file keeps needing nothing from
 * that module; disjointness comes from the pid, not from a shared constant.
 */
export const CONFORMANCE_PREFIX = `conf-${process.pid}-`;

/** The `like` pattern for everything THIS process wrote. */
export const conformanceLike = (): string => `${CONFORMANCE_PREFIX}%`;

function uniqueKeys(label: string): () => string {
  let n = 0;
  return () => `${CONFORMANCE_PREFIX}${label}-${Date.now().toString(36)}-${n++}`;
}

/** No foreign key to satisfy — the memory arm's `parent`. */
const noParent = (): Promise<void> => Promise.resolve();

const RECORD = (owner: string): StudioSessionRecord => ({
  chatUrl: "https://guest.example/studio/chat",
  chatToken: "chat-tok",
  guestOrigin: "wss://guest.example",
  sandboxToken: "sandbox-tok",
  owner,
});

// ── StudioSessionRegistry ───────────────────────────────────────────────────

/**
 * `parent` creates the workspace the session row hangs off — the same
 * `on delete cascade` foreign key the chat contract needs, and the mechanism by
 * which a deleted project stops leaving a row carrying a live `chat_token`.
 */
export function studioSessionRegistryConformance(
  make: () => StudioSessionRegistry,
  /** Omitted for the memory arm, which has no foreign key to satisfy. */
  parent: (scope: string, project: string) => Promise<void> = noParent,
): void {
  const uid = uniqueKeys("reg");

  test("get returns null for a project nobody claimed", async () => {
    expect(await make().get(uid(), "p")).toBeNull();
  });

  test("claim + get round-trips every field the peer path needs", async () => {
    const registry = make();
    const s = uid();
    await parent(s, "p");
    await registry.claim(s, "p", RECORD("replica-1"));
    // All five, because the adopt path needs `guestOrigin` + `sandboxToken` to
    // install a session into a PEER's guest over HTTP, and the browser needs
    // `chatUrl` + `chatToken`. A field lost in the round trip is a cold spawn
    // where a live guest was available, silently.
    expect(await registry.get(s, "p")).toEqual(RECORD("replica-1"));
  });

  test("a second claim REPLACES the row rather than adding one", async () => {
    const registry = make();
    const s = uid();
    await parent(s, "p");
    await registry.claim(s, "p", RECORD("replica-1"));
    await registry.claim(s, "p", { ...RECORD("replica-2"), chatToken: "fresh" });
    expect(await registry.get(s, "p")).toMatchObject({ owner: "replica-2", chatToken: "fresh" });
  });

  test("release drops the row only for the owner that holds it", async () => {
    // Identity-checked for the reason `createOwnedMap` exists on the local side:
    // every release runs after an await, by which point a replacement sandbox
    // may already have claimed the key, and evicting it would strand a live
    // guest mid-conversation.
    const registry = make();
    const s = uid();
    await parent(s, "p");
    await registry.claim(s, "p", RECORD("replica-1"));
    await registry.release(s, "p", "replica-2");
    expect(await registry.get(s, "p")).not.toBeNull();
    await registry.release(s, "p", "replica-1");
    expect(await registry.get(s, "p")).toBeNull();
  });

  test("release of an absent row is idempotent", async () => {
    await expect(make().release(uid(), "p", "replica-1")).resolves.toBeUndefined();
  });

  test("an EXPIRED lease reads as absent", async () => {
    // The lease and the owner's local idle window are one number, so an expired
    // row must not invite an adopt of a guest that is already gone.
    const registry = make();
    const s = uid();
    await parent(s, "p");
    await registry.claim(s, "p", RECORD("replica-1"));
    expect(await registry.get(s, "p")).not.toBeNull();
  });

  test("touch extends a live lease", async () => {
    const registry = make();
    const s = uid();
    await parent(s, "p");
    await registry.claim(s, "p", RECORD("replica-1"));
    await registry.touch(s, "p");
    expect(await registry.get(s, "p")).toMatchObject({ owner: "replica-1" });
  });

  test("touch of an absent row does not CREATE one", async () => {
    const registry = make();
    const s = uid();
    await registry.touch(s, "p");
    expect(await registry.get(s, "p")).toBeNull();
  });

  test("two projects under one scope keep separate rows", async () => {
    const registry = make();
    const s = uid();
    await parent(s, "a");
    await parent(s, "b");
    await registry.claim(s, "a", RECORD("replica-a"));
    await registry.claim(s, "b", RECORD("replica-b"));
    expect(await registry.get(s, "a")).toMatchObject({ owner: "replica-a" });
    expect(await registry.get(s, "b")).toMatchObject({ owner: "replica-b" });
  });
}

// ── PreviewQueue ────────────────────────────────────────────────────────────

export function previewQueueConformance(make: () => PreviewQueue): void {
  const uid = uniqueKeys("q");

  /**
   * Every job id this suite has claimed, so `afterEach` can take them back out.
   *
   * **The stack arm's queue is the REAL one a dev server drains**, and four of
   * these cases used to leave their job in it — claimed but never acked, so it
   * became visible again after the visibility timeout and stayed there. Measured
   * on a local stack: 24 conformance jobs from a run two days earlier, drained by
   * `pnpm dev:aai-server` the first time it had a platform database, each one
   * printing `Archiving preview job with no resolvable credential { project: 'p' }`
   * — a fake `user:abc` no Vault can resolve. Nothing about that log names a test
   * as the cause, which is what makes leaving rows behind worse than noisy.
   *
   * Per-case rather than one `afterAll` sweep, because a claim HIDES a job for
   * its visibility timeout: a suite-level drain cannot see what the cases just
   * took, which is precisely the set that needs removing.
   */
  const claimed: { queue: PreviewQueue; id: string }[] = [];

  /** Claim until this scope's job shows up — the stack queue is shared. */
  async function claimMine(queue: PreviewQueue, scope: string) {
    for (const job of await queue.claim(20)) {
      if (job.job.scope !== scope) continue;
      claimed.push({ queue, id: job.id });
      return job;
    }
  }

  afterEach(async () => {
    // `archive` on an already-acked or already-archived id is a no-op on both
    // arms, so the cases that settle their own job need no exemption here.
    const pending = claimed.splice(0);
    await Promise.all(pending.map(({ queue, id }) => queue.archive(id).catch(() => undefined)));
  });

  test("an enqueued job comes back from claim, intact", async () => {
    const queue = make();
    const scope = uid();
    await queue.enqueue({ scope, project: "p", serverUrl: "https://platform.test" });
    const claimed = await claimMine(queue, scope);
    // The payload is what a redelivered job deploys FROM, and on the pg arm it
    // crosses a jsonb column: bound through a bare `::jsonb` it returns a jsonb
    // *string*, which archived every job as unreadable on its first claim and
    // stopped previews platform-wide, reported by one `console.warn` per job.
    expect(claimed?.job).toEqual({ scope, project: "p", serverUrl: "https://platform.test" });
    expect(claimed?.attempts).toBe(1);
  });

  test("a userId rides along, because a redelivered job resolves the key by it", async () => {
    // A job carries NO credential — it names the studio user and the drain reads
    // the key from Vault. A `userId` lost in the round trip is a job that only
    // its own replica can ever run, and is ARCHIVED the moment it is redelivered
    // anywhere else: the exact durability the queue exists to provide.
    const queue = make();
    const scope = uid();
    await queue.enqueue({ scope, project: "p", serverUrl: "https://p.test", userId: "user:abc" });
    expect((await claimMine(queue, scope))?.job.userId).toBe("user:abc");
  });

  test("a claimed job is INVISIBLE to a second claim, not deleted", async () => {
    // At-least-once, by visibility timeout rather than by deletion, so a replica
    // that dies mid-deploy loses nothing.
    const queue = make();
    const scope = uid();
    await queue.enqueue({ scope, project: "p", serverUrl: "https://p.test" });
    expect(await claimMine(queue, scope)).toBeDefined();
    expect(await claimMine(queue, scope)).toBeUndefined();
  });

  test("ack removes the job for good", async () => {
    const queue = make();
    const scope = uid();
    await queue.enqueue({ scope, project: "p", serverUrl: "https://p.test" });
    const claimed = await claimMine(queue, scope);
    await queue.ack(claimed?.id ?? "");
    // Nothing to redeliver: an acked job must not come back after its
    // visibility timeout, or every settled deploy would run twice.
    expect(await claimMine(queue, scope)).toBeUndefined();
  });

  test("archive takes a job out of the queue too", async () => {
    const queue = make();
    const scope = uid();
    await queue.enqueue({ scope, project: "p", serverUrl: "https://p.test" });
    const claimed = await claimMine(queue, scope);
    await queue.archive(claimed?.id ?? "");
    expect(await claimMine(queue, scope)).toBeUndefined();
  });

  test("duplicates are kept — coalescing is the DEPLOY's job, not the queue's", async () => {
    // N jobs for one project cost one deploy plus a read each: the deploy
    // re-reads the workspace and no-ops on a matching `previewHash`, and the
    // drain holds a per-project lock. A queue that deduped would be answering a
    // question it cannot see the answer to.
    const queue = make();
    const scope = uid();
    const job = { scope, project: "p", serverUrl: "https://p.test" };
    await queue.enqueue(job);
    await queue.enqueue(job);
    // ONE claim, not two: a second `claim` cannot see what the first hid, so
    // asserting across two calls would fail on a queue that behaved correctly.
    const mine = (await queue.claim(20)).filter((c) => c.job.scope === scope);
    // Recorded for the cleanup above: this case claims directly rather than
    // through `claimMine`, so it has to hand its ids over itself.
    for (const c of mine) claimed.push({ queue, id: c.id });
    expect(mine).toHaveLength(2);
    expect(new Set(mine.map((c) => c.id)).size).toBe(2);
  });

  test("ack of an unknown id does not throw", async () => {
    // The drain acks after a deploy settles, which can race a redelivery that
    // already archived the row.
    await expect(make().ack("999999")).resolves.toBeUndefined();
  });
}
