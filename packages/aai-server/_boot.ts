// Copyright 2025 the AAI authors. MIT license.
/**
 * Pure boot-time helpers for the platform server entry point (index.ts).
 * Extracted so the env-validation and sizing logic is unit-testable without
 * starting a server.
 */

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
 * Whether this process is a local-dev run: in-memory stores, and the one
 * environment where the isolation-free `subprocess` sandbox backend can be
 * selected (see sandbox-backend.ts).
 *
 * The sentinel is the deploy artifact BUCKET — the one setting that is
 * meaningless without real object storage behind it, so production always has
 * it and a laptop never does. Deliberately not `SUPABASE_URL` or
 * `SUPABASE_DB_URL`: both are legitimately set in local dev (against a
 * scratch project, or to exercise per-app databases), and either one as the
 * sentinel would silently promote such a run to "production" — memory stores
 * off, and Modal credentials suddenly mandatory.
 */
export function isLocalDev(env: NodeJS.ProcessEnv): boolean {
  return env.AAI_LOCAL_DEV === "1" || !env.SUPABASE_STORAGE_BUCKET;
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
