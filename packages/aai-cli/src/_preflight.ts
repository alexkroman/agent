// Copyright 2026 the AAI authors. MIT license.
/**
 * The deploy-time credential preflight — the classic dev/prod failure, caught
 * before the upload instead of at the deployed agent's first session.
 *
 * An agent that ran locally on shell-exported provider keys dies after deploy
 * with what looks like a provider outage: `aai dev` falls back to the shell
 * (`withHostCredentialFallback`), and the platform never will. Naming the key
 * here turns that into one line of output while the developer is still in the
 * directory that owns the `.env`.
 *
 * **This lives in the CLI because the agent's config does.** The platform
 * stores no description of a bundle and never evaluates one (see "The
 * platform stores no agent config" in packages/aai-server/CLAUDE.md), so the
 * only place that knows an agent needs `CARTESIA_API_KEY` is the process that
 * just built it.
 *
 * **It WARNS, and must not be turned into a hard failure.** The CLI sees the
 * env it is about to upload; it cannot see what is already stored against the
 * slug from an earlier `aai secret put`, so a key the platform holds looks
 * missing from here. The server-side check this replaced could see both and
 * so could reject — moving the config to where it is authored costs that
 * accuracy, and a false rejection is worse than a false warning: it blocks a
 * deploy that would have worked.
 */

import { plural } from "@alexkroman1/aai/utils";
import { requiredProviderEnvVars } from "@alexkroman1/aai-runtime";

/**
 * The config shape read out of a bundle's `__aaiConfig` export: the provider
 * descriptors the credential derivation needs, plus the agent's declared
 * `requiredEnv`. Deliberately structural rather than the SDK's `AgentConfig` —
 * the export comes from the USER's installed SDK, which may be older or newer
 * than this CLI's, so anything beyond these is not ours to assume.
 *
 * **The `__aaiConfig` export, not the bundle's default export.** They look
 * interchangeable — `evalWorkerBundle` already returns the `AgentDef`, and
 * `agentEnvWarnings` (`_dev-server.ts`) derives the same key set from one —
 * but `__aaiConfig` is `toAgentConfig(def)`, which has run
 * `normalizeAgentConveniences` and `defaultProviders`. A def written with an
 * author shorthand (`llm: "gpt-5"`) still carries a STRING there, and
 * `descriptorKind` reads a string as no kind at all, so deriving from the raw
 * def silently omits that provider's key. The normalized config is what the
 * runtime will actually resolve against, so it is what the preflight checks.
 */
export type PreflightConfig = Parameters<typeof requiredProviderEnvVars>[0] & {
  requiredEnv?: readonly string[] | undefined;
};

/**
 * Env var names the agent needs that the env being uploaded doesn't supply.
 * Empty values count as missing — an empty credential authenticates nothing.
 *
 * Two sources: provider credentials derived from the stt/llm/tts/s2s
 * descriptors (the same registry-backed derivation the runtime resolves keys
 * with), and the agent's own declared `requiredEnv` — an `agent()` field for
 * custom keys tools read from `ctx.env`, which no static derivation can see.
 */
export function missingCredentials(config: PreflightConfig, env: Record<string, string>): string[] {
  const required = new Set([...requiredProviderEnvVars(config), ...(config.requiredEnv ?? [])]);
  return [...required].filter((name) => !env[name]);
}

/** One line naming the missing keys and what to do about them. */
export function missingCredentialMessage(missing: string[]): string {
  return (
    `Missing ${plural(missing.length, "credential")} the agent needs to start: ` +
    `${missing.join(", ")}. ` +
    `Declare ${plural(missing.length, "it", "them")} in .env and redeploy ` +
    "(already set on the platform with `aai secret put`? then this is already handled)."
  );
}
