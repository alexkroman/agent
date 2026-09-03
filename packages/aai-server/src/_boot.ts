// Copyright 2025 the AAI authors. MIT license.
/**
 * Pure boot-time helpers for the platform server entry point (index.ts).
 * Extracted so the env-validation and sizing logic is unit-testable without
 * starting a server.
 */

import { DEFAULT_PORT } from "./constants.ts";

export function requireEnv<const K extends string>(
  env: NodeJS.ProcessEnv,
  keys: readonly K[],
): { [P in K]: string } {
  const missing = keys.filter((k) => !env[k]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }
  return Object.fromEntries(keys.map((k) => [k, env[k]])) as { [P in K]: string };
}

/**
 * The env a PLATFORM tier requires beyond `SUPABASE_DB_URL` itself, refused at
 * boot rather than resolved into a mixture.
 *
 * A list rather than three call sites, because what they share is the argument:
 * every one of them fails SILENTLY when absent, so a half-configured platform is
 * worse than a refused one.
 *
 * - **`SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY`** — Realtime. Without them a
 *   replica never invalidates a resident sandbox on redeploy and never pushes
 *   studio SSE, and both failures are quiet.
 * - **`AAI_PUBLIC_ORIGIN`** — the newest, and the one whose requirement changed
 *   under it. It was needed for durable webhook URLs and nothing else, so it was
 *   optional; it is now the only source of `agentPlatformBaseUrl`, which a guest
 *   receives as `AAI_PLATFORM_BASE_URL`, which is half of what
 *   `resolvePlatformQueue` needs to install the PLATFORM workflow world. Required
 *   only on a PLATFORM tier: local dev derives that one value from this server's
 *   own port, because a dial base has to be reachable rather than publicly
 *   correct. Unset,
 *   every durable run falls back to the DevKit's LOCAL world — queue in the
 *   guest's memory, state in a directory, both gone with the sandbox — while the
 *   platform's own queue table is never read. The trace is one `console.error` in
 *   a guest's stderr, and what a tenant sees is a workflow that worked in the
 *   studio and forgets everything in production.
 *
 *   It cannot be defaulted or derived: an origin learned from a request is the
 *   CALLER's to write, and that middleware runs before any auth, so one
 *   unauthenticated request would decide the URL baked into the next sandbox this
 *   replica spawns — for any tenant (`rememberPublicOrigin`).
 */
export const PLATFORM_TIER_ENV = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "AAI_PUBLIC_ORIGIN",
] as const;

/**
 * Whether platform state lives in Supabase — the one question every STORE
 * selection asks (`service-config.ts`), and the one auth answers too.
 *
 * `SUPABASE_DB_URL` is the sentinel because it is the connection the platform
 * tier IS: Vault secrets, the agents table, studio workspaces and chats, the
 * durable-workflow world, session state, and the Realtime change streams all ride
 * it. Set means
 * everything is in Supabase, and the three settings that travel with it
 * (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_STORAGE_BUCKET`) are
 * REQUIRED rather than optional — a half-configured platform tier is refused at
 * boot instead of silently resolving to a mixture.
 *
 * Unset is the memory tier, and it is a whole tier rather than a fallback per
 * store: agents rows, deploy blobs, secrets and studio workspaces all live in
 * this process's heap, so a restart erases every deployed agent. There used to
 * be a THIRD state — memory stores beside real per-app databases, reached by
 * setting this variable in local dev — and it is the state that cost a morning:
 * a published agent's slug 404s after a restart with its app schema still
 * sitting in Postgres, so nothing about the failure names the store that lost
 * it. Per-app databases are gone, but the two-tier rule is not a leftover of
 * them: the workflow world and session state now ride this same connection, so a
 * mixture would reproduce the identical failure with durable state instead of an
 * app schema.
 *
 * Deliberately NOT the same question as {@link isLocalDev}. Which stores a
 * process uses and whether tenant code gets a real sandbox are independent
 * decisions, and conflating them meant "run against local Supabase" also meant
 * "resolve the Modal backend and verify every API key" — which is why the
 * documented recipe for it carried `SANDBOX_BACKEND=subprocess` and
 * `AAI_VERIFY_API_KEYS=0`.
 */
export function hasPlatformDb(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.SUPABASE_DB_URL);
}

/**
 * Whether this is an explicitly declared LOCAL run.
 *
 * It gates exactly two things, both about trust rather than about storage: the
 * isolation-free `subprocess` sandbox backend (`sandbox-backend.ts`), and
 * skipping AssemblyAI key verification (`api-key-verify.ts`). A third, narrower
 * one rides along — remembering an observed public origin
 * (`public-origin.ts`).
 *
 * **`AAI_LOCAL_DEV=1` and nothing else**, so the safe branch is the DEFAULT one:
 * a deployment that sets no variable at all still gets real sandboxes and real
 * key verification. The previous sentinel was `!SUPABASE_STORAGE_BUCKET`, which
 * inverts that — it makes the dangerous branch the one a forgotten variable
 * lands on. `scripts/dev-server.mjs` sets this, so `pnpm dev:aai-server` needs
 * no flags.
 */
export function isLocalDev(env: NodeJS.ProcessEnv): boolean {
  return env.AAI_LOCAL_DEV === "1";
}

/**
 * Refuse an ANON-authority key in `SUPABASE_SERVICE_ROLE_KEY`. Two consumers
 * derive service-role authority from that one variable — Supabase Storage
 * (deploy blobs) and the Realtime change streams — and neither fails in a way
 * that names the credential:
 *
 * - **Storage** authenticates the key fine and then applies `anon` authority,
 *   so a `blobs/<sha256>` write dies on `storage.objects` RLS with
 *   `new row violates row-level security policy`. It reads as a broken bucket
 *   policy rather than a wrong key. This is also invisible until it is fatal:
 *   the S3-compat path this replaced went through Supabase's S3 gateway, which
 *   bypasses RLS entirely, so the same wrong key was inert for as long as
 *   deploys used it.
 * - **Realtime** is worse, because nothing surfaces at all. Filter columns are
 *   validated against the subscriber's claimed role, and the platform schema
 *   grants `select` to `service_role` only (see the platform-schema
 *   migration), so every filtered subscribe fails server-side with
 *   `invalid column for filter` and realtime-js retries the join forever. The
 *   service boots healthy and merely stops invalidating resident sandboxes on
 *   redeploy and stops pushing studio SSE.
 *
 * Hence a boot-time refusal, the same trade as `assertSessionModeUrl`:
 * an unusable credential should name itself at start-up rather than be
 * reconstructed from a 500 days later. Only the two forms that are
 * *definitely* wrong throw — an unrecognizable key is left to Supabase to
 * reject, which it does with a better message than a shape check can.
 */
export function assertServiceRoleKey(key: string): void {
  if (!anonAuthority(key)) return;
  throw new Error(
    "SUPABASE_SERVICE_ROLE_KEY holds a PUBLISHABLE (anon) key. It must be the project's " +
      "secret key (`sb_secret_…`, or the legacy `service_role` JWT): deploy blob writes go " +
      "through Supabase Storage RLS, and the Realtime change streams subscribe to " +
      "`aai_platform` tables that grant SELECT to service_role only. On an anon key, deploys " +
      "fail with a row-level-security error and every filtered subscribe retries forever. " +
      "Note SUPABASE_PUBLISHABLE_KEY is a separate setting and stays publishable.",
  );
}

/** Whether a Supabase API key carries `anon` rather than service-role authority. */
function anonAuthority(key: string): boolean {
  // New-style keys declare their tier in the prefix. `sb_secret_…` is the
  // service-role replacement; only the publishable form is a definite no.
  if (key.startsWith("sb_publishable_")) return true;
  // Legacy keys are JWTs whose `role` claim is the authority. Read it without
  // verifying the signature — this is a configuration check, not an auth
  // boundary, and the signature is Supabase's to validate.
  const parts = key.split(".");
  const payload = parts[1];
  if (parts.length !== 3 || !payload) return false;
  try {
    const claims: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return (claims as { role?: unknown }).role === "anon";
  } catch {
    return false;
  }
}

/**
 * Parse `PORT` for a service entry point. Unset/empty falls back to
 * `fallback`; anything else must be a valid port or boot fails loudly.
 *
 * Throwing beats falling back here: a platform-injected `PORT` that doesn't
 * parse (`Number.parseInt` on `tcp://…` is NaN) used to reach `listen(NaN)`,
 * which binds an EPHEMERAL port — the process boots "successfully" and looks
 * healthy locally while the proxy's configured port gets nothing.
 */
export function resolvePort(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`Invalid PORT "${raw}" — expected an integer between 0 and 65535`);
  }
  return port;
}

/**
 * The port THIS platform process listens on — the same answer its entry point
 * gave `listen`.
 *
 * A function rather than a value read at each site because it is asked twice
 * for reasons that have nothing to do with booting: the microsandbox network
 * policy has to OPEN this port for a guest, and `agentPlatformBaseUrl`
 * has to build the URL that guest DIALS on it. Both used to parse `PORT`
 * themselves, and they disagreed — the policy fell back to
 * {@link DEFAULT_PORT} on garbage while the entry point threw, so a
 * mis-injected `PORT` opened 8080 for a server that never bound it.
 *
 * Unreachable in practice for the spawn-time callers: the entry point resolved
 * the same value before it could accept the request that spawns anything, so a
 * throw here means a `PORT` that changed under a running process.
 */
export function platformOwnPort(env: NodeJS.ProcessEnv = process.env): number {
  return resolvePort(env.PORT, DEFAULT_PORT);
}
