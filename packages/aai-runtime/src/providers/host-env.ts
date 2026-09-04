// Copyright 2025 the AAI authors. MIT license.
/**
 * Self-hosted opt-in for shell-exported provider credentials.
 *
 * `resolveApiKey` reads only the agent's own env, so nothing a provider can
 * authenticate with is ever inherited implicitly from the host process. That
 * is the behavior the managed platform needs: its `process.env` may hold
 * platform-owned credentials under the same names a tenant descriptor would
 * resolve.
 *
 * Self-hosted runs (`aai dev`) have the opposite expectation — the host env
 * belongs to the same person as the agent, and exporting
 * `ANTHROPIC_API_KEY=… aai dev` should work without also writing it into
 * `.env`. Those callers apply this helper when building `env`, which makes the
 * trust decision explicit and auditable at one call site instead of buried in
 * the resolvers.
 */

import type { HostCredentialEnv } from "@alexkroman1/aai/host-internal";
import { ALL_PROVIDER_ENV_VARS } from "./resolve.ts";

/**
 * Every env var name a provider descriptor may resolve a credential from:
 * the registry-derived STT/TTS/LLM/S2S set.
 *
 * The registry array ITSELF, not a copy: it is already deduplicated, and it is
 * kept live across `registerSttKind`/`registerTtsKind`/`registerLlmKind` (see
 * {@link ALL_PROVIDER_ENV_VARS}). A copy taken at module load would have frozen
 * this allowlist at the built-in providers, so a registered kind's credential
 * could never be copied from the host environment.
 *
 * @internal
 */
export const PROVIDER_CREDENTIAL_ENVS: readonly string[] = ALL_PROVIDER_ENV_VARS;

/**
 * Return `env` with any missing provider credential filled in from
 * `hostEnv` (defaults to `process.env`).
 *
 * Values already present in `env` always win — an explicit `.env` entry or
 * `aai secret put` value is never overridden by the shell. Only names in
 * `PROVIDER_CREDENTIAL_ENVS` are copied, so unrelated host variables
 * never reach `ctx.env`. `process.env` is not mutated.
 *
 * The return type is the `HostCredentialEnv` brand — this is the one
 * function that mints it. The result satisfies `RuntimeOptions.providerEnv`
 * but not `RuntimeOptions.env`, so host credentials cannot silently become
 * `ctx.env` (see sdk/env-types.ts).
 */
export function withHostCredentialFallback(
  env: Record<string, string>,
  hostEnv: Record<string, string | undefined> = process.env,
): HostCredentialEnv {
  const merged: Record<string, string> = { ...env };
  for (const name of PROVIDER_CREDENTIAL_ENVS) {
    if (merged[name] !== undefined) continue;
    const value = hostEnv[name];
    if (value !== undefined && value !== "") merged[name] = value;
  }
  return merged as HostCredentialEnv;
}
