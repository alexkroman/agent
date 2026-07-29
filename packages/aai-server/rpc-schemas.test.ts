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

describe("IsolateConfigSchema — text-only (tts: none)", () => {
  test("accepts a text-only pipeline config", () => {
    const result = IsolateConfigSchema.safeParse({
      name: "x",
      ...pipelineFields,
      tts: { kind: "none", options: {} },
    });
    expect(result.success).toBe(true);
  });

  test("rejects holdPhrase alongside tts: none", () => {
    const result = IsolateConfigSchema.safeParse({
      name: "x",
      ...pipelineFields,
      tts: { kind: "none", options: {} },
      holdPhrase: "One sec.",
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toMatch(/holdPhrase requires a speaking TTS provider/);
  });

  test("still rejects an incomplete triple (none must be explicit)", () => {
    const result = IsolateConfigSchema.safeParse({ name: "x", ...pipelineFields });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toMatch(/stt, llm, and tts must be set together/);
  });

  test("holdPhrase stays valid with a speaking TTS provider", () => {
    const result = IsolateConfigSchema.safeParse({
      name: "x",
      ...pipelineFields,
      tts: { kind: "cartesia", options: { voice: "v" } },
      holdPhrase: "One sec.",
    });
    expect(result.success).toBe(true);
  });
});

describe("IsolateConfigSchema — client transport", () => {
  const triple = {
    ...pipelineFields,
    tts: { kind: "cartesia", options: { voice: "v" } },
  };

  test("accepts transport: 'sync' with the pipeline triple", () => {
    const result = IsolateConfigSchema.safeParse({ name: "x", ...triple, transport: "sync" });
    expect(result.success).toBe(true);
    expect(result.data?.transport).toBe("sync");
  });

  test("rejects transport: 'sync' without the triple (sync turns 409 on s2s)", () => {
    const result = IsolateConfigSchema.safeParse({ name: "x", transport: "sync" });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toMatch(/transport: "sync" requires pipeline mode/);
  });

  test("accepts explicit transport: 'websocket' on an s2s agent", () => {
    const result = IsolateConfigSchema.safeParse({ name: "x", transport: "websocket" });
    expect(result.success).toBe(true);
  });

  test("rejects unknown transport values", () => {
    const result = IsolateConfigSchema.safeParse({ name: "x", transport: "http" });
    expect(result.success).toBe(false);
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

  test.each([["api.example.com"], ["*.example.com"], ["hooks.slack.com"]])("accepts %s", (host) => {
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
