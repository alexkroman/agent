// Copyright 2025 the AAI authors. MIT license.
/**
 * Cross-package smoke test.
 *
 * Verifies that the SDK's AgentDef + toAgentConfig output is accepted
 * by the server's deploy endpoint, and that tool schemas survive the
 * SDK → deploy body → server round trip without interface mismatch.
 */

import type { AgentDef } from "@alexkroman1/aai-core";
import { agentToolsToSchemas, toAgentConfig } from "@alexkroman1/aai-core/manifest";
import { resolveAllBuiltins } from "@alexkroman1/aai-core/runtime";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { createTestOrchestrator } from "./test-utils.ts";

/**
 * Build a deploy body from an SDK-defined agent, mimicking what the CLI does.
 */
// biome-ignore lint/suspicious/noExplicitAny: accepts any state type
function buildDeployBodyFromAgent(agent: AgentDef<any>): string {
  const config = toAgentConfig(agent);
  const toolSchemas = agentToolsToSchemas(agent.tools);

  const agentConfig = {
    ...config,
    toolSchemas,
    hooks: {
      onConnect: typeof agent.onConnect === "function",
      onDisconnect: typeof agent.onDisconnect === "function",
      onError: typeof agent.onError === "function",
      onUserTranscript: typeof agent.onUserTranscript === "function",
      maxStepsIsFn: typeof agent.maxSteps === "function",
    },
  };

  // The deploy body contains the bundled worker code (JS string),
  // client files, env, and pre-extracted agentConfig.
  return JSON.stringify({
    env: { ASSEMBLYAI_API_KEY: "test-key" },
    worker: `export default ${JSON.stringify(config)};`,
    clientFiles: {
      "index.html": "<html><body>test</body></html>",
      "assets/index.js": "console.log('client');",
    },
    agentConfig,
  });
}

describe("cross-package smoke: SDK → server deploy", () => {
  test("agent config is accepted by server deploy endpoint", async () => {
    const agent: AgentDef = {
      name: "smoke-test",
      systemPrompt: "Test agent for cross-package validation.",
      greeting: "Hello from smoke test",
      maxSteps: 3,
      builtinTools: ["web_search"],
      tools: {
        echo: {
          description: "Echo the input",
          parameters: z.object({ text: z.string() }),
          execute: ({ text }) => `echo:${text}`,
        },
      },
    };

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

  test("toAgentConfig produces JSON-safe config from SDK agent", () => {
    const agent: AgentDef = {
      name: "json-safe",
      systemPrompt: "Custom instructions",
      greeting: "Hi",
      maxSteps: 10,
      toolChoice: "required",
      builtinTools: ["web_search", "run_code"],
      tools: {
        search: {
          description: "Search",
          parameters: z.object({ query: z.string() }),
          execute: ({ query }) => query,
        },
      },
    };

    const config = toAgentConfig(agent);
    // Must survive JSON round-trip (no functions, no class instances)
    const roundTripped = JSON.parse(JSON.stringify(config));
    expect(roundTripped.name).toBe("json-safe");
    expect(roundTripped.systemPrompt).toBe("Custom instructions");
    expect(roundTripped.greeting).toBe("Hi");
    expect(roundTripped.maxSteps).toBe(10);
    expect(roundTripped.toolChoice).toBe("required");
    expect(roundTripped.builtinTools).toEqual(["web_search", "run_code"]);
  });

  test("builtin tool schemas are resolved for sandbox mode", () => {
    const builtinNames = ["web_search", "visit_webpage", "fetch_json", "run_code"] as const;
    const { schemas } = resolveAllBuiltins(builtinNames);

    expect(schemas).toHaveLength(4);
    expect(schemas.map((s) => s.name).sort()).toEqual([
      "fetch_json",
      "run_code",
      "visit_webpage",
      "web_search",
    ]);

    // Each schema must have the fields the S2S API expects
    for (const schema of schemas) {
      expect(schema.description).toBeTruthy();
      expect(schema.parameters).toBeDefined();
      expect(schema.parameters).toHaveProperty("type", "object");
    }
  });

  test("builtin tool guidance is generated for system prompt", () => {
    const { guidance } = resolveAllBuiltins(["run_code", "web_search"]);

    expect(guidance.length).toBe(2);
    // run_code guidance must tell the LLM to use the tool, not answer verbally
    const runCodeGuidance = guidance.find((g) => g.includes("run_code"));
    expect(runCodeGuidance).toBeDefined();
    expect(runCodeGuidance).toContain("MUST");
    expect(runCodeGuidance).toContain("JavaScript");
    // web_search guidance
    const searchGuidance = guidance.find((g) => g.includes("web_search"));
    expect(searchGuidance).toBeDefined();
  });

  test("tool schemas from SDK match expected server format", () => {
    const agent: AgentDef = {
      name: "schema-check",
      systemPrompt: "",
      greeting: "",
      maxSteps: 5,
      tools: {
        greet: {
          description: "Greet by name",
          parameters: z.object({ name: z.string(), formal: z.boolean().optional() }),
          execute: ({ name }) => `Hello, ${name}!`,
        },
        noParams: {
          description: "No params tool",
          execute: () => "done",
        },
      },
    };

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
