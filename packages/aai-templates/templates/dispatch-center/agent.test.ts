import { createTestHarness } from "@alexkroman1/aai/testing";
import { describe, expect, test } from "vitest";
import "@alexkroman1/aai/testing/matchers";
import agent from "./agent.ts";

describe("Dispatch Command Center", () => {
  test("agent is defined with correct name", () => {
    expect(agent.name).toBe("Dispatch Command Center");
  });

  test("has dispatch tools", () => {
    expect(agent.tools).toHaveProperty("incident_create");
    expect(agent.tools).toHaveProperty("incident_triage");
    expect(agent.tools).toHaveProperty("resources_dispatch");
    expect(agent.tools).toHaveProperty("resources_get_available");
    expect(agent.tools).toHaveProperty("ops_dashboard");
  });

  test("create and triage an incident", async () => {
    const t = createTestHarness(agent);

    const createTurn = await t.turn("Car accident on Main Street", [
      {
        tool: "incident_create",
        args: {
          location: "Main Street and 1st Ave",
          description: "Two-car collision, one person trapped",
          callerName: "John",
          callerPhone: "555-0100",
        },
      },
    ]);
    expect(createTurn).toHaveCalledTool("incident_create");
    const incident = createTurn.toolResult("incident_create");
    expect(incident).toBeDefined();
  });

  test("ops_dashboard returns current status", async () => {
    const t = createTestHarness(agent);
    const turn = await t.turn("Show me the dashboard", [{ tool: "ops_dashboard", args: {} }]);
    expect(turn).toHaveCalledTool("ops_dashboard");
    const dashboard = turn.toolResult("ops_dashboard");
    expect(dashboard).toHaveProperty("systemAlertLevel");
    expect(dashboard).toHaveProperty("activeIncidentCount");
  });

  test("resources_get_available lists units", async () => {
    const t = createTestHarness(agent);
    const turn = await t.turn("What units are available?", [
      { tool: "resources_get_available", args: { type: "all" } },
    ]);
    expect(turn).toHaveCalledTool("resources_get_available");
    const resources = turn.toolResult("resources_get_available");
    expect(resources).toBeDefined();
  });
});
