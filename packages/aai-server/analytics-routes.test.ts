// Copyright 2026 the AAI authors. MIT license.
import { Hono } from "hono";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { MAX_INGEST_BODY_BYTES, registerAnalyticsIngest } from "./analytics-routes.ts";
import { type AnalyticsStore, createMemoryAnalyticsStore } from "./analytics-store.ts";
import { mintAnalyticsToken } from "./analytics-token.ts";
import type { HonoEnv } from "./context.ts";
import { localSlugLock } from "./platform-lock.ts";
import { createMemorySecretStore } from "./secret-store.ts";
import { createTestOrchestrator, createTestStore, deploy } from "./test-utils.ts";

/** Boot envs handed to every spawn in this file — see the last describe. */
const { spawnedBootEnvs } = vi.hoisted(() => ({
  spawnedBootEnvs: [] as Record<string, string>[],
}));

vi.mock("./sandbox-vm.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./sandbox-vm.ts")>()),
  spawnAgentServer: (opts: { bootEnv?: Record<string, string> }) => {
    spawnedBootEnvs.push(opts.bootEnv ?? {});
    return Promise.resolve({
      sessionUrl: "wss://tunnel.test:443/websocket",
      activeSessions: () => Promise.resolve(0),
      drain: () => Promise.resolve(),
      shutdown: () => Promise.resolve(),
      alive: () => true,
      onExit: () => undefined,
    });
  },
}));

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

describe("the ingest body is bounded", () => {
  test("an oversized body is refused before it is parsed", async () => {
    const h = harness();
    const res = await h.post(
      { slug: SLUG, events: [event({ text: "x".repeat(MAX_INGEST_BODY_BYTES) })] },
      mintAnalyticsToken(SECRET, SLUG),
    );
    // 413 rather than the schema's 400: bodyLimit runs first, which is the
    // point — an unauthenticated caller must not choose how much JSON this
    // process parses, and the token cannot be checked before the parse
    // because the slug it authorizes is in the body.
    expect(res.status).toBe(413);
  });

  test("an unbounded `data` object is refused by the schema", async () => {
    const h = harness();
    const data = Object.fromEntries(
      Array.from({ length: 500 }, (_, i) => [`k${i}`, "v".repeat(100)]),
    );
    const res = await h.post(
      { slug: SLUG, events: [event({ data })] },
      mintAnalyticsToken(SECRET, SLUG),
    );
    expect(res.status).toBe(400);
  });

  test("an ordinary batch is nowhere near either bound", async () => {
    const h = harness();
    const res = await h.post(
      { slug: SLUG, events: [event({ text: "hello", data: { firstAudioMs: 420 } })] },
      mintAnalyticsToken(SECRET, SLUG),
    );
    expect(res.status).toBe(202);
  });
});

/**
 * The other half of the ingest contract: a guest only ever POSTs here because
 * the SPAWN told it to, and that wiring runs through `brokerOpts` in
 * orchestrator.ts.
 *
 * Worth a test at this distance because the failure is invisible from both
 * ends. `analytics` was passed to the change-stream watcher and omitted from
 * `brokerOpts`, so the ordinary cold broker — which spawns nearly every
 * sandbox — configured no shipper at all: the route above stayed correct, the
 * guest stayed correct, and the pane simply reported an agent with no traffic.
 */
describe("the broker configures a spawned guest to ship", () => {
  test("a cold client-config broker hands the guest an ingest URL and token", async () => {
    spawnedBootEnvs.length = 0;
    const { fetch } = await createTestOrchestrator({
      analytics: { store: createMemoryAnalyticsStore(), ingestSecret: SECRET },
      // The guest's own /client-config proxy is not what this covers.
      guestConfigFetch: () => Promise.resolve(new Response(null, { status: 503 })),
    });
    await deploy(fetch, { body: { slug: SLUG, worker: 'export default { name: "t" };' } });

    // Modal forwards cleartext to the container with the public Host, which
    // is exactly the case `resolvePublicOrigin` exists for.
    const res = await fetch(`http://agent.example.modal.run/${SLUG}/client-config`);
    expect(res.status).toBe(200);

    const bootEnv = spawnedBootEnvs[0] ?? {};
    expect(bootEnv.AAI_ANALYTICS_URL).toBe("https://agent.example.modal.run/analytics/ingest");
    // The token authorizes exactly this slug — the ingest route verifies it
    // against the slug in the BODY.
    expect(bootEnv.AAI_ANALYTICS_TOKEN).toBe(mintAnalyticsToken(SECRET, SLUG));
  });
});
