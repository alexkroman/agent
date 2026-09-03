// Copyright 2026 the AAI authors. MIT license.
/**
 * The conformance CASE LISTS — one contract's whole behavioural spec each, as
 * `test()` declarations over a factory.
 *
 * Read `store-conformance.ts` first: it holds the registry and the argument (why
 * the arm labelled `postgres` was a JS reimplementation of the store's own SQL,
 * why there are exactly two arms, and what a new case owes). Split out of it only
 * because the two together exceeded the 500-line source cap, on the seam that was
 * already there — that module is metadata, this one is specs.
 *
 * Callers supply the arm: the unit suites the memory one (unconditionally, so the
 * package's coverage floors keep measuring the code), and
 * `store-conformance.scenario.test.ts` the stack one behind `describeWithStack`.
 */

import { expect, test } from "vitest";
import type { AgentRows } from "./agent-store.ts";
import { type ChatStore, MAX_STUDIO_CHAT_STORE_BYTES } from "./chat-store.ts";
import type { RateLimiter } from "./rate-limit.ts";
import type { SecretStore } from "./secret-store.ts";
import { noParent, uniqueKeys } from "./store-conformance.ts";
import { WorkspaceConflictError, type WorkspaceStore } from "./workspace-store.ts";

// ── WorkspaceStore ──────────────────────────────────────────────────────────

export function workspaceStoreConformance(make: () => WorkspaceStore): void {
  const uid = uniqueKeys("ws");

  test("get returns null for a missing row", async () => {
    expect(await make().get(uid(), "ghost")).toBeNull();
  });

  test("create + get round-trips the doc at version 1", async () => {
    const store = make();
    const s = uid();
    expect(await store.put(s, "p", { files: { "a.ts": "1" } }, null)).toBe(1);
    expect(await store.get(s, "p")).toEqual({ doc: { files: { "a.ts": "1" } }, version: 1 });
  });

  test("creating an existing row conflicts and leaves it untouched", async () => {
    const store = make();
    const s = uid();
    await store.put(s, "p", { v: "winner" }, null);
    await expect(store.put(s, "p", { v: "loser" }, null)).rejects.toThrow(WorkspaceConflictError);
    expect(await store.get(s, "p")).toEqual({ doc: { v: "winner" }, version: 1 });
  });

  test("a versioned update bumps the version", async () => {
    const store = make();
    const s = uid();
    await store.put(s, "p", { v: 1 }, null);
    expect(await store.put(s, "p", { v: 2 }, 1)).toBe(2);
    expect(await store.get(s, "p")).toEqual({ doc: { v: 2 }, version: 2 });
  });

  test("an update against a stale version conflicts without writing", async () => {
    const store = make();
    const s = uid();
    await store.put(s, "p", { v: 1 }, null);
    await store.put(s, "p", { v: 2 }, 1);
    await expect(store.put(s, "p", { v: "stale" }, 1)).rejects.toThrow(WorkspaceConflictError);
    expect(await store.get(s, "p")).toEqual({ doc: { v: 2 }, version: 2 });
  });

  test("an update against a missing row conflicts (never creates)", async () => {
    const store = make();
    const s = uid();
    await expect(store.put(s, "ghost", { v: 1 }, 1)).rejects.toThrow(WorkspaceConflictError);
    expect(await store.get(s, "ghost")).toBeNull();
  });

  test("delete removes the row and is idempotent", async () => {
    const store = make();
    const s = uid();
    await store.put(s, "p", { v: 1 }, null);
    await store.delete(s, "p");
    expect(await store.get(s, "p")).toBeNull();
    await expect(store.delete(s, "p")).resolves.toBeUndefined();
  });

  test("patch merges named keys and leaves every other one alone", async () => {
    const store = make();
    const s = uid();
    await store.put(s, "p", { files: { "a.ts": "1" }, deployedSlug: "old" }, null);
    const patched = await store.patch(s, "p", { set: { deployedSlug: "new" } });
    // The file map is untouched WITHOUT having been read or rewritten — the
    // whole reason this operation exists.
    expect(patched).toEqual({
      doc: { files: { "a.ts": "1" }, deployedSlug: "new" },
      version: 2,
    });
  });

  test("patch removes keys, and a key in both set and remove is set", async () => {
    const store = make();
    const s = uid();
    await store.put(s, "p", { files: {}, previewHash: "h", previewError: "boom" }, null);
    const patched = await store.patch(s, "p", {
      set: { previewHash: "fresh" },
      remove: ["previewError", "previewHash"],
    });
    // Removals apply first, then the merge — so naming a key in both is a
    // SET in either implementation, never an accidental delete.
    expect(patched?.doc).toEqual({ files: {}, previewHash: "fresh" });
  });

  test("patch bumps the version — it is what drives the change stream", async () => {
    const store = make();
    const s = uid();
    await store.put(s, "p", { files: {} }, null);
    expect((await store.patch(s, "p", { set: { a: 1 } }))?.version).toBe(2);
    expect((await store.patch(s, "p", { set: { b: 2 } }))?.version).toBe(3);
    // And it takes no expected version, so two stamps of different fields
    // both land — where the versioned put made one of them retry.
    expect((await store.get(s, "p"))?.doc).toEqual({ files: {}, a: 1, b: 2 });
  });

  test("patch of a missing row resolves null and never creates one", async () => {
    const store = make();
    const s = uid();
    expect(await store.patch(s, "ghost", { set: { a: 1 } })).toBeNull();
    expect(await store.get(s, "ghost")).toBeNull();
  });

  test("patch cannot clobber a write that landed after it was composed", async () => {
    // The concurrency property the versioned read-modify-write could only get
    // by DETECTING the race and retrying: a patch carries no files, so a file
    // write landing between composing the stamp and applying it survives.
    const store = make();
    const s = uid();
    await store.put(s, "p", { files: { "a.ts": "before" } }, null);
    const stamp = { set: { deployedSlug: "x" } };
    await store.put(s, "p", { files: { "a.ts": "after" } }, 1);
    const patched = await store.patch(s, "p", stamp);
    expect(patched?.doc).toEqual({ files: { "a.ts": "after" }, deployedSlug: "x" });
  });

  test("list is scoped and sorted", async () => {
    const store = make();
    const [s1, s2, s3] = [uid(), uid(), uid()];
    await store.put(s1, "beta", {}, null);
    await store.put(s1, "alpha", {}, null);
    await store.put(s2, "other", {}, null);
    expect(await store.list(s1)).toEqual(["alpha", "beta"]);
    expect(await store.list(s2)).toEqual(["other"]);
    expect(await store.list(s3)).toEqual([]);
  });

  test("a scope that is a string PREFIX of another lists only its own", async () => {
    // The Postgres arm compares `scope = $1` and could never get this wrong;
    // the memory arm keyed on `${scope}/${project}` and answered `list` with a
    // `startsWith` over that composite, so the outer scope listed the inner
    // one's projects as its own. Arm-independent because it is a statement
    // about the CONTRACT — scope isolation — not about a separator.
    const store = make();
    const outer = uid();
    const inner = `${outer}/nested`;
    await store.put(outer, "mine", {}, null);
    await store.put(inner, "theirs", {}, null);
    expect(await store.list(outer)).toEqual(["mine"]);
    expect(await store.list(inner)).toEqual(["theirs"]);
  });

  test("a doc is stored as jsonb, so an arrow operator can reach into it", async () => {
    // The `::text::jsonb` binding, from the outside: `patch` composes
    // `doc = (doc - remove) || set` IN Postgres, so a doc held as a jsonb
    // *string* raises `cannot delete from scalar` rather than merging. Every
    // metadata stamp did, in production, and the in-memory arm cannot represent
    // it — it holds JS objects. Expressed as a contract case (a remove of an
    // absent key is a no-op) so the memory arm asserts it too and the two cannot
    // disagree about what the operation MEANS.
    const store = make();
    const s = uid();
    await store.put(s, "p", { files: { "a.ts": "1" } }, null);
    const patched = await store.patch(s, "p", { set: {}, remove: ["neverSet"] });
    expect(patched?.doc).toEqual({ files: { "a.ts": "1" } });
  });
}

// ── ChatStore ───────────────────────────────────────────────────────────────

const msg = (id: string, text = "hi"): Record<string, unknown> => ({
  id,
  role: "user",
  parts: [{ type: "text", text }],
});

/**
 * `parent` creates the workspace a chat hangs off.
 *
 * `studio_chats_workspace_fk` makes a parentless chat unrepresentable, which is
 * the shape production has — a chat row is only ever written by
 * `studio/persist-chat`, at the end of a turn in a session brokered against an
 * existing project. The memory arm has no such key, so the parent write is a
 * no-op there; passing it in rather than branching keeps the cases identical.
 */
export function chatStoreConformance(
  make: () => ChatStore,
  /** Omitted for the memory arm, which has no foreign key to satisfy. */
  parent: (scope: string, project: string) => Promise<void> = noParent,
): void {
  const uid = uniqueKeys("chat");

  test("getChat returns null for a project with no chat", async () => {
    expect(await make().getChat(uid(), "ghost")).toBeNull();
  });

  test("putChat + getChat round-trips the message list", async () => {
    const store = make();
    const s = uid();
    await parent(s, "p");
    await store.putChat(s, "p", [msg("m1"), msg("m2")]);
    expect(await store.getChat(s, "p")).toEqual([msg("m1"), msg("m2")]);
  });

  test("putChat is a plain upsert — the row is always the latest snapshot", async () => {
    const store = make();
    const s = uid();
    await parent(s, "p");
    await store.putChat(s, "p", [msg("m1")]);
    await store.putChat(s, "p", [msg("m1"), msg("m2"), msg("m3")]);
    expect(await store.getChat(s, "p")).toEqual([msg("m1"), msg("m2"), msg("m3")]);
  });

  test("chats are scoped: same project name under two scopes stays separate", async () => {
    const store = make();
    const [s1, s2] = [uid(), uid()];
    await parent(s1, "p");
    await parent(s2, "p");
    await store.putChat(s1, "p", [msg("mine")]);
    await store.putChat(s2, "p", [msg("theirs")]);
    expect(await store.getChat(s1, "p")).toEqual([msg("mine")]);
    expect(await store.getChat(s2, "p")).toEqual([msg("theirs")]);
  });

  test("deleteChat removes the row and is idempotent", async () => {
    const store = make();
    const s = uid();
    await parent(s, "p");
    await store.putChat(s, "p", [msg("m1")]);
    await store.deleteChat(s, "p");
    expect(await store.getChat(s, "p")).toBeNull();
    await expect(store.deleteChat(s, "p")).resolves.toBeUndefined();
  });

  test("an oversized conversation is trimmed from the front on write", async () => {
    const store = make();
    const s = uid();
    await parent(s, "p");
    const big = "x".repeat(200 * 1024);
    const messages = [msg("m1", big), msg("m2", big), msg("m3", big), msg("m4", "recent")];
    await store.putChat(s, "p", messages);
    const stored = (await store.getChat(s, "p")) as { id: string }[];
    // Whole oldest messages dropped; the newest survive intact.
    expect(stored.at(-1)?.id).toBe("m4");
    expect(stored.length).toBeLessThan(messages.length);
    expect(Buffer.byteLength(JSON.stringify(stored))).toBeLessThanOrEqual(
      MAX_STUDIO_CHAT_STORE_BYTES,
    );
  });

  test("a message list is stored as a jsonb ARRAY, not a jsonb string", async () => {
    // The double-encode again, from the contract side: a list written through a
    // bare `::jsonb` cast comes back as a STRING, so this is the assertion the
    // encoding bug fails. Cheap in memory and load-bearing on the stack.
    const store = make();
    const s = uid();
    await parent(s, "p");
    await store.putChat(s, "p", [msg("m1")]);
    expect(Array.isArray(await store.getChat(s, "p"))).toBe(true);
  });
}

// ── AgentRows ───────────────────────────────────────────────────────────────

export function agentRowsConformance(make: () => AgentRows): void {
  const uid = uniqueKeys("agent");

  test("get and getVersion return null for a slug nobody deployed", async () => {
    const rows = make();
    const slug = uid();
    expect(await rows.get(slug)).toBeNull();
    // Null version is what tells the invalidation handler to TERMINATE rather
    // than drain — it must not read as "version 0".
    expect(await rows.getVersion(slug)).toBeNull();
  });

  test("touch bumps an existing row's version, leaves its deploy alone, and creates none", async () => {
    // A mutation that changes a guest's ENVIRONMENT without
    // changing its code, and the version is the only invalidation signal — so
    // the bump has to land while the row's deploy stays exactly as it was.
    const rows = make();
    const slug = uid();
    expect(await rows.touch(slug)).toBe(false);
    expect(await rows.get(slug)).toBeNull();
    const put = { credential_hashes: ["sha256:abc"], worker_hash: "wh-1" };
    await rows.put({ slug, client_files: { "a.html": "ch-1" }, ...put });
    const before = await rows.get(slug);
    expect(await rows.touch(slug)).toBe(true);
    expect(await rows.get(slug)).toMatchObject({ ...put, version: (before?.version ?? 0) + 1 });
  });

  test("put + get round-trips every column, the nullable pin included", async () => {
    const rows = make();
    const slug = uid();
    await rows.put({
      slug,
      credential_hashes: ["sha256:abc"],
      worker_hash: "wh-1",
      client_files: { "index.html": "ch-1" },
      harness_image_tag: "aai-guest-harness:deadbeef",
    });
    const got = await rows.get(slug);
    expect(got).toMatchObject({
      slug,
      credential_hashes: ["sha256:abc"],
      // jsonb, so the nested object has to survive the driver both ways.
      client_files: { "index.html": "ch-1" },
      worker_hash: "wh-1",
      harness_image_tag: "aai-guest-harness:deadbeef",
    });
    expect(typeof got?.version).toBe("number");
  });

  test("an absent harness_image_tag reads back as null, not undefined", async () => {
    // The pin is optional (the subprocess backend has no image), and the store's
    // schema distinguishes null from absent.
    const rows = make();
    const slug = uid();
    await rows.put({ slug, credential_hashes: [], worker_hash: "w", client_files: {} });
    expect((await rows.get(slug))?.harness_image_tag).toBeNull();
  });

  test("a re-put bumps version — the cross-replica invalidation signal", async () => {
    const rows = make();
    const slug = uid();
    const base = { slug, credential_hashes: ["sha256:one"], client_files: {} };
    await rows.put({ ...base, worker_hash: "w1" });
    const first = await rows.getVersion(slug);
    await rows.put({ ...base, worker_hash: "w2" });
    const second = await rows.getVersion(slug);

    // Sandboxes retire on a version mismatch, so a version that does NOT move
    // on redeploy means resident guests keep serving superseded code — the
    // quietest possible failure of the whole invalidation design.
    expect(first).not.toBeNull();
    expect(second).toBeGreaterThan(first as number);
    // And the row really was updated, not duplicated.
    expect((await rows.get(slug))?.worker_hash).toBe("w2");
  });

  test("delete removes the row and its version", async () => {
    const rows = make();
    const slug = uid();
    await rows.put({ slug, credential_hashes: [], worker_hash: "w", client_files: {} });
    await rows.delete(slug);
    expect(await rows.get(slug)).toBeNull();
    expect(await rows.getVersion(slug)).toBeNull();
  });

  test("delete of an absent slug is idempotent", async () => {
    await expect(make().delete(uid())).resolves.toBeUndefined();
  });
}

// ── SecretStore ─────────────────────────────────────────────────────────────

export function secretStoreConformance(make: () => SecretStore): void {
  const uid = uniqueKeys("secret");

  test("get returns null for a name nobody wrote", async () => {
    expect(await make().get(uid())).toBeNull();
  });

  test("put + get round-trips the value", async () => {
    const store = make();
    const name = uid();
    await store.put(name, "s3cret");
    expect(await store.get(name)).toBe("s3cret");
  });

  test("put over an existing name UPDATES it rather than creating a second", async () => {
    // On the Vault arm this is the interesting half: `create_secret` raises
    // 23505 on a name that exists, so `put` reads the id first and updates —
    // and the retry the code comments describe is what covers the lost race.
    const store = make();
    const name = uid();
    await store.put(name, "first");
    await store.put(name, "second");
    expect(await store.get(name)).toBe("second");
  });

  test("delete removes the value and is idempotent", async () => {
    const store = make();
    const name = uid();
    await store.put(name, "v");
    await store.delete(name);
    expect(await store.get(name)).toBeNull();
    await expect(store.delete(name)).resolves.toBeUndefined();
  });

  test("names are opaque: two names do not shadow each other", async () => {
    const store = make();
    const [a, b] = [uid(), uid()];
    await store.put(a, "A");
    await store.put(b, "B");
    expect([await store.get(a), await store.get(b)]).toEqual(["A", "B"]);
  });

  test("a value survives characters a naive encoding would eat", async () => {
    // Vault encrypts and decrypts, so this is the one place a value can come
    // back mangled: quotes, a newline, a NUL-adjacent escape, and non-ASCII.
    const store = make();
    const name = uid();
    const value = "a\"b'c\nd\\e — ünïcødé 🎙";
    await store.put(name, value);
    expect(await store.get(name)).toBe(value);
  });
}

// ── RateLimiter ─────────────────────────────────────────────────────────────

/**
 * The limiter is created per case rather than per contract: its `limit` and
 * `windowMs` are constructor arguments, and the boundary is the whole subject.
 */
export function rateLimiterConformance(
  make: (opts: { limit: number; windowMs: number }) => RateLimiter,
): void {
  const uid = uniqueKeys("rl");

  test("a key under the limit is allowed every time", async () => {
    const limiter = make({ limit: 3, windowMs: 60_000 });
    const key = uid();
    for (let i = 0; i < 3; i++) {
      expect(await limiter.check(key)).toEqual({ ok: true });
    }
  });

  test("the request PAST the limit is refused with a retry hint", async () => {
    const limiter = make({ limit: 2, windowMs: 60_000 });
    const key = uid();
    await limiter.check(key);
    await limiter.check(key);
    const verdict = await limiter.check(key);
    expect(verdict.ok).toBe(false);
    // A refusal a client cannot act on is a worse refusal: the number is what
    // the 429's Retry-After carries.
    expect(verdict.ok === false && verdict.retryAfterSeconds).toBeGreaterThan(0);
  });

  test("keys do not share a window", async () => {
    const limiter = make({ limit: 1, windowMs: 60_000 });
    const [a, b] = [uid(), uid()];
    expect(await limiter.check(a)).toEqual({ ok: true });
    expect(await limiter.check(b)).toEqual({ ok: true });
    expect((await limiter.check(a)).ok).toBe(false);
  });

  // **No case here passes `now`**, and that is a divergence this table FOUND
  // rather than a convention it adopted: the Postgres limiter's `check` takes
  // `(key)` and drops the instant, computing its window from the DATABASE's
  // clock so replicas never compare their own — see the note on
  // `RateLimiter.check`. A window's ELAPSING is therefore not conformable, and
  // each arm asserts it in its own terms: `rate-limit.test.ts` with an injected
  // clock, `store-conformance.scenario.test.ts` by waiting out a 300ms window.
  // A shared case that passed `now` was asserting about a parameter one arm
  // cannot see, and reported that arm as broken.

  test("a refused request does not push the window further out", async () => {
    // A limiter that kept counting refusals would grow `retryAfterSeconds` on
    // every rejected attempt, turning a burst into an ever-receding window.
    const limiter = make({ limit: 1, windowMs: 10_000 });
    const key = uid();
    await limiter.check(key);
    const first = await limiter.check(key);
    const later = await limiter.check(key);
    expect(first.ok).toBe(false);
    expect(later.ok).toBe(false);
    expect(later.ok === false && later.retryAfterSeconds).toBeLessThanOrEqual(
      first.ok === false ? first.retryAfterSeconds : 0,
    );
  });
}
