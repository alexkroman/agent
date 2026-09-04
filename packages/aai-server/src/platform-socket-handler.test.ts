// Copyright 2026 the AAI authors. MIT license.
/**
 * The frame loop a guest's socket is served by, without the socket.
 *
 * Everything a frame can do to this server is here — the route allowlist, the
 * heartbeat answer, the in-flight cap, the dispatch and its 500 — and none of it
 * needs a port, which is why `createPlatformFrameLoop` takes a SINK. The
 * handshake, the bearer refusal and the plumbing are in
 * `platform-socket.scenario.test.ts`, which does need one.
 *
 * The app under it is a real `Hono`, not a fake: the whole claim of this design
 * is that a frame becomes a REQUEST the app routes, so a spec that stubbed the
 * dispatch would be asserting the opposite of what is interesting.
 */

import { MAX_SLUG_LENGTH } from "@alexkroman1/aai/internal";
import { PLATFORM_ROUTES } from "@alexkroman1/aai-runtime/internal";
import { Hono } from "hono";
import { describe, expect, test, vi } from "vitest";
import type { HonoEnv } from "./context.ts";
import {
  createPlatformFrameLoop,
  type PlatformFrameSink,
  platformHandshakeRefusal,
  platformSocketSlug,
} from "./platform-socket-handler.ts";

const SLUG = "my-agent";
const CTX = { origin: "http://platform.test", slug: SLUG, authorization: "Bearer guest-token" };

/** The version reader the loop never reads — only the handshake does. */
const store = { getAgentVersion: async (): Promise<number | null> => 1 };

/** One app whose session-state route echoes what the request carried. */
function appEchoing(handler?: (c: { req: Request }) => Response | Promise<Response>) {
  const app = new Hono<HonoEnv>();
  const seen: { url: string; method: string; authorization: string | null; body: string }[] = [];
  app.post(`/:slug${PLATFORM_ROUTES.sessionState}`, async (c) => {
    const raw = c.req.raw;
    seen.push({
      url: raw.url,
      method: raw.method,
      authorization: raw.headers.get("authorization"),
      body: await raw.clone().text(),
    });
    return handler ? await handler({ req: raw }) : c.json({ result: "ok" });
  });
  return { app, seen };
}

/** The loop plus the frames it answered with. */
function loopOver(app: Hono<HonoEnv>, extra: { isDraining?: () => boolean } = {}) {
  const answers: Record<string, unknown>[] = [];
  const sink: PlatformFrameSink = (frame) => answers.push({ ...frame });
  const handle = createPlatformFrameLoop({ app, store, ...extra }, CTX, sink);
  return { handle, answers };
}

const request = (id: number, route: string, body = "{}") =>
  JSON.stringify({ t: "req", id, route, body });

describe("a frame becomes a request the app routes", () => {
  test("carries the route, the method, the bearer and the body, and answers the status", async () => {
    const { app, seen } = appEchoing();
    const { handle, answers } = loopOver(app);
    handle(request(1, PLATFORM_ROUTES.sessionState, '{"method":"load"}'));
    await vi.waitFor(() => {
      expect(answers).toHaveLength(1);
    });
    expect(seen).toEqual([
      {
        url: `http://platform.test/${SLUG}/session-state`,
        method: "POST",
        authorization: CTX.authorization,
        body: '{"method":"load"}',
      },
    ]);
    expect(answers[0]).toEqual({ t: "res", id: 1, status: 200, body: '{"result":"ok"}' });
  });

  test("hands back whatever status the route decided", async () => {
    // The property every guest-side `errorFor` rests on: a 409 stays a 409 rather
    // than becoming a transport error.
    const { app } = appEchoing(() => new Response("taken", { status: 409 }));
    const { handle, answers } = loopOver(app);
    handle(request(2, PLATFORM_ROUTES.sessionState));
    await vi.waitFor(() => {
      expect(answers[0]).toEqual({ t: "res", id: 2, status: 409, body: "taken" });
    });
  });

  test("a route outside the table is refused before a request exists", async () => {
    // A BOUNDARY rather than a validation: `route` is concatenated into a URL, so
    // an unchecked one reaches paths that are not gated by the guest bearer at
    // all — `/../elsewhere/session-state` is the worked case in the scenario spec.
    const { app, seen } = appEchoing();
    const { handle, answers } = loopOver(app);
    handle(request(3, "/../elsewhere/session-state"));
    await vi.waitFor(() => {
      expect(answers[0]).toMatchObject({ t: "res", id: 3, status: 404 });
    });
    expect(seen).toHaveLength(0);
  });

  test("a throw that escapes the app is a 500 rather than a frame with no reply", async () => {
    const { app } = appEchoing(() => {
      throw new Error("boom");
    });
    const { handle, answers } = loopOver(app);
    handle(request(4, PLATFORM_ROUTES.sessionState));
    await vi.waitFor(() => {
      expect(answers[0]).toMatchObject({ t: "res", id: 4, status: 500 });
    });
  });
});

describe("frames that are not calls", () => {
  test("answers a ping with the pong that names it", () => {
    // Synchronous, and it touches no route: the guest reads an unanswered ping as
    // a dead socket, so this must not queue behind a dispatch.
    const { handle, answers } = loopOver(appEchoing().app);
    handle(JSON.stringify({ t: "ping", id: 7 }));
    expect(answers).toEqual([{ t: "pong", id: 7 }]);
  });

  test.each([
    ["not json at all", "{{{"],
    ["a kind this build does not know", JSON.stringify({ t: "hello", id: 1 })],
    ["a request missing its body", JSON.stringify({ t: "req", id: 1, route: "/session-state" })],
  ])("drops %s without answering", async (_label, text) => {
    const { app, seen } = appEchoing();
    const { handle, answers } = loopOver(app);
    handle(text);
    await Promise.resolve();
    expect(answers).toHaveLength(0);
    expect(seen).toHaveLength(0);
  });
});

describe("one socket cannot queue the whole admin pool", () => {
  test("refuses past the in-flight cap with a retryable status, and recovers", async () => {
    // Each dispatch may reserve one of `ADMIN_POOL_MAX` connections, so an
    // unbounded socket is one tenant queueing the pool every other tenant reads
    // through. 503 rather than a close: the socket is fine, this call is not.
    // A fresh `Response` per call: one shared instance has one body, and a
    // second read of it throws — which would make this measure the fake.
    const gate = Promise.withResolvers<void>();
    const { app } = appEchoing(async () => {
      await gate.promise;
      return new Response("late", { status: 200 });
    });
    const { handle, answers } = loopOver(app);
    for (let id = 0; id < 129; id++) handle(request(id, PLATFORM_ROUTES.sessionState));
    await vi.waitFor(() => {
      expect(answers).toHaveLength(1);
    });
    expect(answers[0]).toMatchObject({ id: 128, status: 503 });
    gate.resolve();
    await vi.waitFor(() => {
      expect(answers).toHaveLength(129);
    });
    // The cap is a WINDOW, not a budget: once the 128 settle the next call is
    // served rather than refused forever.
    handle(request(200, PLATFORM_ROUTES.sessionState));
    await vi.waitFor(() => {
      expect(answers.at(-1)).toMatchObject({ id: 200, status: 200 });
    });
  });
});

describe("the upgrade path grammar", () => {
  // Composed from `SLUG_PATTERN_SOURCE`, so the LENGTH bound comes with it — the
  // property a hand-written copy dropped in `orchestrator-security-validation`,
  // where it accepted a 200-character slug the upgrade path rejects.
  test.each([
    ["/my-agent/platform-socket", "my-agent"],
    [`/${"a".repeat(MAX_SLUG_LENGTH)}/platform-socket`, "a".repeat(MAX_SLUG_LENGTH)],
    ["/my-agent/websocket", undefined],
    ["/platform-socket", undefined],
    ["/my-agent/platform-socket/extra", undefined],
    ["/My_Agent!/platform-socket", undefined],
    ["/../etc/passwd/platform-socket", undefined],
    [`/${"a".repeat(MAX_SLUG_LENGTH + 1)}/platform-socket`, undefined],
  ])("%s names %s", (path, slug) => {
    expect(platformSocketSlug(path)).toBe(slug);
  });
});

/**
 * The three REFUSALS the handshake makes.
 *
 * Over the policy rather than over a socket: `platformHandshakeRefusal` is a
 * function of the header and the slug, and the accept path around it — the
 * upgrade, the frame listener, the idle reaper — is what
 * `platform-socket.scenario.test.ts` exists for.
 *
 * What is asserted is a STATUS LINE, because the alternative each of these used
 * to have is destroying the socket, which a guest cannot tell from a network
 * fault and would sit on the HTTP fallback forever.
 */
describe("what the handshake refuses", () => {
  const refusalFor = async (opts: {
    authorization?: string;
    version?: number | null;
    draining?: boolean;
  }) =>
    await platformHandshakeRefusal(
      {
        app: appEchoing().app,
        store: { getAgentVersion: async () => opts.version ?? null },
        isDraining: () => opts.draining === true,
      },
      { authorization: opts.authorization, slug: SLUG },
    );

  test("a draining replica answers 503 rather than accepting a socket it will drop", async () => {
    await expect(
      refusalFor({ authorization: "Bearer t", version: 1, draining: true }),
    ).resolves.toMatchObject({ status: "503 Service Unavailable" });
  });

  test("no credential answers 401", async () => {
    await expect(refusalFor({ version: 1 })).resolves.toMatchObject({
      status: "401 Unauthorized",
    });
  });

  test("an agent that does not exist answers 404", async () => {
    // The same policy, and the same statuses, every guest-called ROUTE answers —
    // `guestBearerRefusal`, so a handshake cannot open on credentials the routes
    // underneath it would refuse.
    await expect(refusalFor({ authorization: "Bearer t", version: null })).resolves.toMatchObject({
      status: "404 Not Found",
    });
  });
});
