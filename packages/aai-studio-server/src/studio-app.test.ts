// Copyright 2026 the AAI authors. MIT license.
/**
 * The standalone studio service (split deployment) — see studio-app.ts.
 * Deep studio-route behavior is covered by studio-routes.test.ts against the
 * combined orchestrator; these tests pin what the split adds: the surface
 * serves standalone (mutations reach the agent service via the agents
 * row's deploy version — covered in aai-server's sandbox-resolve tests).
 */

import { createMemoryChatStore } from "aai-server/chat-store";
import { createMemoryPlatformEvents } from "aai-server/platform-events";
import { createTestStore } from "aai-server/test-utils";
import { createMemoryWorkspaceStore } from "aai-server/workspace-store";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clientDistFile, clientShellHtml } from "./_studio-client-dist-test-utils.ts";
import { createStudioApp, type StudioAppOpts } from "./studio-app.ts";
import { createMemoryPreviewQueue } from "./studio-preview-queue.ts";
import type { createStudioRoutes } from "./studio-routes.ts";

/** Options the app forwarded to `createStudioRoutes` on the last build. */
const routeOpts = vi.hoisted(() => ({}) as { last?: Parameters<typeof createStudioRoutes>[0] });

// The route factory is wrapped, not replaced: the app under test still gets
// real routes, and the forwarded options become observable. Without this the
// four conditional spreads below are invisible — with every option absent,
// omitting a key and passing it as `undefined` look identical from outside.
vi.mock("./studio-routes.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./studio-routes.ts")>();
  return {
    ...actual,
    createStudioRoutes: (opts: Parameters<typeof createStudioRoutes>[0]) => {
      routeOpts.last = opts;
      return actual.createStudioRoutes(opts);
    },
  };
});

function makeApp(overrides: Partial<StudioAppOpts> = {}) {
  // One process, so the memory queue — the choice the composition root makes,
  // spelled here because nothing downstream may make it any more. Returned so
  // the forwarding assertions below can name the instance they expect.
  const previewQueue = overrides.previewQueue ?? createMemoryPreviewQueue();
  const { app } = createStudioApp({
    store: createTestStore(),
    workspaces: createMemoryWorkspaceStore(),
    chats: createMemoryChatStore(),
    // Spelled here for the same reason `previewQueue` is: a test harness IS a
    // composition root, so it makes the choice rather than leaving a `??`
    // downstream to make a different one.
    events: createMemoryPlatformEvents().events,
    ...overrides,
    previewQueue,
  });
  const fetch = (path: string, init?: RequestInit) =>
    app.fetch(new Request(`http://studio.local${path}`, init));
  return { app, fetch, previewQueue };
}

describe("createStudioApp", () => {
  beforeEach(() => {
    delete routeOpts.last;
  });

  it("serves the health check, and 503s while draining", async () => {
    const healthy = makeApp();
    expect((await healthy.fetch("/health")).status).toBe(200);

    const draining = makeApp({ isDraining: () => true });
    expect((await draining.fetch("/health")).status).toBe(503);
  });

  it("serves the studio API surface standalone", async () => {
    const { fetch } = makeApp();
    // /studio/status is unauthenticated and answers regardless of LLM config.
    const status = await fetch("/studio/status");
    expect(status.status).toBe(200);
    await expect(status.json()).resolves.toMatchObject({ model: expect.any(String) });
  });

  it("scopes projects to the caller's bearer key", async () => {
    const { fetch } = makeApp();
    const created = await fetch("/studio/projects", {
      method: "POST",
      headers: { Authorization: "Bearer key1", "Content-Type": "application/json" },
      body: JSON.stringify({ name: "my-project" }),
    });
    expect(created.status).toBe(201);

    const mine = await fetch("/studio/projects", {
      headers: { Authorization: "Bearer key1" },
    });
    await expect(mine.json()).resolves.toEqual({ projects: ["my-project"] });

    const theirs = await fetch("/studio/projects", {
      headers: { Authorization: "Bearer key2" },
    });
    await expect(theirs.json()).resolves.toEqual({ projects: [] });
  });

  it("has no agent surface: slug routes 404", async () => {
    const { fetch } = makeApp();
    expect((await fetch("/some-agent/health")).status).toBe(404);
    expect((await fetch("/some-agent/client-config")).status).toBe(404);
  });

  it("serves the root studio page", async () => {
    const { fetch } = makeApp();
    const res = await fetch("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    // Tied to the CURRENT client build, so a `dist` that is absent, stale, or
    // from another branch is not all the same answer here.
    expect(await res.text()).toEqual(
      clientShellHtml() ?? expect.stringContaining("has not been built"),
    );
  });

  it("serves the same shell for a project URL", async () => {
    // `/studio/chat/<project>` is a shareable link; the client reads the
    // project from the path, so the server hands back the plain shell —
    // asserted as byte-identical to `GET /`, which is what "the same" means.
    const { fetch } = makeApp();
    const res = await fetch("/studio/chat/contact-form-x7k2mq");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toBe(await (await fetch("/")).text());
  });

  it("routes /robots.txt to a real policy, not to the slug validator", async () => {
    // The bug: production answered `400 Bad Request` to a crawler, because the
    // path fell through to the agent orchestrator's `/:slug` mount and
    // `validateSlug` rejected the dot. A well-formed request for a standard
    // file is not a bad request.
    //
    // Served from code rather than from `public/`, so — unlike the favicon
    // below — the status does not depend on whether the client was built. A
    // 404 here would make a crawler apply its own default instead.
    const { fetch } = makeApp();
    const res = await fetch("/robots.txt");

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(await res.text()).toContain("Disallow: /");
  });

  it("routes /favicon.ico to the favicon handler", async () => {
    // The not-built fallback page and non-browser clients request the icon at
    // the root, so it needs its own path. Whether the client is built decides
    // the status — read from the build output rather than accepted either way,
    // since `if (200) … else expect(404)` is satisfied by both and so by
    // nothing. The 404 arm keys off WHICH 404: the handler's own message
    // ("Favicon not found"), never the router's.
    const { fetch } = makeApp();
    const icon = clientDistFile("favicon.ico");
    const res = await fetch("/favicon.ico");

    const served = icon
      ? { status: res.status, detail: res.headers.get("content-type") }
      : { status: res.status, detail: await res.text() };
    expect(served).toEqual(
      icon
        ? { status: 200, detail: "image/x-icon" }
        : { status: 404, detail: expect.stringContaining("Favicon not found") },
    );
  });

  it.each(["/studio", "/studio/"])("redirects %s to the studio page", async (path) => {
    const { fetch } = makeApp();
    const res = await fetch(path);
    expect(res.status).toBe(302);
    // An empty Location would resolve to the current path — i.e. no redirect.
    expect(res.headers.get("location")).toBe("/");
  });

  describe("option forwarding", () => {
    // Three structurally identical `{}` sentinels, asserted by IDENTITY below
    // rather than with `toEqual`. Structural comparison cannot see the one
    // thing this suite exists to pin: pass the rate limiters as
    // `sessionRegistry` and the registry as `rateLimiters` and the whole
    // forwarded object is still `{rateLimiters:{}, sessionRegistry:{}, …}`.
    // Distinct object literals have distinct identities, so `toBe` per key is
    // the assertion that discriminates a swapped wiring.
    const registry = {} as NonNullable<StudioAppOpts["studioSessionRegistry"]>;
    const previewQueue = {} as NonNullable<StudioAppOpts["previewQueue"]>;
    const rateLimiters = {} as NonNullable<StudioAppOpts["studioRateLimiters"]>;

    it("passes each optional dependency through to the routes", () => {
      makeApp({
        studioRateLimiters: rateLimiters,
        studioSessionRegistry: registry,
        previewQueue,
        replicaId: "replica-7",
      });
      // Per key, by IDENTITY: a swapped wiring is the failure mode here.
      expect(routeOpts.last?.rateLimiters).toBe(rateLimiters);
      expect(routeOpts.last?.sessionRegistry).toBe(registry);
      expect(routeOpts.last?.previewQueue).toBe(previewQueue);
      expect(routeOpts.last?.replicaId).toBe("replica-7");
      // …and nothing else was invented alongside them.
      expect(Object.keys(routeOpts.last ?? {}).sort()).toEqual([
        "previewQueue",
        "rateLimiters",
        "replicaId",
        "sessionRegistry",
      ]);
    });

    it("omits an absent dependency rather than passing undefined", () => {
      // The routes distinguish "not configured" from "configured as
      // undefined" only by key presence, so the spreads must add nothing.
      // `previewQueue` is the exception and is REQUIRED, not spread: the
      // composition root always chooses one, so its absence is a compile error
      // rather than a silent downgrade to a queue that loses pending previews.
      const { previewQueue: chosen } = makeApp();
      expect(routeOpts.last?.previewQueue).toBe(chosen);
      expect(Object.keys(routeOpts.last ?? {})).toEqual(["previewQueue"]);
    });

    it("forwards one dependency without inventing the others", () => {
      const { previewQueue: chosen } = makeApp({ replicaId: "replica-7" });
      expect(routeOpts.last?.previewQueue).toBe(chosen);
      expect(routeOpts.last?.replicaId).toBe("replica-7");
      expect(Object.keys(routeOpts.last ?? {}).sort()).toEqual(["previewQueue", "replicaId"]);
    });
  });
});
