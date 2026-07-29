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
