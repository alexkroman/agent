// Copyright 2025 the AAI authors. MIT license.
import { expect, test } from "vitest";
import type { ToolDef } from "../types.ts";
import { agentToolsToSchemas } from "./internal-types.ts";

test("agentToolsToSchemas - passes through JSON Schema parameters", () => {
  const tools: Record<string, ToolDef> = {
    get_weather: {
      description: "Get weather",
      parameters: {
        type: "object",
        properties: { city: { type: "string", description: "City" } },
        required: ["city"],
      },
      execute: async () => {
        /* noop */
      },
    },
    set_alarm: {
      description: "Set alarm",
      parameters: {
        type: "object",
        properties: {
          time: { type: "string" },
          label: { type: "string" },
        },
        required: ["time"],
      },
      execute: async () => {
        /* noop */
      },
    },
  };
  const schemas = agentToolsToSchemas(tools);
  expect(schemas.length).toBe(2);
  expect(schemas[0]?.name).toBe("get_weather");
  expect(schemas[0]?.description).toBe("Get weather");
  expect(schemas[0]?.parameters).toHaveProperty("properties");
  expect(schemas[1]?.name).toBe("set_alarm");
});

test("agentToolsToSchemas - uses empty params for tools without parameters", () => {
  const tools: Record<string, ToolDef> = {
    ping: {
      description: "Ping",
      execute: () => "pong",
    },
  };
  const schemas = agentToolsToSchemas(tools);
  expect(schemas[0]?.parameters).toEqual({ type: "object", properties: {} });
});
