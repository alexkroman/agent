// Copyright 2026 the AAI authors. MIT license.
/**
 * Unit tests for `resolveLlm` — exercises kind dispatch, API-key error
 * paths, and unknown-kind error surface.
 *
 * Happy-path tests build a real `LanguageModel` against the actual
 * `@ai-sdk/*` packages (installed as devDependencies in this workspace).
 * They never call `streamText`, so no network traffic is generated.
 */

import type {
  SttOpener,
  SttSession,
  TtsSession,
  Unsubscribe,
} from "@alexkroman1/aai/host-internal";
import {
  ANTHROPIC_KIND,
  ASSEMBLYAI_LLM_KIND,
  ASSEMBLYAI_S2S_KIND,
  GATEWAY_KIND,
  GOOGLE_KIND,
  GROQ_KIND,
  MISTRAL_KIND,
  OPENAI_KIND,
  OPENAI_S2S_KIND,
  OPENROUTER_KIND,
  XAI_KIND,
} from "@alexkroman1/aai/host-internal";
import type { LlmProvider } from "@alexkroman1/aai/llm";
import { ASSEMBLYAI_LLM_DEFAULT_MODEL } from "@alexkroman1/aai/llm";
import { omitUndefined } from "@alexkroman1/aai/utils";
import { describe, expect, it, vi } from "vitest";
import { PROVIDER_CREDENTIAL_ENVS } from "./host-env.ts";
import {
  ALL_PROVIDER_ENV_VARS,
  registerLlmKind,
  registerSttKind,
  registerTtsKind,
  requiredProviderEnvVars,
  resolveLlm,
  resolveS2sEnvVar,
  resolveStt,
  resolveTts,
} from "./resolve.ts";

type ProviderCase = {
  provider: LlmProvider;
  envVar: string;
  label: string;
  /**
   * The AI SDK's own provider id on the resolved model — the observable
   * handle on WHICH vendor client (and, where it matters, which of that
   * vendor's two APIs) the registry entry dispatched to.
   */
  sdkProvider: string;
  /** The descriptor's model id, as it must arrive at the client. */
  modelId: string;
};

const cases: ProviderCase[] = [
  {
    provider: { kind: ANTHROPIC_KIND, options: { model: "claude-haiku-4-5" } },
    envVar: "ANTHROPIC_API_KEY",
    label: "Anthropic",
    sdkProvider: "anthropic.messages",
    modelId: "claude-haiku-4-5",
  },
  {
    provider: { kind: OPENAI_KIND, options: { model: "gpt-4o" } },
    envVar: "OPENAI_API_KEY",
    label: "OpenAI",
    sdkProvider: "openai.responses",
    modelId: "gpt-4o",
  },
  {
    provider: { kind: GOOGLE_KIND, options: { model: "gemini-2.0-flash" } },
    envVar: "GOOGLE_GENERATIVE_AI_API_KEY",
    label: "Google",
    sdkProvider: "google.generative-ai",
    modelId: "gemini-2.0-flash",
  },
  {
    provider: { kind: MISTRAL_KIND, options: { model: "mistral-large-latest" } },
    envVar: "MISTRAL_API_KEY",
    label: "Mistral",
    sdkProvider: "mistral.chat",
    modelId: "mistral-large-latest",
  },
  {
    provider: { kind: XAI_KIND, options: { model: "grok-2-1212" } },
    envVar: "XAI_API_KEY",
    label: "xAI",
    sdkProvider: "xai.responses",
    modelId: "grok-2-1212",
  },
  {
    provider: { kind: GROQ_KIND, options: { model: "llama-3.3-70b-versatile" } },
    envVar: "GROQ_API_KEY",
    label: "Groq",
    sdkProvider: "groq.chat",
    modelId: "llama-3.3-70b-versatile",
  },
  {
    provider: { kind: ASSEMBLYAI_LLM_KIND, options: { model: "claude-sonnet-4-6" } },
    envVar: "ASSEMBLYAI_API_KEY",
    label: "AssemblyAI",
    sdkProvider: "assemblyai.chat",
    modelId: "claude-sonnet-4-6",
  },
  {
    provider: { kind: OPENROUTER_KIND, options: { model: "meta-llama/llama-3.3-70b-instruct" } },
    envVar: "OPENROUTER_API_KEY",
    label: "OpenRouter",
    sdkProvider: "openrouter.chat",
    modelId: "meta-llama/llama-3.3-70b-instruct",
  },
  {
    provider: { kind: GATEWAY_KIND, options: { model: "zai/glm-4.6" } },
    envVar: "AI_GATEWAY_API_KEY",
    label: "Vercel AI Gateway",
    sdkProvider: "gateway",
    modelId: "zai/glm-4.6",
  },
];

/**
 * Minimal REAL provider sessions for the registry fakes below.
 *
 * These four call sites used to launder `{}` and a bare string through the
 * `never` type — the dominant type-laundering idiom in this repo's tests, and
 * strictly worse than the casts the escape-hatch ratchet already counts:
 * `never` is assignable to every parameter position, AND it stops reporting
 * when a field is ADDED to the interface it stands in for. That is what a
 * shared, typed builder prevents — adding a member to `SttSession` is a
 * compile error HERE rather than a fake that silently stops resembling the
 * thing it doubles.
 */
const unsubscribe: Unsubscribe = () => undefined;

function stubSttSession(): SttSession {
  return {
    sendAudio: () => undefined,
    on: () => unsubscribe,
    close: async () => undefined,
  };
}

function stubTtsSession(): TtsSession {
  return {
    sendText: () => undefined,
    flush: () => undefined,
    cancel: () => undefined,
    on: () => unsubscribe,
    close: async () => undefined,
  };
}

describe("resolveLlm", () => {
  for (const tc of cases) {
    describe(tc.label, () => {
      it("dispatches to this vendor's client, carrying the descriptor's model id", () => {
        const model = resolveLlm(tc.provider, { [tc.envVar]: "fake-key" });
        // This used to assert only `toHaveProperty("specificationVersion")`,
        // which every AI SDK LanguageModel has — so swapping two registry
        // `create` entries, or dropping the `(model(d))` application so the
        // descriptor's model id never reached the client, passed for six of
        // the nine kinds. `provider` names the client that was built and
        // `modelId` proves the id got there.
        expect(model).toMatchObject({
          provider: tc.sdkProvider,
          modelId: tc.modelId,
          specificationVersion: expect.any(String),
        });
      });

      it("throws a friendly error when the API key is missing", () => {
        // No `vi.stubEnv` here on purpose: `resolveApiKey` reads the env
        // record it is HANDED and never `process.env`, so scrubbing the shell
        // var proved nothing and read as if a fallback existed.
        // `host-env.test.ts` owns that property centrally.
        expect(() => resolveLlm(tc.provider, {})).toThrowError(
          new RegExp(`${tc.label} LLM: missing API key\\. Set ${tc.envVar} in the agent env\\.`),
        );
      });
    });
  }

  it("throws a useful error for an unknown kind, listing supported kinds", () => {
    const bogus = { kind: "claude-direct", options: {} } as unknown as LlmProvider;
    expect(() => resolveLlm(bogus, {})).toThrow(/Unknown LLM provider kind: "claude-direct"/);
    expect(() => resolveLlm(bogus, {})).toThrow(
      /anthropic.*openai.*google.*mistral.*xai.*groq.*openrouter.*gateway.*assemblyai/,
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

  describe("OpenRouter", () => {
    it("resolves a creator/model id to a chat-completions model", () => {
      const model = resolveLlm(
        { kind: OPENROUTER_KIND, options: { model: "meta-llama/llama-3.3-70b-instruct" } },
        { OPENROUTER_API_KEY: "fake-key" },
      );
      // OpenRouter implements /chat/completions; the `.chat` suffix in the
      // provider id is the observable handle on that dispatch, and the full
      // "creator/model" string stays the model id (routing is service-side).
      expect(model).toMatchObject({
        provider: "openrouter.chat",
        modelId: "meta-llama/llama-3.3-70b-instruct",
      });
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

    it("defaults to qwen3-next-80b-a3b when the descriptor names no model", () => {
      const model = resolveLlm(
        { kind: ASSEMBLYAI_LLM_KIND, options: {} },
        { ASSEMBLYAI_API_KEY: "fake-key" },
      );
      expect(model).toMatchObject({ modelId: ASSEMBLYAI_LLM_DEFAULT_MODEL });
    });

    // `reasoningEffort` is forwarded as `reasoning_effort` only when the
    // descriptor sets it — unset, the model keeps its server-side reasoning
    // default. The assertion is on the actual request body — the wrapper
    // middleware only acts at call time, so a static shape check proves
    // nothing.
    async function requestBodyFor(
      options: Record<string, unknown>,
      tools?: readonly unknown[],
    ): Promise<string> {
      const model = resolveLlm(
        { kind: ASSEMBLYAI_LLM_KIND, options },
        { ASSEMBLYAI_API_KEY: "fake-key" },
      ) as unknown as { doGenerate: (opts: unknown) => Promise<unknown> };
      let body = "";
      const fakeFetch = async (_input: unknown, init?: { body?: unknown }): Promise<Response> => {
        body = String(init?.body ?? "");
        return new Response(
          JSON.stringify({
            id: "chatcmpl-1",
            object: "chat.completion",
            created: 0,
            model: "test",
            choices: [
              { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      };
      vi.stubGlobal("fetch", fakeFetch);
      try {
        await model.doGenerate({
          prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
          ...omitUndefined({ tools }),
        });
      } finally {
        vi.unstubAllGlobals();
      }
      return body;
    }

    // Note this goes through `resolveLlm` on a RAW descriptor, not through
    // `assemblyAILlm()` — so the factory's per-model reasoning default (see
    // TOOLS_REQUIRE_NO_REASONING) is not in play and the resolver's own
    // "unset means unset" rule is what is under test — it must hold whether or
    // not the current default model happens to carry a factory default.
    it("leaves reasoning on its server-side default when reasoningEffort is unset", async () => {
      const body = await requestBodyFor({ model: "gpt-5.5" });
      const parsed = JSON.parse(body) as Record<string, unknown>;
      expect(parsed).toMatchObject({ model: "gpt-5.5" });
      expect(parsed).not.toHaveProperty("reasoning_effort");
    });

    it("still defaults the model id for a descriptor that names none", async () => {
      const parsed = JSON.parse(await requestBodyFor({})) as Record<string, unknown>;
      expect(parsed).toMatchObject({ model: ASSEMBLYAI_LLM_DEFAULT_MODEL });
      // Raw descriptor, so the factory's per-model fill never ran: the
      // resolver defaults the id and nothing else, even though this id is in
      // TOOLS_REQUIRE_NO_REASONING. Every real path builds the descriptor
      // through `assemblyAILlm()`, which is where the `"none"` comes from.
      expect(parsed).not.toHaveProperty("reasoning_effort");
    });

    it('turns reasoning off when the descriptor sets reasoningEffort: "none"', async () => {
      const body = await requestBodyFor({ model: "gpt-5.5", reasoningEffort: "none" });
      expect(JSON.parse(body)).toMatchObject({ reasoning_effort: "none" });
    });

    // `gatewayToolSchemaMiddleware` is unit-tested next door; what this covers
    // is that it is WIRED — and unconditionally, on a descriptor that sets no
    // reasoningEffort, since the reasoning wrapper used to be the only wrapper
    // and returning the bare model when it was unset is the shape of the miss.
    // Asserted on the outgoing body because middleware only acts at call time.
    it("prunes unsupported tool-schema keywords from the outgoing request", async () => {
      const body = await requestBodyFor({ model: "gemini-2.5-flash" }, [
        {
          type: "function",
          name: "read_file",
          inputSchema: {
            $schema: "http://json-schema.org/draft-07/schema#",
            type: "object",
            properties: { args: { type: "object", propertyNames: { type: "string" } } },
          },
        },
      ]);
      expect(body).not.toContain("$schema");
      expect(body).not.toContain("propertyNames");
      // The tool itself still reaches the gateway — a prune that dropped the
      // declaration would "fix" the 500 by making the agent tool-less.
      expect(JSON.parse(body)).toMatchObject({
        tools: [{ function: { name: "read_file", parameters: { type: "object" } } }],
      });
    });
  });
});

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

  it.each([
    ["stt", { stt: { kind: "assemblyai", options: { apiKeyEnv: "STAGING_KEY" } } }],
    ["tts", { tts: { kind: "rime", options: { apiKeyEnv: "STAGING_KEY" } } }],
    ["llm", { llm: { kind: "anthropic", options: { apiKeyEnv: "STAGING_KEY" } } }],
  ] as const)("honours a %s descriptor's apiKeyEnv, as every resolver does", (_stage, agent) => {
    // The preflight has to ask for the key the SESSION will read. Reading only
    // `registry[kind].envVar` made it demand the registry default while
    // `resolveStt`/`resolveTts`/`resolveLlm` all read the override — so the
    // deploy was gated on a variable the agent does not use and never told the
    // author the one it does use is missing.
    expect(requiredProviderEnvVars(agent)).toContain("STAGING_KEY");
  });

  it("does not name the registry default alongside an apiKeyEnv override", () => {
    expect(
      requiredProviderEnvVars({
        stt: { kind: "assemblyai", options: { apiKeyEnv: "ASSEMBLYAI_STAGING_KEY" } },
        llm: { kind: "anthropic", options: { apiKeyEnv: "ANTHROPIC_STAGING_KEY" } },
        tts: { kind: "rime", options: { apiKeyEnv: "RIME_STAGING_KEY" } },
      }),
    ).toEqual(["ASSEMBLYAI_STAGING_KEY", "RIME_STAGING_KEY", "ANTHROPIC_STAGING_KEY"]);
  });

  it("names no key for an unrecognized S2S kind rather than falling back to AssemblyAI", () => {
    // The S2S branch used to be `kind === openai-realtime ? OPENAI : ASSEMBLYAI`,
    // so a third vendor's descriptor silently demanded ASSEMBLYAI_API_KEY — and
    // this list is what the deploy preflight rejects on, so the deploy failed
    // naming a key the agent does not use while never naming the one it does.
    expect(requiredProviderEnvVars({ s2s: { kind: "some-new-vendor" } })).toEqual([]);
  });

  it("names no key for a workflow app, which dials no provider", () => {
    // `page: "static"` declines /websocket and defaults telephony off, so
    // nothing opens a session — but with no providers declared this fell into
    // the default-pipeline branch and demanded ASSEMBLYAI_API_KEY, which
    // `aai dev` answers by hard-failing `not_logged_in`. Both workflow-app
    // templates ship exactly this shape.
    expect(requiredProviderEnvVars({ page: "static" })).toEqual([]);
  });

  it("names no key for a static agent carrying the INJECTED default triple", () => {
    // What the deploy preflight actually reads: `toAgentConfig` has already run
    // `defaultProviders`, so a static agent that declared nothing arrives
    // holding all three AssemblyAI descriptors. Keying off the descriptors alone
    // cannot tell that apart from an author who named them.
    expect(
      requiredProviderEnvVars({
        page: "static",
        stt: { kind: "assemblyai" },
        llm: { kind: "assemblyai" },
        tts: { kind: "assemblyai" },
      }),
    ).toEqual([]);
  });

  it('still requires the usual keys for an explicit `page: "voice"`', () => {
    // The default and the explicit value must mean the same thing — a voice
    // agent that spells its front door out loud is not a special case.
    expect(requiredProviderEnvVars({ page: "voice" })).toEqual(["ASSEMBLYAI_API_KEY"]);
  });

  it("honours a per-descriptor apiKeyEnv on an S2S descriptor", () => {
    // STT/TTS/LLM have supported this since per-stage credentials landed; S2S
    // resolved a hardcoded literal, so the override was silently ignored.
    expect(
      requiredProviderEnvVars({
        s2s: { kind: "assemblyai", options: { apiKeyEnv: "ASSEMBLYAI_STAGING_KEY" } },
      }),
    ).toEqual(["ASSEMBLYAI_STAGING_KEY"]);
  });
});

describe("resolveS2sEnvVar", () => {
  it("maps each S2S kind to its own vendor's credential", () => {
    expect(resolveS2sEnvVar({ kind: ASSEMBLYAI_S2S_KIND, options: {} })).toBe("ASSEMBLYAI_API_KEY");
    expect(resolveS2sEnvVar({ kind: OPENAI_S2S_KIND, options: {} })).toBe("OPENAI_API_KEY");
  });

  it("throws on an unknown kind, listing what is supported", () => {
    expect(() => resolveS2sEnvVar({ kind: "nope", options: {} })).toThrow(
      /Unknown S2S provider kind: "nope"\. Supported: assemblyai, openai-realtime\./,
    );
  });

  it("prefers a descriptor's apiKeyEnv over the registry default", () => {
    expect(
      resolveS2sEnvVar({ kind: ASSEMBLYAI_S2S_KIND, options: { apiKeyEnv: "OTHER_KEY" } }),
    ).toBe("OTHER_KEY");
  });
});

describe("ALL_PROVIDER_ENV_VARS", () => {
  it("covers every S2S vendor's credential", () => {
    // Derived from S2S_REGISTRY, so a new S2S provider widens the
    // withHostCredentialFallback allowlist without an edit here.
    expect(ALL_PROVIDER_ENV_VARS).toContain("ASSEMBLYAI_API_KEY");
    expect(ALL_PROVIDER_ENV_VARS).toContain("OPENAI_API_KEY");
  });

  it("has no duplicates", () => {
    expect(ALL_PROVIDER_ENV_VARS).toEqual([...new Set(ALL_PROVIDER_ENV_VARS)]);
  });

  it("is LIVE across registerSttKind, not a module-load snapshot", () => {
    // It was a snapshot, which put a registered kind's credential outside BOTH
    // allowlists at once: the host-mode handshake rejects an unlisted name by
    // name, and withHostCredentialFallback silently declines to copy it — so a
    // fake speech stage (or a host application's own provider) could not be
    // given a key at all.
    expect(ALL_PROVIDER_ENV_VARS).not.toContain("LATE_STT_KEY");
    const unregister = registerSttKind("late-stt", {
      envVar: "LATE_STT_KEY",
      open: () => ({ name: "late", open: async () => stubSttSession() }),
    });
    try {
      expect(ALL_PROVIDER_ENV_VARS).toContain("LATE_STT_KEY");
      // The same array object the two allowlists hold, so they move with it.
      expect(PROVIDER_CREDENTIAL_ENVS).toContain("LATE_STT_KEY");
    } finally {
      unregister();
    }
    expect(ALL_PROVIDER_ENV_VARS).not.toContain("LATE_STT_KEY");
  });
});

describe("registerSttKind / registerTtsKind / registerLlmKind", () => {
  it("makes a fake resolvable through the normal descriptor path, env var included", () => {
    const opener: SttOpener = { name: "spec", open: async () => stubSttSession() };
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
      open: () => ({ name: "spec", open: async () => stubTtsSession() }),
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
      create: () => "shadow-model",
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
