// Copyright 2026 the AAI authors. MIT license.
/**
 * Unit tests for `resolveLlm` — exercises kind dispatch, API-key error
 * paths, and unknown-kind error surface.
 *
 * Happy-path tests build a real `LanguageModel` against the actual
 * `@ai-sdk/*` packages (installed as devDependencies in this workspace).
 * They never call `streamText`, so no network traffic is generated.
 */

import { describe, expect, it } from "vitest";
import { ANTHROPIC_KIND } from "../../sdk/providers/llm/anthropic.ts";
import { ASSEMBLYAI_LLM_KIND } from "../../sdk/providers/llm/assemblyai.ts";
import { GATEWAY_KIND } from "../../sdk/providers/llm/gateway.ts";
import { GOOGLE_KIND } from "../../sdk/providers/llm/google.ts";
import { GROQ_KIND } from "../../sdk/providers/llm/groq.ts";
import { MISTRAL_KIND } from "../../sdk/providers/llm/mistral.ts";
import { OPENAI_KIND } from "../../sdk/providers/llm/openai.ts";
import { XAI_KIND } from "../../sdk/providers/llm/xai.ts";
import type { LlmProvider } from "../../sdk/providers.ts";
import { resolveLlm } from "./resolve.ts";

type ProviderCase = {
  provider: LlmProvider;
  envVar: string;
  label: string;
};

const cases: ProviderCase[] = [
  {
    provider: { kind: ANTHROPIC_KIND, options: { model: "claude-haiku-4-5" } },
    envVar: "ANTHROPIC_API_KEY",
    label: "Anthropic",
  },
  {
    provider: { kind: OPENAI_KIND, options: { model: "gpt-4o" } },
    envVar: "OPENAI_API_KEY",
    label: "OpenAI",
  },
  {
    provider: { kind: GOOGLE_KIND, options: { model: "gemini-2.0-flash" } },
    envVar: "GOOGLE_GENERATIVE_AI_API_KEY",
    label: "Google",
  },
  {
    provider: { kind: MISTRAL_KIND, options: { model: "mistral-large-latest" } },
    envVar: "MISTRAL_API_KEY",
    label: "Mistral",
  },
  {
    provider: { kind: XAI_KIND, options: { model: "grok-2-1212" } },
    envVar: "XAI_API_KEY",
    label: "xAI",
  },
  {
    provider: { kind: GROQ_KIND, options: { model: "llama-3.3-70b-versatile" } },
    envVar: "GROQ_API_KEY",
    label: "Groq",
  },
  {
    provider: { kind: ASSEMBLYAI_LLM_KIND, options: { model: "claude-sonnet-4-6" } },
    envVar: "ASSEMBLYAI_API_KEY",
    label: "AssemblyAI",
  },
  {
    provider: { kind: GATEWAY_KIND, options: { model: "zai/glm-4.6" } },
    envVar: "AI_GATEWAY_API_KEY",
    label: "Vercel AI Gateway",
  },
];

describe("resolveLlm", () => {
  for (const tc of cases) {
    describe(tc.label, () => {
      it("returns a LanguageModel when the API key is present", () => {
        const model = resolveLlm(tc.provider, { [tc.envVar]: "fake-key" });
        // `specificationVersion` is the cheapest stable handle on a Vercel AI SDK
        // LanguageModel — confirms resolve dispatched to the right factory.
        expect(model).toBeTypeOf("object");
        expect(model).toHaveProperty("specificationVersion");
      });

      it("throws a friendly error when the API key is missing", () => {
        const restore = stripEnv(tc.envVar);
        try {
          expect(() => resolveLlm(tc.provider, {})).toThrowError(
            new RegExp(`${tc.label} LLM: missing API key\\. Set ${tc.envVar} in the agent env\\.`),
          );
        } finally {
          restore();
        }
      });
    });
  }

  it("throws a useful error for an unknown kind, listing supported kinds", () => {
    const bogus = { kind: "claude-direct", options: {} } as unknown as LlmProvider;
    expect(() => resolveLlm(bogus, {})).toThrow(/Unknown LLM provider kind: "claude-direct"/);
    expect(() => resolveLlm(bogus, {})).toThrow(
      /anthropic.*openai.*google.*mistral.*xai.*groq.*gateway.*assemblyai/,
    );
  });

  describe("Vercel AI Gateway", () => {
    it("resolves a creator/model id to a gateway LanguageModel", () => {
      const model = resolveLlm(
        { kind: GATEWAY_KIND, options: { model: "zai/glm-4.6" } },
        { AI_GATEWAY_API_KEY: "fake-key" },
      );
      // The gateway keeps the full "creator/model" string as the model id
      // and dispatches routing service-side.
      expect(model).toMatchObject({ provider: "gateway", modelId: "zai/glm-4.6" });
    });
  });

  describe("AssemblyAI LLM Gateway", () => {
    it("resolves to a chat-completions model, not the Responses API default", () => {
      const model = resolveLlm(
        { kind: ASSEMBLYAI_LLM_KIND, options: { model: "claude-sonnet-4-6" } },
        { ASSEMBLYAI_API_KEY: "fake-key" },
      );
      // The gateway only implements /chat/completions; the `.chat` suffix in
      // the provider id is the observable handle on that dispatch.
      expect(model).toMatchObject({ provider: "assemblyai.chat", modelId: "claude-sonnet-4-6" });
    });

    it("accepts the eu region option", () => {
      const model = resolveLlm(
        { kind: ASSEMBLYAI_LLM_KIND, options: { model: "claude-sonnet-4-6", region: "eu" } },
        { ASSEMBLYAI_API_KEY: "fake-key" },
      );
      expect(model).toHaveProperty("specificationVersion");
    });
  });
});

function stripEnv(name: string): () => void {
  const prev = process.env[name];
  delete process.env[name];
  return () => {
    if (prev !== undefined) process.env[name] = prev;
  };
}
