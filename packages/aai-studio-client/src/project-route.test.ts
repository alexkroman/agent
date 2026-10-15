// Copyright 2026 the AAI authors. MIT license.
// The studio's project path shape, as pure functions.

import { MAX_SLUG_LENGTH } from "@alexkroman1/aai/internal";
import { describe, expect, test } from "vitest";
import { projectFromPath, projectPath } from "./project-route.ts";

describe("projectFromPath", () => {
  test("reads a project URL, and round-trips the one it builds", () => {
    expect(projectFromPath("/studio/chat/my-project")).toBe("my-project");
    expect(projectFromPath(projectPath("my-project"))).toBe("my-project");
    // Home is not a project.
    expect(projectFromPath("/")).toBeNull();
  });

  test("the name segment is the platform's slug grammar, not a looser copy", () => {
    expect(projectFromPath("/studio/chat/my-project/")).toBe("my-project");
    // A name the server would refuse is no project: one character, a trailing
    // separator, uppercase, or longer than a slug may be.
    expect(projectFromPath("/studio/chat/a")).toBeNull();
    expect(projectFromPath("/studio/chat/agent-")).toBeNull();
    expect(projectFromPath("/studio/chat/My-Project")).toBeNull();
    expect(projectFromPath(`/studio/chat/${"a".repeat(MAX_SLUG_LENGTH + 1)}`)).toBeNull();
    expect(projectFromPath(`/studio/chat/${"a".repeat(MAX_SLUG_LENGTH)}`)).toBe(
      "a".repeat(MAX_SLUG_LENGTH),
    );
    // Anchored: nothing before the prefix or after the name.
    expect(projectFromPath("/x/studio/chat/my-project")).toBeNull();
    expect(projectFromPath("/studio/chat/my-project/files")).toBeNull();
  });
});
