// Copyright 2026 the AAI authors. MIT license.
// The studio's project path shape, as pure functions.

import { describe, expect, test } from "vitest";
import { projectFromPath, projectPath } from "./project-route.ts";

describe("projectFromPath", () => {
  test("reads a project URL, and round-trips the one it builds", () => {
    expect(projectFromPath("/studio/chat/my-project")).toBe("my-project");
    expect(projectFromPath(projectPath("my-project"))).toBe("my-project");
    // Home is not a project.
    expect(projectFromPath("/")).toBeNull();
  });
});
