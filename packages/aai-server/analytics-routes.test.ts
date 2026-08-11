// Copyright 2026 the AAI authors. MIT license.
import { Hono } from "hono";
import { beforeEach, describe, expect, test } from "vitest";
import { registerAnalyticsIngest } from "./analytics-routes.ts";
import { type AnalyticsStore, createMemoryAnalyticsStore } from "./analytics-store.ts";
import { mintAnalyticsToken } from "./analytics-token.ts";
import type { HonoEnv } from "./context.ts";
import { localSlugLock } from "./platform-lock.ts";
import { createMemorySecretStore } from "./secret-store.ts";
import { createTestStore } from "./test-utils.ts";

const SECRET = "ingest-secret";
const SLUG = "my-agent";

type MemoryStore = ReturnType<typeof createMemoryAnalyticsStore>;

function harness(store: AnalyticsStore | null = createMemoryAnalyticsStore()) {
  const app = new Hono<HonoEnv>();
  registerAnalyticsIngest(app);
  // Real bindings rather than a cast partial: the route reads only
  // `analytics`, but a cast would keep compiling if a future middleware on
  // this path started reading `store` or `slugLock`, and the failure would be
  // a runtime undefined rather than a type error.
  const bindings: HonoEnv["Bindings"] = {
    store: createTestStore(),
    secrets: createMemorySecretStore(),
    slugLock: localSlugLock,
    ...(store && { analytics: { store, ingestSecret: SECRET } }),
  };
  const post = async (body: unknown, token?: string): Promise<Response> =>
    await app.fetch(
      new Request("http://platform/analytics/ingest", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
        },
        body: JSON.stringify(body),
      }),
      bindings,
    );
  return { post, store };
}

const event = (over: Record<string, unknown> = {}) => ({
  sessionId: "s1",
  ts: Date.now(),
  kind: "user_turn",
  turn: 1,
  ...over,
});

describe("POST /analytics/ingest", () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => {
    h = harness();
  });

  test("stores a batch presented with this slug's token", async () => {
    const res = await h.post(
      { slug: SLUG, agentVersion: 4, events: [event({ text: "hello" })] },
      mintAnalyticsToken(SECRET, SLUG),
    );
    expect(res.status).toBe(202);
    await expect(res.json()).resolves.toEqual({ accepted: 1 });
    const rows = (h.store as MemoryStore).rows;
    // `text` on the wire becomes `body` in the column — the row's own name
    // for it collides with the HTTP body everywhere else.
    expect(rows[0]).toMatchObject({ slug: SLUG, agentVersion: 4, body: "hello" });
  });

  test("refuses a token minted for another slug", async () => {
    const res = await h.post(
      { slug: SLUG, events: [event()] },
      mintAnalyticsToken(SECRET, "someone-else"),
    );
    expect(res.status).toBe(401);
    expect((h.store as MemoryStore).rows).toHaveLength(0);
  });

  test("refuses a missing token", async () => {
    const res = await h.post({ slug: SLUG, events: [event()] });
    expect(res.status).toBe(401);
  });

  test("404s when the deployment has no analytics binding", async () => {
    // The guest reads this as "stop shipping" — a deployment without a
    // platform database is not broken.
    const off = harness(null);
    const res = await off.post({ slug: SLUG, events: [event()] }, mintAnalyticsToken(SECRET, SLUG));
    expect(res.status).toBe(404);
  });

  test("rejects a batch past the row cap", async () => {
    const res = await h.post(
      { slug: SLUG, events: Array.from({ length: 501 }, () => event()) },
      mintAnalyticsToken(SECRET, SLUG),
    );
    expect(res.status).toBe(400);
  });

  test("rejects a malformed slug before it can become a row", async () => {
    const res = await h.post(
      { slug: "not a slug!", events: [event()] },
      mintAnalyticsToken(SECRET, "not a slug!"),
    );
    expect(res.status).toBe(400);
  });

  test("accepts a kind the platform does not know", async () => {
    // A guest runs a harness pinned at ITS deploy, so a newer or older
    // runtime's kind must land as data rather than 400 the whole batch.
    const res = await h.post(
      { slug: SLUG, events: [event({ kind: "something_new" })] },
      mintAnalyticsToken(SECRET, SLUG),
    );
    expect(res.status).toBe(202);
    expect((h.store as MemoryStore).rows[0]?.kind).toBe("something_new");
  });

  test("answers 202 when the store throws, rather than making a guest retry", async () => {
    const failing: AnalyticsStore = {
      ...createMemoryAnalyticsStore(),
      append: () => Promise.reject(new Error("database down")),
    };
    const res = await harness(failing).post(
      { slug: SLUG, events: [event()] },
      mintAnalyticsToken(SECRET, SLUG),
    );
    expect(res.status).toBe(202);
    await expect(res.json()).resolves.toEqual({ accepted: 0 });
  });
});
