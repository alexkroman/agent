// Copyright 2026 the AAI authors. MIT license.
// IsolateConfigSchema refinement specs — the wire-format mirror of the
// toAgentConfig validations (one source of truth in
// @alexkroman1/aai/manifest, two enforcement points).

import type { AgentConfig } from "@alexkroman1/aai/manifest";
import { describe, expect, expectTypeOf, test } from "vitest";
import { type IsolateConfig, IsolateConfigSchema } from "./rpc-schemas.ts";

// ── Config pass-through guard ─────────────────────────────────────────────
// The wire schema is derived from the canonical AgentConfigSchema, so the
// only way a field can go missing on the wire is this subtraction growing.
// (The server no longer maps configs onto a runtime agent — the bundle runs
// its own SDK — so the old toRuntimeAgent deny-list guard is gone with it.)

test("IsolateConfig carries every canonical AgentConfig field", () => {
  expectTypeOf<Exclude<keyof AgentConfig, keyof IsolateConfig>>().toEqualTypeOf<never>();
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

  test("deadAirCoverMs is valid with a complete pipeline triple", () => {
    const result = IsolateConfigSchema.safeParse({
      name: "x",
      ...pipelineFields,
      tts: { kind: "cartesia", options: { voice: "v" } },
      deadAirCoverMs: 2500,
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
