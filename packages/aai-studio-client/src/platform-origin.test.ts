// @vitest-environment jsdom
// Copyright 2026 the AAI authors. MIT license.
// The platform origin is the page's own, and an agent URL is absolute — the
// text is what people copy out, so a bare "/slug/" would be useless pasted
// anywhere else.

import { describe, expect, test } from "vitest";
import { agentUrl, platformOrigin } from "./platform-origin.ts";

describe("platformOrigin", () => {
  test("is this page's origin, with no round trip", () => {
    expect(platformOrigin()).toBe(window.location.origin);
  });
});

describe("agentUrl", () => {
  test("is an ABSOLUTE URL carrying the origin, with a trailing slash", () => {
    const url = agentUrl("support-bot");
    expect(url).toBe(`${window.location.origin}/support-bot/`);
    expect(new URL(url).origin).toBe(window.location.origin);
  });

  test("ignores the page's own path — the slug is rooted at the origin", () => {
    const before = window.location.href;
    history.pushState(null, "", "/studio/projects/demo?tab=docs");
    try {
      expect(agentUrl("demo-agent")).toBe(`${window.location.origin}/demo-agent/`);
    } finally {
      history.replaceState(null, "", before);
    }
  });

  test("percent-encodes a slug the URL parser would otherwise mangle", () => {
    expect(agentUrl("a b")).toBe(`${window.location.origin}/a%20b/`);
  });
});
