// Copyright 2026 the AAI authors. MIT license.
/**
 * Verification of raw platform API keys against AssemblyAI.
 *
 * Every ownership check on this platform is RELATIVE — `verifySlugOwner` asks
 * whether a bearer matches a hash stored on one agent's row — so nothing in
 * the request path ever established that a bearer is a credential AssemblyAI
 * issued at all. It did not have to for the owner-scoped routes, which can
 * only ever be reached by a key that already claimed the slug. It very much
 * had to for the routes IN FRONT of ownership: `POST /deploy` claims an
 * unclaimed slug for whoever asks, and the studio's project-create and
 * session-broker routes create resources and spawn Modal sandboxes for a
 * scope derived from the bearer itself. Those three were reachable with an
 * arbitrary `Authorization: Bearer <anything>`.
 *
 * So a raw-key bearer is verified once, here, at the trust boundary, and the
 * verdict is cached. Browser sessions do not come through this file — the
 * middleware resolves them to the account's STORED key first, and that key
 * was verified when it was stored (`PUT /studio/account/key`).
 *
 * Three properties are load-bearing, and each of them is a way this could
 * have been written to look like it works while not working:
 *
 * - **Ambiguity is never "valid".** A 401/403 is the only answer that means
 *   "not a key"; every other failure — a 5xx, a timeout, DNS, a proxy — is
 *   thrown, and the caller answers 503. The tempting shape is to treat an
 *   unreachable upstream as a pass so an AssemblyAI outage cannot take the
 *   platform down with it, which quietly restores the exact hole this closes
 *   for the duration of any outage an attacker can provoke or wait for.
 *   `supabase-auth.ts` already draws this line the same way for sessions.
 * - **Negatives are cached too.** A rejected key that keeps arriving is the
 *   attack, not the accident; without a negative cache the verifier turns
 *   one unauthenticated request into one upstream request, which is a
 *   traffic amplifier pointed at AssemblyAI. Both verdicts share a TTL short
 *   enough that a revoked key stops working within the minute.
 * - **The cache key is a DIGEST.** A live credential must not sit in a map
 *   under its own value, for the same reason `apiKeyOwnerSecretName` hashes.
 */

import { hash } from "node:crypto";
import { createSingleFlight } from "./_memo.ts";
import { TtlCache } from "./_ttl-cache.ts";
import { createLogger } from "./logger.ts";

const log = createLogger("auth");

/**
 * Answers "did AssemblyAI issue this key". Resolves false only on a definite
 * rejection; THROWS when the answer could not be obtained (see the module
 * note — an unreachable upstream must never read as valid).
 *
 * A bare function rather than an interface: every consumer asks exactly this,
 * and a test double is then a `vi.fn()` with no shape to keep in sync.
 */
export type ApiKeyVerifier = (apiKey: string) => Promise<boolean>;

/**
 * AssemblyAI's account API. `GET /v2/transcript?limit=1` is the cheapest
 * authenticated read on it — it names the account rather than a product
 * entitlement, which is what "is this a real key" means here. The LLM
 * gateway would have been the other candidate and is the wrong authority: a
 * key can be valid for the account and not enabled for the gateway, so a
 * gateway 401 would reject keys that work fine for voice sessions.
 *
 * Overridable via `AAI_KEY_VERIFY_URL` so a change on their side is an env
 * edit rather than a deploy.
 */
export const DEFAULT_KEY_VERIFY_URL = "https://api.assemblyai.com/v2/transcript?limit=1";

/**
 * How long a verdict is remembered. Matches the token-verify and user-key
 * caches in `supabase-auth.ts` / `middleware.ts` — long enough that a busy
 * CLI does not pay a round trip per request, short enough that a revoked key
 * stops working within the minute.
 */
const VERIFY_TTL_MS = 60_000;
const VERIFY_MAX = 10_000;

/** Per-request cap. Verification sits in front of every raw-key request. */
const VERIFY_TIMEOUT_MS = 5000;

/**
 * AssemblyAI sends the key as the bare `Authorization` value — no `Bearer`
 * prefix, unlike the LLM gateway and unlike this platform's own surface.
 * Named because the two forms are one character apart in a header literal and
 * getting it wrong looks exactly like every key being invalid.
 */
function authHeader(apiKey: string): Record<string, string> {
  return { Authorization: apiKey };
}

export type AssemblyAiKeyVerifierOptions = {
  /** Defaults to {@link DEFAULT_KEY_VERIFY_URL}. */
  url?: string | undefined;
  /** Test seam — never set outside tests. */
  fetchFn?: typeof globalThis.fetch | undefined;
};

/** A verifier that asks AssemblyAI, memoizing both verdicts. */
export function createAssemblyAiKeyVerifier(
  options: AssemblyAiKeyVerifierOptions = {},
): ApiKeyVerifier {
  const url = options.url ?? DEFAULT_KEY_VERIFY_URL;
  const doFetch = options.fetchFn ?? globalThis.fetch;
  const cache = new TtlCache<boolean>(VERIFY_TTL_MS, VERIFY_MAX);
  // Collapses the burst a cold replica sees for one key: N concurrent
  // requests share ONE upstream call instead of each opening their own. The
  // shared primitive rather than a hand-rolled `Map<string, Promise>` — same
  // one the bundle store's read path uses, and the comment here already cited
  // it as the precedent while restating it. It retains nothing, which is the
  // property that makes it right beside a cache: the TTL above owns the
  // settled verdict, this only closes the window before it is populated.
  const flights = createSingleFlight<boolean>();

  return async (apiKey) => {
    const cacheKey = hash("sha256", apiKey);
    const cached = cache.get(cacheKey);
    if (cached !== undefined) return cached;

    return flights.run(cacheKey, async () => {
      const res = await doFetch(url, {
        headers: authHeader(apiKey),
        signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
      });
      // The ONLY definite rejection. Everything else is "we do not know".
      if (res.status === 401 || res.status === 403) {
        cache.set(cacheKey, false);
        return false;
      }
      if (!res.ok) {
        throw new Error(`AssemblyAI key verification failed (HTTP ${res.status})`);
      }
      cache.set(cacheKey, true);
      return true;
    });
  };
}

/**
 * Build the verifier from the environment.
 *
 * Absent means "accept any bearer as a key", which is why both ways to get there
 * are explicit DECLARATIONS: `AAI_LOCAL_DEV=1` and `AAI_VERIFY_API_KEYS=0`. A
 * boot that merely FORGOT something gets a verifier, not a hole — the same shape
 * as the sandbox backend, and for the same reason: the safe branch has to be the
 * default one. Neither of these is inferred from where platform state lives, so
 * a dev server on the local Supabase stack is unaffected by which of them is set.
 */
export function createApiKeyVerifierFromEnv(
  env: NodeJS.ProcessEnv,
  opts: { localDev: boolean },
): ApiKeyVerifier | undefined {
  if (env.AAI_VERIFY_API_KEYS === "0") {
    log.warn(
      "AAI_VERIFY_API_KEYS=0 — raw API keys are NOT verified; any bearer string is accepted",
    );
    return;
  }
  if (opts.localDev) return;
  return createAssemblyAiKeyVerifier({ url: env.AAI_KEY_VERIFY_URL });
}
