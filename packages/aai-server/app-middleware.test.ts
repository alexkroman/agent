// Copyright 2026 the AAI authors. MIT license.
/**
 * Specs for the base middleware both platform apps share.
 *
 * There were none, which mattered once the middleware grew something with no
 * visible answer: it RECORDS the origin the replica is reached on, for the spawn
 * paths that hold no request. Nothing in a response shows that, so removing the
 * line would leave every test green and quietly leave every deployed workflow
 * unable to mint a callback URL until an operator set `AAI_PUBLIC_ORIGIN`.
 */

import { Hono } from "hono";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { applyPlatformMiddleware, resolveAllowedOrigins } from "./app-middleware.ts";
import type { HonoEnv } from "./context.ts";
import { agentPublicBaseUrl, forgetObservedPublicOrigin } from "./public-origin.ts";

function appWithMiddleware(): Hono<HonoEnv> {
  const app = new Hono<HonoEnv>();
  applyPlatformMiddleware(app, undefined);
  app.get("/ok", (c) => c.text("ok"));
  return app;
}

describe("applyPlatformMiddleware", () => {
  beforeEach(() => {
    forgetObservedPublicOrigin();
  });

  test("records the public origin of every request it serves (local dev)", async () => {
    // The middleware reads `process.env`, and retention needs a DECLARED local
    // run — an unstubbed environment is production (see `isLocalDev`).
    vi.stubEnv("AAI_LOCAL_DEV", "1");
    const app = appWithMiddleware();
    // A LOOPBACK Host, which is what `pnpm dev:aai-server` serves and the only
    // form an origin is learned from — see `rememberPublicOrigin`, which
    // refuses the rest even here.
    await app.request(new Request("http://localhost:8080/ok"));
    expect(agentPublicBaseUrl("digest-desk", { AAI_LOCAL_DEV: "1" })).toBe(
      "http://localhost:8080/digest-desk",
    );
  });

  test("in production it records NOTHING, whatever Host a caller writes", async () => {
    // The middleware is where the poisoning happened: it runs on every request
    // before any auth, so an unauthenticated `GET /health` carrying
    // `Host: evil.example` set the origin baked into the next sandbox this
    // replica spawned — for any slug, any tenant. See `rememberPublicOrigin`.
    // Stubbed OFF rather than left unstubbed: "production" is the absence of the
    // declaration, and a developer with `AAI_LOCAL_DEV=1` exported in their
    // shell would otherwise turn this security assertion into a failing test
    // (or, in the mirror-image case, into one that passes for the wrong reason).
    vi.stubEnv("AAI_LOCAL_DEV", undefined);
    const app = appWithMiddleware();
    const res = await app.request(new Request("http://evil.example/ok"));
    expect(res.status).toBe(200);
    expect(agentPublicBaseUrl("someone-elses-agent", {})).toBeUndefined();
  });

  test("records it for a request that 404s too", async () => {
    // The recording sits ahead of routing on purpose — a replica whose only
    // traffic so far was a probe or a stray path still knows its own origin.
    vi.stubEnv("AAI_LOCAL_DEV", "1");
    const app = appWithMiddleware();
    await app.request(new Request("http://localhost:8080/nope"));
    expect(agentPublicBaseUrl("x", { AAI_LOCAL_DEV: "1" })).toBe("http://localhost:8080/x");
  });

  test("still answers the request it recorded", async () => {
    const app = appWithMiddleware();
    const res = await app.request(new Request("http://agent.example.modal.run/ok"));
    expect(res.status).toBe(200);
  });

  test("an unrouted path is a JSON 404", async () => {
    const res = await appWithMiddleware().request(new Request("http://localhost/nope"));
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "Not found" });
  });

  test("agent pages may be framed same-origin, so the studio preview works", async () => {
    // Paired with the studio shell's own policy: the live preview iframes agent
    // pages, and both surfaces are served by one process on one hostname.
    const res = await appWithMiddleware().request(new Request("http://localhost/ok"));
    expect(res.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  test("a cross-origin caller is refused when no origins are configured", async () => {
    const res = await appWithMiddleware().request(
      new Request("http://localhost/ok", { headers: { Origin: "https://evil.test" } }),
    );
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  describe("AAI_ALLOWED_ORIGINS", () => {
    // `allowedOrigins` was an option no composition set, whose own doc claimed
    // it defaulted to "any origin" while the behaviour was to reject every
    // cross-origin caller. Threading it from the environment HERE rather than
    // through each entry point is what keeps the two surfaces from drifting —
    // which is the whole reason this module exists.
    const originOf = async (env?: string): Promise<string | null> => {
      if (env !== undefined) vi.stubEnv("AAI_ALLOWED_ORIGINS", env);
      const res = await appWithMiddleware().request(
        new Request("http://localhost/ok", { headers: { Origin: "https://app.example" } }),
      );
      return res.headers.get("access-control-allow-origin");
    };

    test("a listed origin is allowed", async () => {
      await expect(originOf("https://app.example, https://other.example")).resolves.toBe(
        "https://app.example",
      );
    });

    test("an unlisted one still is not", async () => {
      await expect(originOf("https://other.example")).resolves.toBeNull();
    });

    test("`*` opens it, which has to be an explicit act", async () => {
      await expect(originOf("*")).resolves.toBe("*");
    });

    test("blank or whitespace reads as unset, not as an empty allow-list entry", async () => {
      await expect(originOf("  ")).resolves.toBeNull();
      expect(resolveAllowedOrigins({ AAI_ALLOWED_ORIGINS: " , " })).toBeUndefined();
      expect(resolveAllowedOrigins({})).toBeUndefined();
    });

    test("an explicit argument wins over the environment", async () => {
      vi.stubEnv("AAI_ALLOWED_ORIGINS", "*");
      const app = new Hono<HonoEnv>();
      applyPlatformMiddleware(app, []);
      app.get("/ok", (c) => c.text("ok"));
      const res = await app.request(
        new Request("http://localhost/ok", { headers: { Origin: "https://app.example" } }),
      );
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
    });
  });
});
