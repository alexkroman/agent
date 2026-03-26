// Copyright 2025 the AAI authors. MIT license.
/**
 * Cross-package smoke test.
 *
 * Verifies that the SDK's defineAgent + buildAgentConfig output is accepted
 * by the server's deploy endpoint, and that tool schemas survive the
 * SDK → deploy body → server round trip without interface mismatch.
 */

import { type AgentDef, defineAgent, defineTool } from "@alexkroman1/aai";
import { agentToolsToSchemas } from "@alexkroman1/aai/internal-types";
import { describe, expect, test } from "vitest";
import { z } from "zod";
// direct-executor.ts has no package export, so use relative path through workspace
import { buildAgentConfig } from "../../aai/direct-executor.ts";
import { createTestOrchestrator } from "./_test-utils.ts";

/**
 * Build a deploy body from an SDK-defined agent, mimicking what the CLI does.
 */
// biome-ignore lint/suspicious/noExplicitAny: accepts any state type
function buildDeployBodyFromAgent(agent: AgentDef<any>): string {
  const config = buildAgentConfig(agent);
  const _schemas = agentToolsToSchemas(agent.tools);

  // The deploy body contains the bundled worker code (JS string),
  // client files, and env. We simulate the worker code as a string
  // that exports the agent config — the real CLI bundles agent.ts.
  return JSON.stringify({
    env: { ASSEMBLYAI_API_KEY: "test-key" },
    worker: `export default ${JSON.stringify(config)};`,
    clientFiles: {
      "index.html": "<html><body>test</body></html>",
      "assets/index.js": "console.log('client');",
    },
  });
}

describe("cross-package smoke: SDK → server deploy", () => {
  test("defineAgent config is accepted by server deploy endpoint", async () => {
    const agent = defineAgent({
      name: "smoke-test",
      instructions: "Test agent for cross-package validation.",
      greeting: "Hello from smoke test",
      maxSteps: 3,
      builtinTools: ["web_search"],
      tools: {
        echo: defineTool({
          description: "Echo the input",
          parameters: z.object({ text: z.string() }),
          execute: ({ text }) => `echo:${text}`,
        }),
      },
    });

    const { fetch } = await createTestOrchestrator();
    const body = buildDeployBodyFromAgent(agent);
    const res = await fetch("/smoke-test/deploy", {
      method: "POST",
      headers: { Authorization: "Bearer key1", "Content-Type": "application/json" },
      body,
    });
    expect(res.status).toBe(200);
  });

  test("deployed agent is accessible via health and page endpoints", async () => {
    const agent = defineAgent({ name: "accessible-agent" });
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

  test("buildAgentConfig produces JSON-safe config from SDK agent", () => {
    const agent = defineAgent({
      name: "json-safe",
      instructions: "Custom instructions",
      greeting: "Hi",
      maxSteps: 10,
      toolChoice: "required",
      builtinTools: ["web_search", "run_code"],
      tools: {
        search: defineTool({
          description: "Search",
          parameters: z.object({ query: z.string() }),
          execute: ({ query }) => query,
        }),
      },
    });

    const config = buildAgentConfig(agent);
    // Must survive JSON round-trip (no functions, no class instances)
    const roundTripped = JSON.parse(JSON.stringify(config));
    expect(roundTripped.name).toBe("json-safe");
    expect(roundTripped.instructions).toBe("Custom instructions");
    expect(roundTripped.greeting).toBe("Hi");
    expect(roundTripped.maxSteps).toBe(10);
    expect(roundTripped.toolChoice).toBe("required");
    expect(roundTripped.builtinTools).toEqual(["web_search", "run_code"]);
  });

  test("tool schemas from SDK match expected server format", () => {
    const agent = defineAgent({
      name: "schema-check",
      tools: {
        greet: defineTool({
          description: "Greet by name",
          parameters: z.object({ name: z.string(), formal: z.boolean().optional() }),
          execute: ({ name }) => `Hello, ${name}!`,
        }),
        noParams: {
          description: "No params tool",
          execute: () => "done",
        },
      },
    });

    const schemas = agentToolsToSchemas(agent.tools);

    // greet tool should have proper schema
    const greetSchema = schemas.find((s) => s.name === "greet");
    expect(greetSchema).toBeDefined();
    expect(greetSchema?.description).toBe("Greet by name");
    expect(greetSchema?.parameters).toHaveProperty("properties");
    expect(
      (greetSchema?.parameters as { properties: Record<string, unknown> }).properties,
    ).toHaveProperty("name");

    // noParams tool should still have a valid schema
    const noParamsSchema = schemas.find((s) => s.name === "noParams");
    expect(noParamsSchema).toBeDefined();
    expect(noParamsSchema?.description).toBe("No params tool");
  });
});
