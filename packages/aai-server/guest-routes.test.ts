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

import { CLIENT_CONFIG_METHODS } from "@alexkroman1/aai/protocol";
import { WORKFLOW_API_METHODS } from "@alexkroman1/aai/runtime";
import { describe, expect, test } from "vitest";
import {
  GUEST_ROUTE_EXPOSURE,
  GUEST_ROUTES,
  type GuestRouteExposure,
  PROXIED_HTTP_METHODS,
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

  test("a parameterized proxied route is declared with its suffix", () => {
    // The guest path is a PREFIX for a route whose last segment is a parameter
    // (the webhook token), so `/:slug<guest path>` alone would register a route
    // no real request matches — and the parity test below would still pass,
    // having checked the wrong path. The suffix is what keeps it honest.
    const webhook = proxiedGuestRoutes().find((r) => r.path.includes("/webhook"));
    expect(webhook?.path).toBe(`${GUEST_ROUTES.workflowWebhook}/:token`);
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

  test("the queue's own callbacks stay off the platform", () => {
    // Named rather than left to the generic reverse check below: `flow` and
    // `step` are unauthenticated BECAUSE only the guest's own worker dials
    // them on loopback, so a platform route for either is not a routing
    // decision — it is an unauthenticated way to drive another tenant's run.
    expect(GUEST_ROUTE_EXPOSURE.workflowFlow.via).toBe("guest-internal");
    expect(GUEST_ROUTE_EXPOSURE.workflowStep.via).toBe("guest-internal");
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

/**
 * Where each proxied route's methods COME FROM, on the guest's side.
 *
 * The suite above checks the declaration against the platform's router; both
 * halves of that live in this package, so it passes whenever they agree with
 * each other — including when they agree and are both wrong about the guest.
 * That is the half every real incident came from. `GUEST_ROUTE_EXPOSURE` says
 * outright that "the methods are the ones the GUEST answers" and that "the
 * declaration is written from the guest's dispatch", and nothing checked it:
 *
 * - `api.cancel(runId)` is a DELETE. The guest answered it, the declaration did
 *   not list it, so declaration and platform agreed — and every Stop button on
 *   a deployed agent 404'd while `aai dev` worked.
 * - `api.uploadStream(id, file)` is a PUT. Same shape, and worse to read: the
 *   hook took the 404 for a failed upload and CANCELLED the run half a second
 *   after starting it, logging `Workflow run cancelled`.
 *
 * So each proxied route names the SDK export that owns its verbs. Two of the
 * three are derived from the guest's own dispatch, which is what makes adding a
 * route to `workflow-api.ts`'s table enough on its own.
 */
/**
 * Code-unit order, spelled out — the default `.sort()` already applies to
 * strings, made explicit because `useArraySortCompare` cannot see the element
 * type through a `.map()`. NOT `localeCompare`: with no explicit locale that
 * answers to the runtime's ICU, so the same tree would compare differently on
 * another machine (the rule `API-EXPORTS.json`'s sort follows for the same
 * reason).
 */
const byCodeUnit = (a: string, b: string): number => {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
};

const METHOD_SOURCES: Record<string, { source: string; methods: readonly string[] }> = {
  // `host/server.ts` gates the endpoint on this very array.
  clientConfig: { source: "CLIENT_CONFIG_METHODS", methods: CLIENT_CONFIG_METHODS },
  // Derived from the `ROUTES` table that dispatches them.
  workflows: { source: "WORKFLOW_API_METHODS", methods: WORKFLOW_API_METHODS },
  // Not derived, because there is nothing to derive from: `pickWorkflowHandler`
  // gates flow and step on POST and applies NO method check to a webhook, since
  // the URL goes to a third party that picks its own verb. "The guest gates
  // nothing" is therefore asserted as "the declaration lists the whole
  // vocabulary" — which is why that vocabulary is one exported constant.
  workflowWebhook: { source: "PROXIED_HTTP_METHODS", methods: PROXIED_HTTP_METHODS },
};

describe("proxied methods match what the guest answers", () => {
  test("every proxied route names where its methods come from", () => {
    // The anti-vacuous half, and the reason this is a map rather than three
    // assertions: a NEW proxied route is silently unchecked otherwise, which is
    // exactly how the workflow API went two verbs unguarded. Failing here forces
    // one decision — which SDK export owns this route's verbs — at the moment
    // the route is declared.
    expect(Object.keys(METHOD_SOURCES).sort(byCodeUnit)).toEqual(
      proxiedGuestRoutes()
        .map((r) => r.key)
        .sort(byCodeUnit),
    );
  });

  test("a method source is never empty", () => {
    // `methods: []` on either side would make the comparison below pass by
    // having nothing to compare — the same vacuous pass the sibling suite
    // guards against, one layer down.
    for (const [key, { source, methods }] of Object.entries(METHOD_SOURCES)) {
      expect(methods, `${key}: ${source} resolved to no methods`).not.toHaveLength(0);
    }
  });

  test("the declared methods are exactly the ones the guest answers", () => {
    for (const { key, path, methods } of proxiedGuestRoutes()) {
      const expected = METHOD_SOURCES[key];
      // The completeness test above owns the missing-entry case; skipping here
      // keeps this failure about verbs rather than reporting the same gap twice.
      if (!expected) continue;
      expect(
        [...methods].sort(byCodeUnit),
        `${key} declares [${[...methods].sort(byCodeUnit).join(", ")}] for ${path}, but the guest ` +
          `answers [${[...expected.methods].sort(byCodeUnit).join(", ")}] per ${expected.source}. A verb ` +
          "answers and the platform does not register 404s only once deployed — `aai dev` serves " +
          "the guest directly. Update the methods in guest-routes.ts (and the platform route in " +
          "orchestrator.ts, which the sibling suite then checks).",
      ).toEqual([...expected.methods].sort(byCodeUnit));
    }
  });
});
