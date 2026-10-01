// Copyright 2026 the AAI authors. MIT license.
/**
 * The hosts a LIVE eval's model requests go to — the one passthrough an
 * `evalNetwork` must allow without the author naming it.
 *
 * The providers reach their APIs through the global `fetch` (the AI SDK's
 * default, and `repairOpenAiStream`'s), which is exactly the `fetch` the eval
 * network replaces. So a network that refused everything unrouted would refuse
 * the model too, and every live case would fail on its first turn. A
 * downstream suite had hard-coded `/(^|\.)assemblyai\.com$/` for this, which is
 * right for the default gateway and wrong the day the agent names another
 * provider — and silently so, since the failure reads as the model's.
 *
 * Read off the DESCRIPTORS rather than guessed from the environment: a
 * descriptor's `baseUrl` wins, as it does in `_llm-registry.ts`; otherwise the
 * provider's own default endpoint. A kind this table does not know — a
 * scripted model registered by a test, the eval's own stub — contributes
 * nothing, which is right: it makes no request.
 *
 * What it cannot see: a model a TOOL picks per call (`ctx.generate({ llm })`,
 * a subagent on another provider) or a simulated caller on its own model.
 * Those are named in the network's `passthrough`.
 *
 * @module
 */

import { fallbackMembers, isFallbackDescriptor } from "@alexkroman1/aai/host-internal";
import type { LlmProvider } from "@alexkroman1/aai/llm";
import { isRecord } from "@alexkroman1/aai/utils";

/**
 * Each known provider's default API host — the endpoint `_llm-registry.ts`
 * builds its client against when the descriptor names no `baseUrl`. The
 * AssemblyAI gateway lists both regions: `region` is a provider option, and a
 * wrong guess here refuses the model rather than leaking anything.
 */
const DEFAULT_HOSTS: Readonly<Record<string, readonly string[]>> = {
  assemblyai: ["llm-gateway.assemblyai.com", "llm-gateway.eu.assemblyai.com"],
  anthropic: ["api.anthropic.com"],
  openai: ["api.openai.com"],
  google: ["generativelanguage.googleapis.com"],
  mistral: ["api.mistral.ai"],
  xai: ["api.x.ai"],
  groq: ["api.groq.com"],
  openrouter: ["openrouter.ai"],
  cerebras: ["api.cerebras.ai"],
  gateway: ["ai-gateway.vercel.sh"],
};

/** The host(s) one model descriptor's requests go to. */
function hostsOf(llm: LlmProvider | string | undefined): readonly string[] {
  // Absent or a bare model id: the AssemblyAI gateway, the SDK's default stage.
  if (llm === undefined || typeof llm === "string") return DEFAULT_HOSTS.assemblyai ?? [];
  // A fallback reaches every member's host — the secondary is dialled exactly
  // when the primary is not answering.
  if (isFallbackDescriptor(llm)) {
    return fallbackMembers(llm).flatMap((m) =>
      hostsOf({ kind: m.kind, options: { ...m.options, model: "" } }),
    );
  }
  const options: unknown = llm.options;
  const baseUrl = isRecord(options) ? options.baseUrl : undefined;
  if (typeof baseUrl === "string") {
    try {
      return [new URL(baseUrl).hostname];
    } catch {
      return [];
    }
  }
  return DEFAULT_HOSTS[llm.kind] ?? [];
}

/**
 * The hosts every model in `models` requests, deduplicated. An `undefined`
 * entry is the default stage, so pass the agent's own `llm` as it is.
 */
export function modelHosts(models: readonly (LlmProvider | string | undefined)[]): string[] {
  return [...new Set(models.flatMap(hostsOf))];
}
