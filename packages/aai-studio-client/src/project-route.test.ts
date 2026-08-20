// Copyright 2026 the AAI authors. MIT license.
// The studio's two path shapes, as pure functions.
//
// `apiDocsSlugFromPath` in particular is what decides, before anything
// renders, whether this page load is the PUBLIC API page or the signed-in
// studio (main.tsx) — so a pattern that matched too much would put a
// sessionless page over the studio, and one that matched too little would put
// a sign-in screen in front of a public link. Both are worth asserting off a
// render.

import { describe, expect, test } from "vitest";
import { apiDocsPath, apiDocsSlugFromPath, projectFromPath, projectPath } from "./project-route.ts";

describe("apiDocsSlugFromPath", () => {
  test.each([
    ["/studio/api/my-agent", "my-agent"],
    // A trailing slash is the same page — a browser adds one freely.
    ["/studio/api/my-agent/", "my-agent"],
    ["/studio/api/contact-form-x7k2mq", "contact-form-x7k2mq"],
    // The studio's own paths, which must keep reaching the studio.
    ["/", null],
    ["/studio/chat/my-project", null],
    // Not a slug the platform could ever have deployed.
    ["/studio/api/Not-A-Slug", null],
    ["/studio/api/", null],
    // A second segment is a different page, and there is none.
    ["/studio/api/my-agent/extra", null],
  ])("%s → %s", (pathname, expected) => {
    expect(apiDocsSlugFromPath(pathname)).toBe(expected);
  });

  test("round-trips the path the studio hands out", () => {
    // The API pane builds this link and this function reads it back — the one
    // agreement that has to hold, and the one nothing else would catch.
    expect(apiDocsSlugFromPath(apiDocsPath("contact-form-x7k2mq"))).toBe("contact-form-x7k2mq");
  });
});

describe("projectFromPath", () => {
  test("reads a project URL, and round-trips the one it builds", () => {
    expect(projectFromPath("/studio/chat/my-project")).toBe("my-project");
    expect(projectFromPath(projectPath("my-project"))).toBe("my-project");
    // Home, and the public API page, are not projects.
    expect(projectFromPath("/")).toBeNull();
    expect(projectFromPath("/studio/api/my-agent")).toBeNull();
  });
});
