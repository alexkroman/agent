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
import { beforeEach, describe, expect, test } from "vitest";
import { applyPlatformMiddleware } from "./app-middleware.ts";
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

  test("records the public origin of every request it serves", async () => {
    const app = appWithMiddleware();
    // Cleartext with a public Host, which is what Modal forwards: the resolver
    // is what turns that into https, and this asserts the middleware ran it.
    await app.request(new Request("http://agent.example.modal.run/ok"));
    expect(agentPublicBaseUrl("digest-desk", {})).toBe(
      "https://agent.example.modal.run/digest-desk",
    );
  });

  test("records it for a request that 404s too", async () => {
    // The recording sits ahead of routing on purpose — a replica whose only
    // traffic so far was a probe or a stray path still knows its own origin.
    const app = appWithMiddleware();
    await app.request(new Request("http://agent.example.modal.run/nope"));
    expect(agentPublicBaseUrl("x", {})).toBe("https://agent.example.modal.run/x");
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
});
