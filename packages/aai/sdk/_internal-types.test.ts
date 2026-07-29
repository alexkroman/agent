// Copyright 2025 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { AgentConfigSchema, agentToolsToSchemas, toAgentConfig } from "./_internal-types.ts";
import type { ToolDef } from "./types.ts";

test("agentToolsToSchemas - converts tool definitions to OpenAI schema", () => {
  const noop = async () => {
    /* no-op */
  };
  const tools: Record<string, ToolDef> = {
    get_weather: {
      description: "Get weather",
      parameters: z.object({ city: z.string().describe("City") }),
      execute: noop,
    },
    set_alarm: {
      description: "Set alarm",
      parameters: z.object({
        time: z.string(),
        label: z.string().optional(),
      }),
      execute: noop,
    },
  };
  const schemas = agentToolsToSchemas(tools);
  expect(schemas.length).toBe(2);
  expect(schemas[0]?.name).toBe("get_weather");
  expect(schemas[0]?.description).toBe("Get weather");
  expect(schemas[1]?.name).toBe("set_alarm");
});

describe("AgentConfigSchema", () => {
  const base = { name: "a", systemPrompt: "p", greeting: "g" };

  test("accepts minBargeInWords above 1", () => {
    expect(AgentConfigSchema.safeParse({ ...base, minBargeInWords: 5 }).success).toBe(true);
  });

  test("rejects minBargeInWords below 1", () => {
    expect(AgentConfigSchema.safeParse({ ...base, minBargeInWords: 0 }).success).toBe(false);
  });

  test.each(["s2s", "pipeline"] as const)("accepts mode: %s", (mode) => {
    expect(AgentConfigSchema.safeParse({ ...base, mode }).success).toBe(true);
  });

  test("rejects unknown mode", () => {
    expect(AgentConfigSchema.safeParse({ ...base, mode: "hybrid" }).success).toBe(false);
  });

  test.each(["websocket", "sync"] as const)("accepts transport: %s", (transport) => {
    expect(AgentConfigSchema.safeParse({ ...base, transport }).success).toBe(true);
  });

  test("rejects unknown transport", () => {
    expect(AgentConfigSchema.safeParse({ ...base, transport: "http" }).success).toBe(false);
  });

  test.each([["api.example.com"], ["*.example.com"], ["sub.domain.example.co.uk"]])(
    "accepts allowedHosts pattern %s",
    (host) => {
      expect(AgentConfigSchema.safeParse({ ...base, allowedHosts: [host] }).success).toBe(true);
    },
  );

  test.each([
    ["https://api.example.com"],
    ["api.example.com/path"],
    ["api.example.com:8080"],
    ["*"],
    ["*.foo.*.com"],
    ["10.0.0.1"],
    ["thing.internal"],
    [""],
  ])("rejects allowedHosts pattern %s", (host) => {
    expect(AgentConfigSchema.safeParse({ ...base, allowedHosts: [host] }).success).toBe(false);
  });
});

describe("toAgentConfig", () => {
  const base = { name: "a", systemPrompt: "p", greeting: "g" };
  const desc = (kind: string) => ({ kind, options: {} });

  test("omits every optional field that is unset (no undefined-valued keys)", () => {
    const config = toAgentConfig(base);
    expect(config).toEqual({ ...base, mode: "s2s" });
    // `toEqual` treats a present-but-undefined key as absent, so check key
    // presence explicitly — the config crosses a structured-clone/JSON
    // boundary where phantom keys are visible.
    expect(Object.keys(config).sort()).toEqual(["greeting", "mode", "name", "systemPrompt"]);
  });

  test("propagates every optional field in pipeline mode", () => {
    const src = {
      ...base,
      sttPrompt: "domain terms",
      maxSteps: 7,
      toolChoice: "required" as const,
      builtinTools: ["think"] as const,
      idleTimeoutMs: 1000,
      silenceTimeoutMs: 9000,
      silencePrompt: "nudge",
      minBargeInWords: 3,
      interruptionMinDurationMs: 250,
      endpointSettleMs: 800,
      completeSettleMs: 400,
      holdPhrase: "One sec.",
      falseInterruptionTimeoutMs: 1500,
      stt: desc("assemblyai"),
      llm: desc("anthropic"),
      tts: desc("cartesia"),
      kv: desc("memory"),
      vector: desc("in-memory"),
      send: desc("slack"),
      transport: "sync" as const,
      allowedHosts: ["api.example.com"],
    };
    expect(toAgentConfig(src)).toEqual({ ...src, mode: "pipeline" });
  });

  test("rejects transport: 'sync' without the pipeline triple", () => {
    expect(() => toAgentConfig({ ...base, transport: "sync" })).toThrow(
      /transport: "sync" requires pipeline mode/,
    );
  });

  test("accepts explicit transport: 'websocket' in s2s mode", () => {
    const config = toAgentConfig({ ...base, transport: "websocket" });
    expect(config.transport).toBe("websocket");
  });

  test("carries allowedHosts through to the deploy config", () => {
    // Without this the field cannot reach the platform at all: the deploy path
    // builds its config here, not through `parseManifest`, so a declared host
    // was silently dropped and guest tool code had no egress.
    const config = toAgentConfig({ ...base, allowedHosts: ["api.example.com", "*.example.org"] });
    expect(config.allowedHosts).toEqual(["api.example.com", "*.example.org"]);
  });

  test("copies allowedHosts rather than aliasing the caller's array", () => {
    const hosts = ["api.example.com"];
    const config = toAgentConfig({ ...base, allowedHosts: hosts });
    hosts.push("evil.example.com");
    expect(config.allowedHosts).toEqual(["api.example.com"]);
  });

  test("does not union the send channel's host (the platform derives that)", () => {
    // `resolveAgentAllowedHosts` on the server adds `hooks.slack.com` from the
    // validated descriptor. Deriving it here too would be a second place to
    // keep in sync, and this one a bundle could bypass.
    const config = toAgentConfig({ ...base, send: desc("slack") });
    expect("allowedHosts" in config).toBe(false);
  });

  test("propagates the s2s descriptor and keeps the pipeline triple absent", () => {
    const config = toAgentConfig({ ...base, s2s: desc("assemblyai") });
    expect(config.mode).toBe("s2s");
    expect(config.s2s).toEqual(desc("assemblyai"));
    expect("stt" in config).toBe(false);
    expect("llm" in config).toBe(false);
    expect("tts" in config).toBe(false);
  });
});
