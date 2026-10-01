// Copyright 2026 the AAI authors. MIT license.
/**
 * `AGENT_MODES` is the run-time list of `AgentMode`: the two must name the same
 * four modes, since `resolveAgentMode` validates against the list and `agent()`
 * is overloaded over the type.
 */

import { describe, expect, expectTypeOf, test } from "vitest";
import { AGENT_MODES, type AgentMode } from "./agent-mode.ts";

describe("AGENT_MODES", () => {
  test("lists the four modes, pipeline (the default) first", () => {
    expect(AGENT_MODES).toEqual(["pipeline", "s2s", "text", "workflow-app"]);
  });

  test("is exactly the AgentMode union", () => {
    expectTypeOf<(typeof AGENT_MODES)[number]>().toEqualTypeOf<AgentMode>();
  });
});
