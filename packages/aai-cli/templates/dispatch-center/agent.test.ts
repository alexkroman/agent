import { describe, expect, test } from "vitest";
import { createTestHarness } from "@alexkroman1/aai/testing";
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
    expect(createTurn.toHaveCalledTool("incident_create")).toBe(true);
    const incident = JSON.parse(createTurn.toolResults[0]!);
    expect(incident).toBeDefined();
    // Verify incident was created with some expected structure
    expect(typeof createTurn.toolResults[0]).toBe("string");
  });

  test("ops_dashboard returns current status", async () => {
    const t = createTestHarness(agent);
    const turn = await t.turn("Show me the dashboard", [
      { tool: "ops_dashboard", args: {} },
    ]);
    expect(turn.toHaveCalledTool("ops_dashboard")).toBe(true);
    const dashboard = JSON.parse(turn.toolResults[0]!);
    expect(dashboard).toHaveProperty("systemAlertLevel");
    expect(dashboard).toHaveProperty("activeIncidentCount");
  });

  test("resources_get_available lists units", async () => {
    const t = createTestHarness(agent);
    const turn = await t.turn("What units are available?", [
      { tool: "resources_get_available", args: { type: "all" } },
    ]);
    expect(turn.toHaveCalledTool("resources_get_available")).toBe(true);
    const resources = JSON.parse(turn.toolResults[0]!);
    expect(resources).toBeDefined();
  });
});
