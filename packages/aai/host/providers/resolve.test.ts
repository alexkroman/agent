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
import { fetchMockJson } from "../../sdk/_test-utils.ts";
import { ANTHROPIC_KIND } from "../../sdk/providers/llm/anthropic.ts";
import { ASSEMBLYAI_LLM_KIND } from "../../sdk/providers/llm/assemblyai.ts";
import { GATEWAY_KIND } from "../../sdk/providers/llm/gateway.ts";
import { GOOGLE_KIND } from "../../sdk/providers/llm/google.ts";
import { GROQ_KIND } from "../../sdk/providers/llm/groq.ts";
import { MISTRAL_KIND } from "../../sdk/providers/llm/mistral.ts";
import { OPENAI_KIND } from "../../sdk/providers/llm/openai.ts";
import { XAI_KIND } from "../../sdk/providers/llm/xai.ts";
import type { LlmProvider, SttOpener } from "../../sdk/providers.ts";
import {
  registerLlmKind,
  registerSttKind,
  registerTtsKind,
  requiredProviderEnvVars,
  resolveLlm,
  resolveStt,
  resolveTts,
} from "./resolve.ts";

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

describe("requiredProviderEnvVars", () => {
  it("defaults to the AssemblyAI S2S key when no providers are declared", () => {
    expect(requiredProviderEnvVars({})).toEqual(["ASSEMBLYAI_API_KEY"]);
  });

  it("covers all three pipeline providers, including tts", () => {
    // The previous hardcoded check looked only at stt/llm and only for
    // AssemblyAI, so a Deepgram+Anthropic+Rime agent was told nothing.
    const vars = requiredProviderEnvVars({
      stt: { kind: "deepgram" },
      llm: { kind: "anthropic" },
      tts: { kind: "rime" },
    });
    expect([...vars].sort((a, b) => a.localeCompare(b))).toEqual([
      "ANTHROPIC_API_KEY",
      "DEEPGRAM_API_KEY",
      "RIME_API_KEY",
    ]);
  });

  it("does not require an S2S key once all three pipeline providers are set", () => {
    expect(
      requiredProviderEnvVars({
        stt: { kind: "deepgram" },
        llm: { kind: "anthropic" },
        tts: { kind: "rime" },
      }),
    ).not.toContain("ASSEMBLYAI_API_KEY");
  });

  it("selects the vendor key for an explicit S2S descriptor", () => {
    expect(requiredProviderEnvVars({ s2s: { kind: "openai-realtime" } })).toEqual([
      "OPENAI_API_KEY",
    ]);
  });

  it("deduplicates when one vendor serves several roles", () => {
    // AssemblyAI STT + AssemblyAI LLM gateway use different env vars; Cartesia
    // TTS with an AssemblyAI-keyed S2S default must not repeat a var.
    const vars = requiredProviderEnvVars({ stt: { kind: "assemblyai" } });
    expect(vars).toEqual([...new Set(vars)]);
    expect(vars).toContain("ASSEMBLYAI_API_KEY");
  });

  it("ignores a descriptor whose kind matches no registry entry", () => {
    // No invented credential, and no default-vendor fallback.
    expect(requiredProviderEnvVars({ stt: { kind: "not-a-provider" } })).toEqual([
      "ASSEMBLYAI_API_KEY",
    ]);
  });

  it("includes the send channel's credential env var", () => {
    expect(requiredProviderEnvVars({ send: { kind: "slack" } })).toEqual([
      "SLACK_WEBHOOK_URL",
      "ASSEMBLYAI_API_KEY",
    ]);
  });

  it("requires no TTS credential for a text-only agent (tts: none())", () => {
    // The `none` kind is deliberately absent from TTS_REGISTRY, and the
    // descriptor still counts toward the pipeline triple — so no TTS key and
    // no S2S fallback key either.
    const vars = requiredProviderEnvVars({
      stt: { kind: "deepgram" },
      llm: { kind: "anthropic" },
      tts: { kind: "none" },
    });
    expect([...vars].sort((a, b) => a.localeCompare(b))).toEqual([
      "ANTHROPIC_API_KEY",
      "DEEPGRAM_API_KEY",
    ]);
  });
});

describe("registerSttKind / registerTtsKind / registerLlmKind", () => {
  it("makes a fake resolvable through the normal descriptor path, env var included", () => {
    const opener: SttOpener = { name: "spec", open: async () => ({}) as never };
    const unregister = registerSttKind("spec-stt", { envVar: "SPEC_STT_KEY", open: () => opener });
    try {
      const resolved = resolveStt({ kind: "spec-stt", options: {} });
      expect(resolved.opener).toBe(opener);
      // The env var travels with the opener, so no caller has to re-derive it.
      expect(resolved.envVar).toBe("SPEC_STT_KEY");
      expect(requiredProviderEnvVars({ stt: { kind: "spec-stt" } })).toContain("SPEC_STT_KEY");
    } finally {
      unregister();
    }
  });

  it("unregister restores the registry, so kinds do not leak between specs", () => {
    const unregister = registerTtsKind("spec-tts", {
      envVar: "SPEC_TTS_KEY",
      open: () => ({ name: "spec", open: async () => ({}) as never }),
    });
    expect(() => resolveTts({ kind: "spec-tts", options: {} })).not.toThrow();
    unregister();
    expect(() => resolveTts({ kind: "spec-tts", options: {} })).toThrow(
      /Unknown TTS provider kind: "spec-tts"/,
    );
  });

  it("unregister restores a shadowed built-in kind rather than deleting it", () => {
    const unregister = registerLlmKind(ANTHROPIC_KIND, {
      envVar: "SHADOW_KEY",
      label: "Shadow",
      create: () => "shadow-model" as never,
    });
    expect(resolveLlm({ kind: ANTHROPIC_KIND, options: { model: "m" } }, { SHADOW_KEY: "k" })).toBe(
      "shadow-model",
    );
    unregister();
    // The real Anthropic entry is back, not deleted.
    expect(requiredProviderEnvVars({ llm: { kind: ANTHROPIC_KIND } })).toContain(
      "ANTHROPIC_API_KEY",
    );
  });
});

describe("resolveStt — AssemblyAI transcribeClip capability", () => {
  it("posts the clip to the Sync API and returns the transcript text", async () => {
    const fetchFn = fetchMockJson({ text: "hello from sync", words: [] });
    const { opener } = resolveStt({ kind: "assemblyai", options: { model: "u3pro-rt" } });
    expect(opener.transcribeClip).toBeDefined();
    const text = await opener.transcribeClip?.(new Uint8Array([1, 0]), 16_000, {
      apiKey: "k",
      fetch: fetchFn,
    });
    expect(text).toBe("hello from sync");
    const [url, init] = fetchFn.mock.calls[0] ?? [];
    expect(String(url)).toContain("sync");
    // Hand-encoded multipart bytes, not a FormData — see the module doc on
    // `assemblyai-sync.ts` for why the body must carry no class identity.
    const body = Buffer.from(init?.body as Uint8Array).toString("latin1");
    expect(body).toContain('{"sample_rate":16000,"channels":1}');
  });

  it("routes the clip to the EU Sync endpoint when the descriptor sets region: 'eu'", async () => {
    const fetchFn = fetchMockJson({ text: "hallo", words: [] });
    const { opener } = resolveStt({ kind: "assemblyai", options: { region: "eu" } });
    await opener.transcribeClip?.(new Uint8Array([1, 0]), 16_000, { apiKey: "k", fetch: fetchFn });
    const [url] = fetchFn.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://sync.eu.assemblyai.com/transcribe");
  });

  it("defaults to the US Sync endpoint when the descriptor has no region", async () => {
    const fetchFn = fetchMockJson({ text: "hello", words: [] });
    const { opener } = resolveStt({ kind: "assemblyai", options: {} });
    await opener.transcribeClip?.(new Uint8Array([1, 0]), 16_000, { apiKey: "k", fetch: fetchFn });
    const [url] = fetchFn.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://sync.assemblyai.com/transcribe");
  });

  it("other STT kinds carry no clip capability", () => {
    expect(resolveStt({ kind: "deepgram", options: {} }).opener.transcribeClip).toBeUndefined();
  });
});

describe("resolveTts — Cartesia synthesizeClip capability", () => {
  it("posts the reply to the bytes endpoint with the descriptor's voice options", async () => {
    const pcm = new Uint8Array([1, 2, 3, 4]);
    const calls: [string, RequestInit][] = [];
    const fetchFn: typeof globalThis.fetch = async (input, init) => {
      calls.push([String(input), init as RequestInit]);
      return new Response(pcm.slice().buffer as ArrayBuffer, { status: 200 });
    };
    const { opener, envVar } = resolveTts({
      kind: "cartesia",
      options: { voice: "v-9", model: "sonic-3", language: "de" },
    });
    expect(envVar).toBe("CARTESIA_API_KEY");
    expect(opener.synthesizeClip).toBeDefined();
    const out = await opener.synthesizeClip?.("Guten Tag", {
      sampleRate: 24_000,
      apiKey: "ck",
      fetch: fetchFn,
    });
    expect([...(out ?? [])]).toEqual([...pcm]);
    const [url, init] = calls[0] as [string, RequestInit];
    expect(url).toContain("/tts/bytes");
    const body = JSON.parse(init.body as string);
    expect(body.voice).toEqual({ mode: "id", id: "v-9" });
    expect(body.model_id).toBe("sonic-3");
    expect(body.language).toBe("de");
    expect(body.output_format.sample_rate).toBe(24_000);
  });

  it("defaults the voice when the descriptor omits it", async () => {
    let sent: RequestInit | undefined;
    const fetchFn: typeof globalThis.fetch = async (_input, init) => {
      sent = init as RequestInit;
      return new Response(new ArrayBuffer(0), { status: 200 });
    };
    const { opener } = resolveTts({ kind: "cartesia", options: {} });
    await opener.synthesizeClip?.("hi", { sampleRate: 16_000, apiKey: "ck", fetch: fetchFn });
    const body = JSON.parse(sent?.body as string);
    expect(typeof body.voice.id).toBe("string");
    expect(body.voice.id.length).toBeGreaterThan(0);
  });

  it("other TTS kinds carry no clip capability", () => {
    expect(resolveTts({ kind: "rime", options: {} }).opener.synthesizeClip).toBeUndefined();
  });
});
