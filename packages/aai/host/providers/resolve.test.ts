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
import { ANTHROPIC_KIND, type AnthropicProvider } from "../../sdk/providers/llm/anthropic.ts";
import { GOOGLE_KIND, type GoogleProvider } from "../../sdk/providers/llm/google.ts";
import { GROQ_KIND, type GroqProvider } from "../../sdk/providers/llm/groq.ts";
import { MISTRAL_KIND, type MistralProvider } from "../../sdk/providers/llm/mistral.ts";
import { OPENAI_KIND, type OpenAIProvider } from "../../sdk/providers/llm/openai.ts";
import { XAI_KIND, type XaiProvider } from "../../sdk/providers/llm/xai.ts";
import type { LlmProvider } from "../../sdk/providers.ts";
import { resolveLlm } from "./resolve.ts";

type ProviderCase = {
  kind: string;
  provider: LlmProvider;
  envVar: string;
  label: string;
};

const cases: ProviderCase[] = [
  {
    kind: ANTHROPIC_KIND,
    provider: { kind: ANTHROPIC_KIND, options: { model: "claude-haiku-4-5" } } as AnthropicProvider,
    envVar: "ANTHROPIC_API_KEY",
    label: "Anthropic",
  },
  {
    kind: OPENAI_KIND,
    provider: { kind: OPENAI_KIND, options: { model: "gpt-4o" } } as OpenAIProvider,
    envVar: "OPENAI_API_KEY",
    label: "OpenAI",
  },
  {
    kind: GOOGLE_KIND,
    provider: { kind: GOOGLE_KIND, options: { model: "gemini-2.0-flash" } } as GoogleProvider,
    envVar: "GOOGLE_GENERATIVE_AI_API_KEY",
    label: "Google",
  },
  {
    kind: MISTRAL_KIND,
    provider: {
      kind: MISTRAL_KIND,
      options: { model: "mistral-large-latest" },
    } as MistralProvider,
    envVar: "MISTRAL_API_KEY",
    label: "Mistral",
  },
  {
    kind: XAI_KIND,
    provider: { kind: XAI_KIND, options: { model: "grok-2-1212" } } as XaiProvider,
    envVar: "XAI_API_KEY",
    label: "xAI",
  },
  {
    kind: GROQ_KIND,
    provider: { kind: GROQ_KIND, options: { model: "llama-3.3-70b-versatile" } } as GroqProvider,
    envVar: "GROQ_API_KEY",
    label: "Groq",
  },
];

describe("resolveLlm", () => {
  for (const tc of cases) {
    describe(tc.label, () => {
      it("returns a LanguageModel when the API key is present", () => {
        const model = resolveLlm(tc.provider, { [tc.envVar]: "fake-key" });
        // Vercel AI SDK LanguageModels are objects with a
        // `specificationVersion` property; this is the cheapest stable
        // handle to confirm resolve dispatched to the right factory and
        // returned a real model.
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
    const bogus = { kind: "claude-direct", options: {} } as LlmProvider;
    expect(() => resolveLlm(bogus, {})).toThrow(/Unknown LLM provider kind: "claude-direct"/);
    expect(() => resolveLlm(bogus, {})).toThrow(/anthropic.*openai.*google.*mistral.*xai.*groq/);
  });
});

/** Temporarily delete a process.env var, returning a restore function. */
function stripEnv(name: string): () => void {
  const prev = process.env[name];
  delete process.env[name];
  return () => {
    if (prev !== undefined) process.env[name] = prev;
  };
}
