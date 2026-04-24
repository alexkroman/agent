// Copyright 2025 the AAI authors. MIT license.
/**
 * Descriptor → concrete-provider resolution (host-only).
 *
 * User code (and the server, after extracting config from a bundled agent)
 * holds `SttProvider` / `LlmProvider` / `TtsProvider` **descriptors** —
 * plain `{ kind, options }` data. At session start the runtime calls the
 * resolvers here to turn each descriptor into its openable / callable
 * host-side counterpart, importing the third-party SDK only at that point.
 *
 * The guest sandbox never imports these functions, which is how the agent
 * bundle stays free of `@ai-sdk/anthropic` / `assemblyai` /
 * `@cartesia/cartesia-js`.
 */

import { createAnthropic } from "@ai-sdk/anthropic";
import type { LanguageModel } from "ai";
import type { Kv } from "../../sdk/kv.ts";
import {
  CLOUDFLARE_KV_KIND,
  type CloudflareKvOptions,
} from "../../sdk/providers/kv/cloudflare-kv.ts";
import { MEMORY_KV_KIND, type MemoryKvOptions } from "../../sdk/providers/kv/memory.ts";
import {
  UNSTORAGE_KV_KIND,
  type UnstorageKvDescriptorOptions,
} from "../../sdk/providers/kv/unstorage.ts";
import { UPSTASH_KV_KIND, type UpstashKvOptions } from "../../sdk/providers/kv/upstash.ts";
import { VERCEL_KV_KIND, type VercelKvOptions } from "../../sdk/providers/kv/vercel-kv.ts";
import { ANTHROPIC_KIND, type AnthropicOptions } from "../../sdk/providers/llm/anthropic.ts";
import { ASSEMBLYAI_KIND, type AssemblyAIOptions } from "../../sdk/providers/stt/assemblyai.ts";
import { DEEPGRAM_KIND, type DeepgramOptions } from "../../sdk/providers/stt/deepgram.ts";
import { CARTESIA_KIND, type CartesiaOptions } from "../../sdk/providers/tts/cartesia.ts";
import { RIME_KIND, type RimeOptions } from "../../sdk/providers/tts/rime.ts";
import { PINECONE_KIND, type PineconeOptions } from "../../sdk/providers/vector/pinecone.ts";
import type {
  KvProvider,
  LlmProvider,
  SttOpener,
  SttProvider,
  TtsOpener,
  TtsProvider,
  VectorProvider,
} from "../../sdk/providers.ts";
import type { Vector } from "../../sdk/vector.ts";
import { resolveApiKey } from "./_api-key.ts";
import { openCloudflareKv } from "./kv/cloudflare-kv.ts";
import { openMemoryKv } from "./kv/memory.ts";
import { openUnstorageKv } from "./kv/unstorage.ts";
import { openUpstashKv } from "./kv/upstash.ts";
import { openVercelKv } from "./kv/vercel-kv.ts";
import { openAssemblyAI } from "./stt/assemblyai.ts";
import { openDeepgram } from "./stt/deepgram.ts";
import { openCartesia } from "./tts/cartesia.ts";
import { openRime } from "./tts/rime.ts";
import { openPineconeVector } from "./vector/pinecone.ts";

export { resolveApiKey } from "./_api-key.ts";

/** Resolve an {@link SttProvider} descriptor into a host-side opener. */
export function resolveStt(descriptor: SttProvider): SttOpener {
  switch (descriptor.kind) {
    case ASSEMBLYAI_KIND:
      return openAssemblyAI(descriptor.options as unknown as AssemblyAIOptions);
    case DEEPGRAM_KIND:
      return openDeepgram(descriptor.options as unknown as DeepgramOptions);
    default:
      throw new Error(
        `Unknown STT provider kind: "${descriptor.kind}". Supported: ${ASSEMBLYAI_KIND}, ${DEEPGRAM_KIND}.`,
      );
  }
}

/** Resolve a {@link TtsProvider} descriptor into a host-side opener. */
export function resolveTts(descriptor: TtsProvider): TtsOpener {
  switch (descriptor.kind) {
    case CARTESIA_KIND:
      return openCartesia(descriptor.options as unknown as CartesiaOptions);
    case RIME_KIND:
      return openRime(descriptor.options as unknown as RimeOptions);
    default:
      throw new Error(
        `Unknown TTS provider kind: "${descriptor.kind}". Supported: ${CARTESIA_KIND}, ${RIME_KIND}.`,
      );
  }
}

/**
 * Resolve an {@link LlmProvider} descriptor into a Vercel AI SDK
 * {@link LanguageModel}.
 *
 * The API key is pulled from the agent's env (e.g. `ANTHROPIC_API_KEY`).
 * Missing keys throw here — the pipeline session would fail on first
 * `streamText` call otherwise, and the error is clearer at construction.
 */
export function resolveLlm(descriptor: LlmProvider, env: Record<string, string>): LanguageModel {
  switch (descriptor.kind) {
    case ANTHROPIC_KIND: {
      const options = descriptor.options as unknown as AnthropicOptions;
      const apiKey = resolveApiKey("ANTHROPIC_API_KEY", env);
      if (!apiKey) {
        throw new Error("Anthropic LLM: missing API key. Set ANTHROPIC_API_KEY in the agent env.");
      }
      // Pass baseURL explicitly so the SDK's loadOptionalSetting returns
      // before reading process.env["ANTHROPIC_BASE_URL"]. Without this,
      // the Deno platform server needs --allow-env to start a session.
      return createAnthropic({ apiKey, baseURL: "https://api.anthropic.com/v1" })(options.model);
    }
    default:
      throw new Error(
        `Unknown LLM provider kind: "${descriptor.kind}". Supported: ${ANTHROPIC_KIND}.`,
      );
  }
}

/** Resolve a {@link KvProvider} descriptor into a host-side {@link Kv}. */
export function resolveKv(descriptor: KvProvider, env: Record<string, string>): Kv {
  switch (descriptor.kind) {
    case MEMORY_KV_KIND:
      return openMemoryKv(descriptor.options as unknown as MemoryKvOptions);
    case UPSTASH_KV_KIND:
      return openUpstashKv(descriptor.options as unknown as UpstashKvOptions, env);
    case VERCEL_KV_KIND:
      return openVercelKv(descriptor.options as unknown as VercelKvOptions, env);
    case CLOUDFLARE_KV_KIND:
      return openCloudflareKv(descriptor.options as unknown as CloudflareKvOptions, env);
    case UNSTORAGE_KV_KIND:
      return openUnstorageKv(descriptor.options as unknown as UnstorageKvDescriptorOptions);
    default:
      throw new Error(
        `Unknown KV provider kind: "${descriptor.kind}". Supported: ${MEMORY_KV_KIND}, ${UPSTASH_KV_KIND}, ${VERCEL_KV_KIND}, ${CLOUDFLARE_KV_KIND}, ${UNSTORAGE_KV_KIND}.`,
      );
  }
}

/** Resolve a {@link VectorProvider} descriptor into a host-side {@link Vector}. */
export function resolveVector(descriptor: VectorProvider, env: Record<string, string>): Vector {
  switch (descriptor.kind) {
    case PINECONE_KIND:
      return openPineconeVector(descriptor.options as unknown as PineconeOptions, env);
    default:
      throw new Error(
        `Unknown vector provider kind: "${descriptor.kind}". Supported: ${PINECONE_KIND}.`,
      );
  }
}

/**
 * Compute the set of hostnames a KV/vector descriptor will need to reach.
 *
 * Returned to the sandbox so the configured provider's URL is auto-added to
 * `allowedHosts` — without this the guest fetch proxy rejects the call.
 *
 * For descriptors whose URL is sourced from env, the host is resolved from
 * the agent env. Returns an empty array for in-memory or unknown kinds.
 */
export function providerAllowedHosts(
  descriptor: KvProvider | VectorProvider | undefined,
  env: Record<string, string>,
): string[] {
  if (!descriptor) return [];
  switch (descriptor.kind) {
    case MEMORY_KV_KIND:
      return [];
    case UPSTASH_KV_KIND: {
      const opts = descriptor.options as unknown as UpstashKvOptions;
      const url = opts.url ?? env.UPSTASH_REDIS_REST_URL;
      return url ? [hostFromUrl(url)] : [];
    }
    case VERCEL_KV_KIND: {
      const opts = descriptor.options as unknown as VercelKvOptions;
      const url = opts.url ?? env.KV_REST_API_URL;
      return url ? [hostFromUrl(url)] : [];
    }
    case CLOUDFLARE_KV_KIND:
      return ["api.cloudflare.com"];
    case UNSTORAGE_KV_KIND: {
      // Unknown driver — caller must add its host to allowedHosts manually.
      return [];
    }
    case PINECONE_KIND: {
      const opts = descriptor.options as unknown as PineconeOptions;
      // Pinecone control plane + index host (when supplied).
      const hosts = ["api.pinecone.io"];
      if (opts.indexHost) hosts.push(hostFromUrl(opts.indexHost));
      // Allow all data-plane subdomains; users can supply indexHost for tighter scoping.
      hosts.push("*.pinecone.io");
      return hosts;
    }
    default:
      return [];
  }
}

function hostFromUrl(raw: string): string {
  try {
    return new URL(raw).host;
  } catch {
    return raw;
  }
}
