// Copyright 2026 the AAI authors. MIT license.
import { afterEach, describe, expect, test, vi } from "vitest";
import { tool } from "./define.ts";
import { publishStepMcp, type StepMcpFn, stepMcp, stubStepMcp } from "./step-mcp.ts";

afterEach(() => publishStepMcp(undefined));

const SERVERS = { apps: { url: "https://a.example/mcp" } };

describe("stepMcp", () => {
  test("unpublished, it rejects, naming the servers and the fake to reach for", async () => {
    await expect(stepMcp(SERVERS)).rejects.toThrow(/stepMcp\(apps\).*stubStepMcp/s);
  });

  test("a published connector is handed the record and the options", async () => {
    const connector = vi.fn<StepMcpFn>(async () => ({
      tools: {},
      servers: [],
      close: async () => undefined,
    }));
    publishStepMcp(connector);
    await stepMcp(SERVERS, { clientId: "c-1" });
    expect(connector.mock.calls).toEqual([[SERVERS, { clientId: "c-1" }]]);
  });

  test("stubStepMcp answers its tools, records each call, and restores", async () => {
    const search = tool({ description: "Search", execute: () => "ok" });
    const stub = stubStepMcp({ mcp_apps_search: search });
    const mcp = await stepMcp(SERVERS, { clientId: "c-1" });
    expect(Object.keys(mcp.tools)).toEqual(["mcp_apps_search"]);
    expect(mcp.servers).toEqual([{ key: "apps", tools: ["mcp_apps_search"] }]);
    expect(stub.calls).toEqual([{ keys: ["apps"], options: { clientId: "c-1" } }]);
    await expect(mcp.close()).resolves.toBeUndefined();
    stub.restore();
    await expect(stepMcp(SERVERS)).rejects.toThrow("no MCP connector");
  });
});
