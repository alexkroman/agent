// Copyright 2025 the AAI authors. MIT license.
/**
 * Cross-package smoke test.
 *
 * Verifies that plain object agent definitions are accepted by the server's
 * deploy endpoint, and that tool schemas survive the round trip.
 */

import type { AgentDef } from "@alexkroman1/aai";
import { agentToolsToSchemas, toAgentConfig } from "@alexkroman1/aai/host";
import { describe, expect, test } from "vitest";
import { createTestOrchestrator } from "./lib/test-utils.ts";

/**
 * Build a deploy body from an agent definition, mimicking what the CLI does.
 */
function buildDeployBodyFromAgent(agent: AgentDef): string {
  const config = toAgentConfig(agent);
  const _schemas = agentToolsToSchemas(agent.tools);

  return JSON.stringify({
    env: { ASSEMBLYAI_API_KEY: "test-key" },
    worker: `export default ${JSON.stringify(config)};`,
    clientFiles: {
      "index.html": "<html><body>test</body></html>",
      "assets/index.js": "console.log('client');",
    },
  });
}

const smokeAgent: AgentDef = {
  name: "smoke-test",
  systemPrompt: "Test agent for cross-package validation.",
  greeting: "Hello from smoke test",
  maxSteps: 3,
  builtinTools: ["web_search"],
  tools: {
    echo: {
      description: "Echo the input",
      parameters: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
      execute: (args) => `echo:${args.text}`,
    },
  },
};

describe("cross-package smoke: SDK → server deploy", () => {
  test("agent config is accepted by server deploy endpoint", async () => {
    const { fetch } = await createTestOrchestrator();
    const body = buildDeployBodyFromAgent(smokeAgent);
    const res = await fetch("/smoke-test/deploy", {
      method: "POST",
      headers: { Authorization: "Bearer key1", "Content-Type": "application/json" },
      body,
    });
    expect(res.status).toBe(200);
  });

  test("deployed agent is accessible via health and page endpoints", async () => {
    const agent: AgentDef = {
      name: "accessible-agent",
      systemPrompt: "",
      greeting: "",
      maxSteps: 5,
      tools: {},
    };
    const { fetch } = await createTestOrchestrator();

    await fetch("/accessible-agent/deploy", {
      method: "POST",
      headers: { Authorization: "Bearer key1", "Content-Type": "application/json" },
      body: buildDeployBodyFromAgent(agent),
    });

    const healthRes = await fetch("/accessible-agent/health");
    expect(healthRes.status).toBe(200);
    expect(((await healthRes.json()) as Record<string, unknown>).slug).toBe("accessible-agent");

    const pageRes = await fetch("/accessible-agent/");
    expect(pageRes.status).toBe(200);
    expect(await pageRes.text()).toContain("<html>");
  });

  test("toAgentConfig produces JSON-safe config from agent", () => {
    const agent: AgentDef = {
      name: "json-safe",
      systemPrompt: "Custom system prompt",
      greeting: "Hi",
      maxSteps: 10,
      toolChoice: "required",
      builtinTools: ["web_search", "run_code"],
      tools: {
        search: {
          description: "Search",
          parameters: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
          },
          execute: (args) => args.query,
        },
      },
    };

    const config = toAgentConfig(agent);
    const roundTripped = JSON.parse(JSON.stringify(config));
    expect(roundTripped.name).toBe("json-safe");
    expect(roundTripped.systemPrompt).toBe("Custom system prompt");
    expect(roundTripped.greeting).toBe("Hi");
    expect(roundTripped.maxSteps).toBe(10);
    expect(roundTripped.toolChoice).toBe("required");
    expect(roundTripped.builtinTools).toEqual(["web_search", "run_code"]);
  });

  test("tool schemas from agent match expected server format", () => {
    const agent: AgentDef = {
      name: "schema-check",
      systemPrompt: "",
      greeting: "",
      maxSteps: 5,
      tools: {
        greet: {
          description: "Greet by name",
          parameters: {
            type: "object",
            properties: {
              name: { type: "string" },
              formal: { type: "boolean" },
            },
            required: ["name"],
          },
          execute: (args) => `Hello, ${args.name}!`,
        },
        noParams: {
          description: "No params tool",
          execute: () => "done",
        },
      },
    };

    const schemas = agentToolsToSchemas(agent.tools);

    const greetSchema = schemas.find((s) => s.name === "greet");
    expect(greetSchema).toBeDefined();
    expect(greetSchema?.description).toBe("Greet by name");
    expect(greetSchema?.parameters).toHaveProperty("properties");
    expect(
      (greetSchema?.parameters as { properties: Record<string, unknown> }).properties,
    ).toHaveProperty("name");

    const noParamsSchema = schemas.find((s) => s.name === "noParams");
    expect(noParamsSchema).toBeDefined();
    expect(noParamsSchema?.description).toBe("No params tool");
  });
});
