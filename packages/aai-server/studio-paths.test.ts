// Copyright 2026 the AAI authors. MIT license.
import { RESERVED_SLUGS } from "@alexkroman1/aai/utils";
import { describe, expect, test } from "vitest";
import { isStudioPath } from "./studio-paths.ts";

describe("isStudioPath", () => {
  test.each([
    ["/", true],
    ["/favicon.ico", true],
    ["/studio", true],
    ["/studio/", true],
    ["/studio/chat/my-project", true],
    ["/studio-assets/app.js", true],
    // The agent surface. `/health` in particular must stay local: it is what
    // Modal's proxy polls, and what shutdown flips to stop routing here.
    ["/health", false],
    ["/deploy", false],
    ["/my-agent", false],
    ["/my-agent/websocket", false],
    ["/my-agent/client-config", false],
    // Prefix-adjacent slugs that must NOT be captured — `startsWith("/studio")`
    // (without the separator) would swallow both of these, and they are legal
    // agent slugs.
    ["/studious", false],
    ["/studio-helper", false],
  ])("%s → studio: %s", (pathname, expected) => {
    expect(isStudioPath(pathname)).toBe(expected);
  });

  // RESERVED_SLUGS covers BOTH surfaces, so it does not map onto this
  // predicate wholesale: `studio`/`studio-assets` are reserved because the
  // dispatcher sends them to the studio, while `health`/`metrics`/`deploy` are
  // reserved because they are the AGENT app's own routes. An agent claiming
  // either group would shadow a real route; only the first group is a studio
  // path. Asserting the split is what makes a slug added to one group without
  // the other visible here.
  describe("agrees with RESERVED_SLUGS", () => {
    test("the reserved set is exactly what these cases cover", () => {
      // Fails when a slug is reserved without deciding which surface owns it.
      expect([...RESERVED_SLUGS].toSorted()).toEqual([
        "deploy",
        "health",
        "metrics",
        "studio",
        "studio-assets",
      ]);
    });

    test.each(["studio", "studio-assets"])("studio-owned %s routes to the studio", (slug) => {
      // `/studio-assets` bare is deliberately NOT matched — assets are always
      // requested as `/studio-assets/<file>`, and the reservation is what keeps
      // an agent from taking the name either way.
      expect(isStudioPath(`/${slug}/`)).toBe(true);
    });

    test.each(["health", "metrics", "deploy"])("agent-owned %s stays local", (slug) => {
      expect(isStudioPath(`/${slug}`)).toBe(false);
    });
  });
});
