// Copyright 2026 the AAI authors. MIT license.
// IsolateConfigSchema refinement specs — the wire-format mirror of the
// parseManifest/toAgentConfig validations (one source of truth in
// @alexkroman1/aai/manifest, three enforcement points).

import type { AgentDef } from "@alexkroman1/aai";
import type { AgentConfig } from "@alexkroman1/aai/manifest";
import { describe, expect, expectTypeOf, test } from "vitest";
import { type IsolateConfig, IsolateConfigSchema } from "./rpc-schemas.ts";
import type { WireOnlyConfigField } from "./sandbox-agent-config.ts";

// ── Config pass-through guards ────────────────────────────────────────────
// The wire schema is derived from the canonical AgentConfigSchema and the
// runtime agent is the config minus a deny-list, so the only way a field can
// go missing is one of these two subtractions growing. See
// sandbox-agent-config.ts for the dropped-field bug family this guards.

test("IsolateConfig carries every canonical AgentConfig field", () => {
  expectTypeOf<Exclude<keyof AgentConfig, keyof IsolateConfig>>().toEqualTypeOf<never>();
});

test("every IsolateConfig field reaches the runtime agent or is wire-only", () => {
  type Dropped = Exclude<keyof IsolateConfig, keyof AgentDef | WireOnlyConfigField>;
  expectTypeOf<Dropped>().toEqualTypeOf<never>();
});

const pipelineFields = {
  stt: { kind: "assemblyai", options: { model: "universal-3-5-pro" } },
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
