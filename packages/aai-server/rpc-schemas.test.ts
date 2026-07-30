// Copyright 2026 the AAI authors. MIT license.
// IsolateConfigSchema refinement specs — the wire-format mirror of the
// parseManifest/toAgentConfig validations (one source of truth in
// @alexkroman1/aai/manifest, three enforcement points).

import { describe, expect, test } from "vitest";
import { IsolateConfigSchema } from "./rpc-schemas.ts";

const pipelineFields = {
  stt: { kind: "assemblyai", options: { model: "u3pro-rt" } },
  llm: { kind: "anthropic", options: { model: "claude-haiku-4-5" } },
};

describe("IsolateConfigSchema — provider triple", () => {
  test("rejects an incomplete triple", () => {
    const result = IsolateConfigSchema.safeParse({ name: "x", ...pipelineFields });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toMatch(/stt, llm, and tts must be set together/);
  });

  test("holdPhrase is valid with a complete pipeline triple", () => {
    const result = IsolateConfigSchema.safeParse({
      name: "x",
      ...pipelineFields,
      tts: { kind: "cartesia", options: { voice: "v" } },
      holdPhrase: "One sec.",
    });
    expect(result.success).toBe(true);
  });
});

describe("IsolateConfigSchema — removed transport field", () => {
  test("strips a legacy transport field from an older stored config", () => {
    // Configs deployed before the per-agent client transport was removed
    // still carry `transport` in storage; the schema must ignore it rather
    // than reject the whole agent.
    const result = IsolateConfigSchema.safeParse({ name: "x", transport: "sync" });
    expect(result.success).toBe(true);
    expect(result.data).not.toHaveProperty("transport");
  });
});

// `allowedHosts` decides a deployed agent's guest egress and arrives from a
// tenant's bundle, so the platform re-runs the SDK's pattern rules rather than
// trusting that the CLI did. The SSRF guard screens each request on top; these
// keep a hostile pattern from being *stored* in the first place.
describe("IsolateConfigSchema — allowedHosts", () => {
  const parse = (allowedHosts: string[]) =>
    IsolateConfigSchema.safeParse({ name: "x", allowedHosts });

  test("defaults to an empty list when omitted", () => {
    const result = IsolateConfigSchema.safeParse({ name: "x" });
    expect(result.data?.allowedHosts).toEqual([]);
  });

  test.each([["api.example.com"], ["*.example.com"], ["api.other.com"]])("accepts %s", (host) => {
    expect(parse([host]).success).toBe(true);
  });

  test.each([
    ["https://api.example.com", /must not include a protocol/],
    ["api.example.com/admin", /must not include a path/],
    ["api.example.com:8080", /must not include a port/],
    ["*", /Bare wildcard/],
    ["169.254.169.254", /IP address literals are not allowed/],
    ["metadata.internal", /private\/special-use TLD/],
  ])("rejects %s", (host, message) => {
    const result = parse([host]);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toMatch(message);
  });

  test("names the offending pattern when one entry of many is bad", () => {
    const result = parse(["api.example.com", "*", "other.example.com"]);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain('"*"');
  });
});
