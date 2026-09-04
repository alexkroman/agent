// Copyright 2026 the AAI authors. MIT license.
/**
 * The gate under the route table.
 *
 * The table's whole value is that two readers derive from it — `server.ts`'s
 * dispatch and `aai-server`'s `GUEST_ROUTES` — so a table that stopped listing
 * routes would leave both of them agreeing about nothing while every assertion
 * over it passed vacuously. Same shape as the corpus floors on the ratchets in
 * `scripts/`, and the reason each suite below carries one.
 */

import { describe, expect, test } from "vitest";
import {
  CLIENT_CONFIG_ROUTE,
  HEALTH_PATH,
  routeMatches,
  SERVER_ROUTES,
  SESSION_PATH,
  type ServerRoute,
  WORKFLOW_CALLBACK_ROUTES,
} from "./server-routes.ts";
import { WORKFLOW_WEBHOOK_PATH, WORKFLOW_WEBHOOK_PREFIX } from "./workflow-serve.ts";

const ALL: [string, ServerRoute][] = [
  ...Object.entries(SERVER_ROUTES),
  ...Object.entries(WORKFLOW_CALLBACK_ROUTES),
];

describe("the route tables", () => {
  test("both are populated", () => {
    // The floor. An extraction that stopped finding routes would make every
    // other test here pass over an empty list.
    expect(Object.keys(SERVER_ROUTES).length).toBeGreaterThanOrEqual(7);
    // Two, down from four: the DevKit's `flow` and `step` callbacks went with it.
    // The floor moves with the table rather than being relaxed to zero — its job
    // is to stop an extraction that found NOTHING from making every other case
    // here pass over an empty list.
    expect(Object.keys(WORKFLOW_CALLBACK_ROUTES).length).toBeGreaterThanOrEqual(2);
  });

  test("every path is absolute and carries no query or trailing slash", () => {
    for (const [key, route] of ALL) {
      expect(route.path.startsWith("/"), `${key}: ${route.path}`).toBe(true);
      expect(route.path, key).not.toContain("?");
      // `requestPath` has already cut the query off before a route is matched,
      // and a trailing slash would make an `exact` match unreachable — the
      // webhook prefix is the one that has one, and it is derived FROM the
      // slash-less path here rather than being it.
      if (route.path !== "/") expect(route.path.endsWith("/"), key).toBe(false);
    }
  });

  test("an http route names at least one method, or says it gates none", () => {
    // `methods: []` is the vacuous pass: it satisfies "does the platform answer
    // every method?" by having nothing to answer. `"any"` is how a route that
    // really gates no verb says so out loud.
    for (const [key, route] of ALL) {
      if (route.transport !== "http") continue;
      if (route.methods === "any") continue;
      expect(route.methods, `${key} gates no method and does not say "any"`).not.toHaveLength(0);
    }
  });

  test("the webhook prefix derives from the declared path", () => {
    // The one place the two spellings could drift, and the reason they are two
    // declarations rather than two literals.
    expect(WORKFLOW_WEBHOOK_PREFIX).toBe(`${WORKFLOW_WEBHOOK_PATH}/`);
    expect(WORKFLOW_CALLBACK_ROUTES.webhook.path).toBe(WORKFLOW_WEBHOOK_PATH);
  });
});

describe("routeMatches", () => {
  test("an exact route rejects a longer path", () => {
    expect(routeMatches(SERVER_ROUTES.health, HEALTH_PATH, "GET")).toBe(true);
    expect(routeMatches(SERVER_ROUTES.health, `${HEALTH_PATH}/deep`, "GET")).toBe(false);
  });

  test("a prefix route accepts a longer path", () => {
    // The session socket is a prefix precisely so an upgrade with a trailing
    // segment still matches — the behaviour `server.ts` had as `startsWith`.
    expect(routeMatches(SERVER_ROUTES.session, SESSION_PATH)).toBe(true);
    expect(routeMatches(SERVER_ROUTES.session, `${SESSION_PATH}/x`)).toBe(true);
    expect(routeMatches(SERVER_ROUTES.session, "/other")).toBe(false);
  });

  test("health answers HEAD as well as GET", () => {
    // A load balancer's default probe is often HEAD, and a 404 to it pulls the
    // deployment out of rotation while `GET /health` reports ok. Asserted on
    // the TABLE rather than on one door, because `createRuntimeServer` is what `aai
    // dev`, the guest harness and `createHostServer` each call directly.
    expect(routeMatches(SERVER_ROUTES.health, HEALTH_PATH, "GET")).toBe(true);
    expect(routeMatches(SERVER_ROUTES.health, HEALTH_PATH, "HEAD")).toBe(true);
  });

  test("a method the route does not answer does not match", () => {
    expect(routeMatches(SERVER_ROUTES.health, HEALTH_PATH, "POST")).toBe(false);
    expect(
      routeMatches(WORKFLOW_CALLBACK_ROUTES.queue, WORKFLOW_CALLBACK_ROUTES.queue.path, "GET"),
    ).toBe(false);
  });

  test('a route declared "any" answers every verb', () => {
    // Kept as a property of `routeMatches` itself. The webhook used to be the
    // one route declaring it — see below for why it no longer may — and with no
    // declared instance left this branch would go unexercised.
    const anyVerb: ServerRoute = {
      transport: "http",
      path: "/anything",
      match: "exact",
      methods: "any",
    };
    for (const method of ["GET", "POST", "PUT", "DELETE", "PATCH"]) {
      expect(routeMatches(anyVerb, "/anything", method), method).toBe(true);
    }
  });

  test("the webhook answers POST and nothing else", () => {
    // A delivery is PERMANENT — it resolves a waitpoint and closes the hook —
    // so the verb gate is a security control, not a nicety: while this route
    // declared `"any"`, a bare `GET` from a link-preview fetcher or a URL
    // scanner resolved an approval workflow with no human involved. A delivery
    // carries a payload, so it is a verb that has a body.
    const url = `${WORKFLOW_WEBHOOK_PATH}/tok`;
    expect(routeMatches(WORKFLOW_CALLBACK_ROUTES.webhook, url, "POST")).toBe(true);
    for (const method of ["GET", "HEAD", "PUT", "DELETE", "PATCH", "OPTIONS"]) {
      expect(routeMatches(WORKFLOW_CALLBACK_ROUTES.webhook, url, method), method).toBe(false);
    }
  });

  test("omitting the method skips the verb gate", () => {
    // An upgrade has no method to gate on, which is how `server.ts` calls it
    // for the session socket.
    expect(routeMatches(SERVER_ROUTES.health, HEALTH_PATH)).toBe(true);
  });

  test("the client-config route is the SDK path with a leading slash", () => {
    expect(CLIENT_CONFIG_ROUTE).toBe("/client-config");
    expect(routeMatches(SERVER_ROUTES.clientConfig, CLIENT_CONFIG_ROUTE, "GET")).toBe(true);
  });
});
