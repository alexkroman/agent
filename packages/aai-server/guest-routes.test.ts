// Copyright 2026 the AAI authors. MIT license.
/**
 * A guest surface a client must reach is reachable THROUGH THE PLATFORM.
 *
 * `aai dev` serves the guest's own routes directly, so every feature is
 * developed against a server where the guest's dispatch table IS the API. On
 * the platform a client reaches almost nothing that way: a browser is handed a
 * sandbox URL for the voice socket and a carrier is handed one in TwiML, but
 * anything else has to be brokered, which means the orchestrator needs a
 * `/:slug/…` route of its own. Nothing checked that it had one, and the same
 * bug landed twice: once as a whole surface with no platform route (every
 * request fell through to `app.notFound`), once as a route answering GET and
 * POST for a guest that also answers DELETE — a Stop button that worked in dev
 * and 404'd on every deployed agent.
 *
 * Neither is visible in a diff, and neither is visible in a test that drives
 * the guest, which is where the feature's tests live. So the declaration in
 * `GUEST_ROUTE_EXPOSURE` is checked against the routes the orchestrator really
 * registers, per method.
 *
 * Route introspection rather than requests on purpose: a real
 * `/:slug/client-config` would broker a sandbox, and what is under test is
 * whether the route EXISTS, not what it answers.
 */

import { describe, expect, test } from "vitest";
import {
  GUEST_ROUTE_EXPOSURE,
  GUEST_ROUTES,
  type GuestRouteExposure,
  proxiedGuestRoutes,
} from "./guest-routes.ts";
import { createOrchestrator } from "./orchestrator.ts";
import { createSlotCache } from "./sandbox-slots.ts";
import { createTestStore } from "./test-utils.ts";

/** Every `method path` the orchestrator registers, middleware included. */
function registeredRoutes(): { method: string; path: string }[] {
  const { app } = createOrchestrator({ slots: createSlotCache(), store: createTestStore() });
  return app.routes.map(({ method, path }) => ({ method, path }));
}

describe("guest route exposure", () => {
  test("every guest route declares one", () => {
    // The `satisfies` in guest-routes.ts makes this a compile error too; assert
    // it at runtime as well, so a widened type or a `Partial<>` cannot quietly
    // turn a missing declaration back into a default.
    expect(Object.keys(GUEST_ROUTE_EXPOSURE).sort()).toEqual(Object.keys(GUEST_ROUTES).sort());
  });

  test("a proxied route declares at least one method", () => {
    // `methods: []` would satisfy every assertion below by having nothing to
    // check — the vacuous pass this suite exists to prevent.
    for (const { path, methods } of proxiedGuestRoutes()) {
      expect(methods, `${path} is proxied but lists no methods`).not.toHaveLength(0);
    }
  });

  test("the declaration is not entirely direct-dial and host-only", () => {
    // If nothing is proxied, the parity test below asserts nothing at all —
    // which is exactly the state this file would have been written in before
    // the workflow API existed, and the state it must not silently return to.
    const proxied = Object.values(
      GUEST_ROUTE_EXPOSURE as Record<string, GuestRouteExposure>,
    ).filter((e) => e.via === "proxied");
    expect(proxied.length).toBeGreaterThan(0);
  });

  test("the platform registers every proxied guest route, for every method", () => {
    const registered = registeredRoutes();
    for (const { path, methods } of proxiedGuestRoutes()) {
      const platformPath = `/:slug${path}`;
      for (const method of methods) {
        const found = registered.some(
          (r) => r.path === platformPath && (r.method === method || r.method === "ALL"),
        );
        expect(
          found,
          `the guest answers ${method} ${path} but the platform has no ${method} ${platformPath} — ` +
            "a deployed caller gets a 404 while `aai dev` works. Register it in " +
            "orchestrator.ts, or change the declaration in guest-routes.ts if the " +
            "platform is deliberately not exposing it.",
        ).toBe(true);
      }
    }
  });

  test("a direct-dial or host-only route is not silently proxied instead", () => {
    // The reverse direction, and the cheaper half of the same mistake: a route
    // declared as reached-by-URL that the platform DOES serve means the
    // declaration is stale, and the next reader will trust it.
    const registered = registeredRoutes();
    for (const [key, exposure] of Object.entries(
      GUEST_ROUTE_EXPOSURE as Record<string, GuestRouteExposure>,
    )) {
      if (exposure.via === "proxied") continue;
      const path = GUEST_ROUTES[key as keyof typeof GUEST_ROUTES];
      // `/health` and `/phone` are the two paths where the platform serves the
      // SAME path for a different purpose — an answer of its own, not a
      // forward — so they are named here rather than papered over by matching
      // loosely.
      if (path === GUEST_ROUTES.health || path === GUEST_ROUTES.phone) continue;
      const hit = registered.find((r) => r.path === `/:slug${path}` && r.method !== "ALL");
      expect(
        hit,
        `${key} is declared ${exposure.via} but the platform registers ${hit?.method} /:slug${path}`,
      ).toBeUndefined();
    }
  });
});
