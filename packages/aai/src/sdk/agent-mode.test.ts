// Copyright 2026 the AAI authors. MIT license.
/**
 * `AGENT_MODES` is the run-time list of `AgentMode`: the two must name the same
 * four modes, since `resolveAgentMode` validates against the list and `agent()`
 * is overloaded over the type. `frontDoorOf` is the one mode → `page` mapping.
 */

import { describe, expect, expectTypeOf, test } from "vitest";
import { AGENT_MODES, type AgentMode, frontDoorOf } from "./agent-mode.ts";

describe("AGENT_MODES", () => {
  test("lists the four modes, pipeline (the default) first", () => {
    expect(AGENT_MODES).toEqual(["pipeline", "s2s", "text", "workflow-app"]);
  });

  test("is exactly the AgentMode union", () => {
    expectTypeOf<(typeof AGENT_MODES)[number]>().toEqualTypeOf<AgentMode>();
  });
});

describe("frontDoorOf", () => {
  test("a workflow app is a static page; every other mode, and none, is voice", () => {
    expect(frontDoorOf("workflow-app")).toBe("static");
    for (const mode of [undefined, "pipeline", "s2s", "text"] as const) {
      expect(frontDoorOf(mode), String(mode)).toBe("voice");
    }
  });
});
