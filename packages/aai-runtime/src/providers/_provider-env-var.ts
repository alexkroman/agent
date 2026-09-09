// Copyright 2026 the AAI authors. MIT license.
/**
 * Which VARIABLE a provider descriptor's credential lives in.
 *
 * Its own module because it is the one question three stages, the credential
 * preflight and the eval gates all ask, and because `resolve.ts` — where these
 * three used to sit — is at the repo's 500-line cap. Nothing here resolves a
 * provider or reads a key: it answers a NAME.
 */

import type { LlmProvider } from "@alexkroman1/aai/llm";
import { LLM_REGISTRY } from "./_llm-registry.ts";

/**
 * A descriptor's own credential env var, overriding the registry default.
 *
 * The registry maps ONE env var per provider kind, which is right until two
 * stages of the same vendor need different accounts. AssemblyAI's three
 * `*_API_KEY_ENV` constants are distinct names for the same string
 * (`ASSEMBLYAI_API_KEY`), so without this there is no way to run STT against a
 * staging cluster while the LLM gateway and TTS stay on production — and the
 * keys are strictly environment-scoped, measured: a production key is rejected
 * by the sandbox STT cluster (1008) and a staging key is rejected by production
 * STT and TTS. A mixed deployment therefore needs two credentials live at once.
 *
 * It names a VARIABLE, never a key, so the descriptor stays secret-free and
 * safe to serialize — the same property that keeps API keys out of deployed
 * configs. A non-string or empty value falls through to the registry default
 * rather than resolving to `""`.
 */
export function descriptorEnvVar(descriptor: object | undefined): string | undefined {
  // `bag`, not `options` — that name is an imported helper used throughout the
  // registries below, and shadowing it here reads as a call site of it.
  const bag = (descriptor as { options?: unknown } | undefined)?.options;
  const value = (bag as Record<string, unknown> | undefined)?.apiKeyEnv;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Which variable a descriptor's credential really lives in: its own
 * `apiKeyEnv` if it named one, otherwise the registry default.
 *
 * Spelled ONCE because it was spelled five times, and the fifth was written
 * only after the omission had shipped — `requiredProviderEnvVars` demanded
 * `ASSEMBLYAI_API_KEY` while the session resolved `ASSEMBLYAI_STAGING_KEY`, so
 * the preflight never reported the key it would actually read as absent. That
 * is the silently-wrong-key failure {@link S2S_REGISTRY}'s own doc says these
 * registries exist to prevent, and a sixth reader is a sixth chance at it.
 */
export function envVarOf(entry: { envVar: string }, descriptor: object | undefined): string {
  return descriptorEnvVar(descriptor) ?? entry.envVar;
}

/**
 * The variable an LLM descriptor's key is read from — the ONE credential a
 * TEXT agent resolves.
 *
 * Its own function rather than a call to {@link requiredProviderEnvVars},
 * because that one answers about a VOICE agent and its no-complete-pipeline
 * branch adds the default AssemblyAI key: asked about a text agent declaring
 * `anthropicLlm()`, it reports `ASSEMBLYAI_API_KEY` the agent will never read,
 * and an eval gate over that answer skips a suite this machine could run.
 */
export function llmProviderEnvVar(descriptor: LlmProvider): string {
  const entry = LLM_REGISTRY[descriptor.kind];
  return entry === undefined ? (descriptorEnvVar(descriptor) ?? "") : envVarOf(entry, descriptor);
}
