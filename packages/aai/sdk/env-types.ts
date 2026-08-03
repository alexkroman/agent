// Copyright 2026 the AAI authors. MIT license.
/**
 * Branded env-record types encoding the credential-separation invariant:
 * **host/shell credentials must never become `ctx.env`**. The platform's own
 * `process.env` holds credentials under exactly the names a tenant
 * descriptor resolves — so an agent that supplied no credential of its own
 * could silently borrow the platform's — and both historical leak bugs were
 * an env record of the wrong provenance flowing somewhere assignable.
 *
 * The brand is deliberately *weak* in one direction and *strong* in the
 * other:
 *
 * - Any plain `Record<string, string>` is assignable to both {@link AgentEnv}
 *   and {@link ProviderEnv} — tests and callers keep constructing object
 *   literals, and nothing forces ceremony where provenance is obvious.
 * - A {@link HostCredentialEnv} (the *only* thing that carries host
 *   credentials, minted solely by `withHostCredentialFallback`) is
 *   assignable to {@link ProviderEnv} but **not** to {@link AgentEnv}.
 *   Passing it where an agent-visible env is expected — `RuntimeOptions.env`,
 *   anything that becomes `ctx.env` — is a compile error.
 *
 * Like all TypeScript brands this is advisory against deliberate laundering
 * (an explicit re-annotation through `Record<string, string>` erases the
 * marker), but an explicit re-typing is a visible, reviewable act — the
 * failure mode this exists to stop is the *silent* one.
 */

declare const hostCredentialsMarker: unique symbol;

/**
 * An env record that may carry host/shell provider credentials. Minted only
 * by `withHostCredentialFallback` (host/providers/host-env.ts). Usable for
 * provider-credential resolution, never as agent-visible env.
 */
export type HostCredentialEnv = Record<string, string> & {
  readonly [hostCredentialsMarker]: true;
};

/**
 * Env acceptable for provider-credential resolution (STT/TTS/LLM openers,
 * `ctx.generate`): the agent's own env or a host-fallback env.
 * Everything is assignable here — the restriction lives on {@link AgentEnv}.
 */
export type ProviderEnv = Record<string, string> & {
  readonly [hostCredentialsMarker]?: true;
};

/**
 * Tenant-owned env — the only kind allowed to become `ctx.env` (what agent
 * tool code reads). A {@link HostCredentialEnv} does not satisfy this type;
 * plain records and other agent envs do.
 */
export type AgentEnv = Record<string, string> & {
  readonly [hostCredentialsMarker]?: never;
};
