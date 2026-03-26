// Copyright 2025 the AAI authors. MIT license.
import { expect, test } from "vitest";
import { z } from "zod";
import { agentToolsToSchemas } from "./internal-types.ts";
import type { ToolDef } from "./types.ts";

test("agentToolsToSchemas - converts tool definitions to OpenAI schema", () => {
  const tools: Record<string, ToolDef> = {
    get_weather: {
      description: "Get weather",
      parameters: z.object({
        city: z.string().describe("City"),
      }),
      execute: async () => {
        /* noop */
      },
    },
    set_alarm: {
      description: "Set alarm",
      parameters: z.object({
        time: z.string(),
        label: z.string().optional(),
      }),
      execute: async () => {
        /* noop */
      },
    },
  };
  const schemas = agentToolsToSchemas(tools);
  expect(schemas.length).toBe(2);
  expect(schemas[0]?.name).toBe("get_weather");
  expect(schemas[0]?.description).toBe("Get weather");
  expect(schemas[1]?.name).toBe("set_alarm");
});
