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
 *
 * **The telephony half is here for the same reason and warns for a different
 * failure.** A declared carrier's signing secret being absent does not stop the
 * agent — it serves that carrier's webhook with verification OFF — so it is a
 * silent outcome rather than a loud one, which is exactly why nothing else was
 * going to report it. `telephonyWebhooks` sits beside it because both readers
 * need the same declaration and this module is already where the normalized
 * config is unpacked.
 */

import type { TelephonyAccess, TelephonyCarrier } from "@alexkroman1/aai";
import { TELEPHONY_CARRIERS } from "@alexkroman1/aai/internal";
import { plural } from "@alexkroman1/aai/utils";
import { CARRIER_PARAM, requiredProviderEnvVars, TELEPHONY_PATH } from "@alexkroman1/aai-runtime";

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
  /**
   * `AgentDef.telephony`, for {@link missingTelephonySecrets} and
   * {@link telephonyWebhooks}. Serializable like `page` is, so it survives the
   * trip through `__aaiConfig` — see `packages/aai/src/sdk/telephony-config.ts`.
   */
  telephony?: TelephonyAccess | undefined;
};

/**
 * Every env var name the agent needs to start: provider credentials derived
 * from the stt/llm/tts/s2s descriptors (the same registry-backed derivation the
 * runtime resolves keys with), plus the agent's own declared `requiredEnv` — an
 * `agent()` field for custom keys tools read from `ctx.env`, which no static
 * derivation can see.
 *
 * **Named on its own because the CLI has TWO deploy paths and only one of them
 * used to ask.** `missingDeployEnv` (`build.ts`, the `--target` hosts) derived
 * its list from `.env.example` alone, so an agent declaring
 * `requiredEnv: ["ORDERS_API_KEY"]` and no example entry got neither a warning
 * nor an `env add` step for it — while the managed path below saw both sources.
 * One derivation, two callers; each applies its own "what counts as supplied".
 */
export function requiredEnvNames(config: PreflightConfig): string[] {
  return [...new Set([...requiredProviderEnvVars(config), ...(config.requiredEnv ?? [])])];
}

/**
 * Env var names the agent needs that the env being uploaded doesn't supply.
 * Empty values count as missing — an empty credential authenticates nothing.
 */
export function missingCredentials(config: PreflightConfig, env: Record<string, string>): string[] {
  return requiredEnvNames(config).filter((name) => !env[name]);
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

/**
 * The webhook-signing secret each carrier's requests are verified with —
 * `phone-signature.ts`'s `TWILIO_AUTH_TOKEN_SECRET` / `TELNYX_PUBLIC_KEY_SECRET`
 * from the reading end.
 *
 * Copied rather than imported: those constants live in `aai-server`, which the
 * CLI may never import (see "Dependency flow" in `AGENTS.md`). `satisfies` is
 * what keeps the copy total — a carrier added to `TELEPHONY_CARRIERS` with no
 * secret named here fails this package's build rather than deploying a phone
 * number nothing warns about.
 */
export const CARRIER_SIGNING_SECRETS = {
  twilio: "TWILIO_AUTH_TOKEN",
  telnyx: "TELNYX_PUBLIC_KEY",
} as const satisfies Record<TelephonyCarrier, string>;

/**
 * The carriers a declaration admits, in `TELEPHONY_CARRIERS` order.
 *
 * The same resolution the runtime's `enabledCarriers` performs — `false`, `[]`
 * and an absent field all mean the route is not served, `true` means every
 * carrier this build ships a codec for, and a name this build does not know is
 * DROPPED. It is re-derived here only because that function is `@internal` to
 * `aai-runtime` and reaches no published subpath; keep the two in step.
 */
export function declaredCarriers(config: PreflightConfig): TelephonyCarrier[] {
  const access = config.telephony;
  if (access === undefined || access === false) return [];
  if (access === true) return [...TELEPHONY_CARRIERS];
  const asked = new Set<string>(access);
  return TELEPHONY_CARRIERS.filter((name) => asked.has(name));
}

/**
 * Declared carriers whose signing secret the env being uploaded doesn't
 * supply — the phone half of {@link missingCredentials}, and a separate
 * function because the failure is a separate one.
 *
 * A missing provider key stops the agent starting; a missing signing secret
 * lets it start and serve a phone number with **verification off**. Signature
 * checking is enabled BY PRESENCE (`phone-signature.ts`), so the absence is
 * silent at every layer: the deploy succeeds, the call connects, and nothing
 * anywhere says the webhook is unauthenticated. That is the one thing about a
 * declared carrier the CLI knows and the platform cannot — the platform stores
 * no agent config — so it is said here or nowhere.
 *
 * Empty values count as missing for the reason they do above, and for one more:
 * `verifyPhoneWebhook` reads the stored value, and a blank secret is a check
 * that cannot pass rather than one that is off.
 */
export function missingTelephonySecrets(
  config: PreflightConfig,
  env: Record<string, string>,
): { carrier: TelephonyCarrier; secret: string }[] {
  return declaredCarriers(config)
    .map((carrier) => ({ carrier, secret: CARRIER_SIGNING_SECRETS[carrier] }))
    .filter(({ secret }) => !env[secret]);
}

/** One line per carrier whose signing secret is absent. */
export function missingTelephonySecretWarnings(
  missing: readonly { carrier: TelephonyCarrier; secret: string }[],
): string[] {
  return missing.map(
    ({ carrier, secret }) =>
      `telephony declares ${carrier} but ${secret} is not set — the ${carrier} webhook ` +
      "will be served with signature verification OFF, so anyone who knows the URL can " +
      `start a call. Declare ${secret} in .env and redeploy ` +
      "(already set on the platform with `aai secret put`? then this is already handled).",
  );
}

/**
 * The webhook URL to paste into each declared carrier's phone-number
 * configuration, `?carrier=` already filled in.
 *
 * Printed because both halves are things a user is otherwise asked to
 * reconstruct by hand, and getting either wrong produces a failure that names
 * neither: the platform's phone route defaults `carrier` to `"twilio"` against
 * a hardcoded set and never consults the agent's declaration, so a Telnyx
 * number reached without the query parameter is verified against Twilio's
 * scheme and answers `403 Invalid webhook signature`. The parameter cannot be
 * inferred server-side — `BundleStore` deliberately holds no agent config — and
 * it does not have to be, because the declaration is in hand right here.
 *
 * The path and the parameter name come from `aai-runtime`'s own constants
 * rather than from string literals, so a route rename cannot leave this
 * printing a URL that 404s.
 */
export function telephonyWebhooks(
  config: PreflightConfig,
  agentUrl: string,
): { carrier: TelephonyCarrier; url: string }[] {
  return declaredCarriers(config).map((carrier) => ({
    carrier,
    url: `${agentUrl}${TELEPHONY_PATH}?${CARRIER_PARAM}=${carrier}`,
  }));
}
