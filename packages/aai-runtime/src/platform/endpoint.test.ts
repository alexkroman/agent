// Copyright 2026 the AAI authors. MIT license.
/**
 * `platformUrl` — the one spelling of `<base><route>[/<segment>]` the platform
 * clients share — and the route table's invariants.
 */

import { describe, expect, test } from "vitest";
import { PLATFORM_ROUTES, PLATFORM_SOCKET_PATH, platformUrl } from "./endpoint.ts";

const BASE = "https://api.test/my-agent";

describe("platformUrl", () => {
  test("joins the base and the route", () => {
    expect(platformUrl(BASE, PLATFORM_ROUTES.sessionState)).toBe(
      "https://api.test/my-agent/session-state",
    );
  });

  test("strips any number of trailing slashes on the operator-set base", () => {
    expect(platformUrl(`${BASE}///`, PLATFORM_ROUTES.workflowJournal)).toBe(
      "https://api.test/my-agent/workflow-journal",
    );
  });

  test("appends a segment, percent-encoded so it stays ONE path segment", () => {
    expect(platformUrl(BASE, PLATFORM_ROUTES.workflowJournal, "appendEvents")).toBe(
      "https://api.test/my-agent/workflow-journal/appendEvents",
    );
    expect(platformUrl(BASE, PLATFORM_ROUTES.workflowKeys, "a/b c")).toBe(
      "https://api.test/my-agent/workflow-keys/a%2Fb%20c",
    );
  });
});

describe("the route table", () => {
  test("every route is a distinct absolute path, and the socket path is none of them", () => {
    const routes = Object.values(PLATFORM_ROUTES);
    expect(new Set(routes).size).toBe(routes.length);
    for (const route of routes) expect(route).toMatch(/^\/[a-z-]+$/);
    expect(routes).not.toContain(PLATFORM_SOCKET_PATH);
  });
});
