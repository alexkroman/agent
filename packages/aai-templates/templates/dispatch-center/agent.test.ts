import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDirTestHarness } from "@alexkroman1/aai/testing-v2";
import { describe, expect, test } from "vitest";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

describe("Dispatch Command Center", () => {
  test("create and triage an incident", async () => {
    const t = await createDirTestHarness(join(__dirname));
    await t.connect();

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
    const incident = createTurn.toolResult("incident_create");
    expect(incident).toBeDefined();
  });

  test("ops_dashboard returns current status", async () => {
    const t = await createDirTestHarness(join(__dirname));
    await t.connect();

    const turn = await t.turn("Show me the dashboard", [{ tool: "ops_dashboard", args: {} }]);
    const dashboard = turn.toolResult<{
      systemAlertLevel: string;
      activeIncidentCount: number;
    }>("ops_dashboard");
    expect(dashboard).toHaveProperty("systemAlertLevel");
    expect(dashboard).toHaveProperty("activeIncidentCount");
  });

  test("resources_get_available lists units", async () => {
    const t = await createDirTestHarness(join(__dirname));
    await t.connect();

    const turn = await t.turn("What units are available?", [
      { tool: "resources_get_available", args: { type: "all" } },
    ]);
    const resources = turn.toolResult("resources_get_available");
    expect(resources).toBeDefined();
  });

  test("onDisconnect persists state to KV", async () => {
    const t = await createDirTestHarness(join(__dirname));
    await t.connect();

    // Create an incident then disconnect
    await t.turn("Accident reported", [
      {
        tool: "incident_create",
        args: { location: "5th Ave", description: "Minor fender bender" },
      },
    ]);
    await t.disconnect();

    // Reconnect -- onConnect restores state from KV
    await t.connect();
    const turn = await t.turn("Dashboard", [{ tool: "ops_dashboard", args: {} }]);
    const dashboard = turn.toolResult<{ activeIncidentCount: number }>("ops_dashboard");
    expect(dashboard.activeIncidentCount).toBeGreaterThanOrEqual(1);
  });

  test("resolved incidents are cleaned up from KV", async () => {
    const t = await createDirTestHarness(join(__dirname));
    await t.connect();

    // Create and resolve an incident
    const createTurn = await t.turn("Fire at warehouse", [
      {
        tool: "incident_create",
        args: { location: "200 Industrial", description: "Small fire in warehouse" },
      },
    ]);
    const { incidentId } = createTurn.toolResult<{ incidentId: string }>("incident_create");

    await t.turn("Resolve it", [
      { tool: "incident_update_status", args: { incidentId, status: "resolved" } },
    ]);

    // Dashboard should show the snapshot was cleaned from KV
    const turn = await t.turn("Dashboard", [{ tool: "ops_dashboard", args: {} }]);
    const dashboard = turn.toolResult<{ persistedIncidentCount: number }>("ops_dashboard");
    expect(dashboard.persistedIncidentCount).toBe(0);
  });

  test("ops_dashboard includes persisted incident snapshots", async () => {
    const t = await createDirTestHarness(join(__dirname));
    await t.connect();

    await t.turn("Incoming call", [
      {
        tool: "incident_create",
        args: { location: "Main St", description: "Medical emergency, chest pain" },
      },
    ]);

    const turn = await t.turn("Dashboard", [{ tool: "ops_dashboard", args: {} }]);
    const dashboard = turn.toolResult<{
      persistedIncidentCount: number;
      persistedSnapshots: { id: string; severity: string; status: string }[];
    }>("ops_dashboard");
    expect(dashboard.persistedIncidentCount).toBe(1);
    expect(dashboard.persistedSnapshots[0]?.id).toMatch(/^INC-/);
  });
});
