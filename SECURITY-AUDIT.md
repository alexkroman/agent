# Server security audit — `aai-server` / `aai-studio-server`

**Date:** 2026-08-09 · **Scope:** the platform server surface —
`packages/aai-server` and `packages/aai-studio-server` — as composed by the
single deployed entry (`aai-studio-server/index.ts`). Guest/sandbox internals
and the SDK were read only where the server depends on them.

**Method:** source review against the documented model in
`packages/aai-server/CLAUDE.md`, plus proof-of-concept runs against the real
orchestrator (`createTestOrchestrator`) for the two highest findings. Numbers
below are measured, not estimated; PoC test files were removed after
measuring.

---

## Summary

The tenant-isolation model is in good shape. Slug ownership, credential
separation, sandbox env delivery, dev-auth gating, and the DDL-injection
surface are all handled carefully, and several of the subtler decisions are
right for reasons that are written down (see "What holds up" at the end).

The gap is one layer up: **there is no authentication of the platform API key
itself.** Every ownership check in the codebase is relative — "does this
bearer match a hash stored on *this* row" — and nothing ever establishes that
the bearer is a credential the platform issued or recognizes. The result is
that the entire pre-ownership surface (deploy a new agent, create a studio
project, spawn a coding-agent sandbox) is reachable by anyone on the internet
with an arbitrary `Authorization: Bearer` string. Two findings below are that
gap and its sharpest consequence.

| ID | Severity | Finding |
| --- | --- | --- |
| H-1 | High | No API-key authentication — any bearer string is a valid platform identity |
| H-2 | High | Unauthenticated ~5,800x memory amplification on `POST /deploy` |
| M-1 | Medium | Studio rate limits are keyed by a caller-chosen, unauthenticated scope |
| M-2 | Medium | `key-user:` reverse mapping is last-writer-wins with no proof of key ownership |
| L-1 | Low | `OrchestratorOpts.allowedOrigins` documents the CORS default backwards |
| L-2 | Low | Vault binds raw secrets as query parameters with no scrubbing guard |

---

## H-1 — No API-key authentication: any bearer string is a valid identity

**Where:** `packages/aai-server/middleware.ts` (`resolveBearer`, `authMw`),
`packages/aai-server/secrets.ts` (`verifySlugOwner`),
`packages/aai-studio-server/studio-account-routes.ts`
(`PUT /studio/account/key`).

`resolveBearer` splits bearers on shape: JWT-shaped tokens go to Supabase and
are genuinely verified; everything else is returned as-is and treated as a
platform API key.

```ts no-check
if (!(env.auth && isJwtShaped(token))) {
  const userId = await lookupApiKeyOwner(env.secrets, token);
  return { apiKey: token, ...(userId ? { userId } : {}) };
}
```

Downstream, `verifySlugOwner` compares that string against
`credential_hashes` on the agent's own row. That is a sound *authorization*
check and it is not the problem — the problem is that it is the *only* check.
For a slug with no row, `verifySlugOwner` returns `unclaimed`, and
`deployAgentBundle` claims it for whoever asked. No code path anywhere in
either package calls AssemblyAI to ask whether a key is real;
`PUT /studio/account/key` likewise stores any ≤512-character dotless string
(`AccountKeySchema`).

`requireOwner` correctly rejects `unclaimed` for the data routes — that rule
is well-reasoned and it does stop pre-seeding state for a slug you don't own.
But the deploy path must accept `unclaimed` by construction, and that is the
whole entry point.

**Verified.** Against the real orchestrator, an arbitrary never-issued bearer
deploys successfully, and 25 distinct junk bearers claim 25 distinct agents:

```text
POST /deploy   Authorization: Bearer i-am-not-an-assemblyai-key-just-a-random-string
→ 200 { ok: true, slug: 'attacker-owned', message: 'Deployed attacker-owned' }

agents claimed by 25 distinct junk bearers: 25
```

**Impact.** The unauthenticated caller can:

- **Deploy arbitrary code** and, via the auth-free
  `GET /:slug/client-config`, boot it in a Modal Sandbox with open egress —
  compute and egress billed to the platform's Modal account. `client-config`
  having no auth is a deliberate and correct decision for *public agent
  pages*; it becomes an attack primitive only because the deploy in front of
  it is also unauthenticated.
- **Spawn studio coding-agent sandboxes** — `POST /studio/projects` then
  `POST /studio/projects/:project/session`, each call a Modal spawn. The LLM
  turns fail (they run on the caller's junk key), but the sandbox is spawned
  and billed regardless.
- **Squat slugs**, permanently. Ownership is the hash of a string only the
  squatter knows, so a legitimate user can never reclaim the name.
- **Write to Supabase Storage** without bound — deploy blobs are
  content-addressed and orphans are deliberately retained, so there is no
  reclamation path.

**Recommendation.** Validate the key once at the trust boundary and cache the
verdict:

1. In `resolveBearer`'s raw-key branch, verify the key against AssemblyAI
   before returning it. The caching machinery already exists —
   `keyOwnerCache`/`userKeyCache` are the right shape and TTL; add a third
   keyed by `sha256(key)`. Follow the existing precedent in
   `createSupabaseAuth.verifyAccessToken`: cache rejections too, but let an
   unreachable upstream throw (a 5xx) rather than caching as a rejection.
2. Verify in `PUT /studio/account/key` as well, so a bad key fails at
   onboarding with a clear message instead of at first use.
3. If an upstream call per key class is unacceptable, the cheaper structural
   fix is to require `resolved.userId` — i.e. a key some signed-in account
   has claimed — for every route that creates a resource or spawns compute,
   leaving pure ownership-checked routes on the current path. That reuses the
   `key-user:` mapping already in place and puts a verified GitHub OAuth
   session behind every spawn.

Note that (3) alone does not close M-2 below; do both.

---

## H-2 — Unauthenticated ~5,800x memory amplification on `POST /deploy`

**Where:** `packages/aai-server/gzip-request.ts`,
`packages/aai-server/constants.ts` (`MAX_WORKER_SIZE`),
`packages/aai-server/modal_deploy.py` (`memory=2048`).

The gzip middleware is correct on its own terms — it caps compressed bytes
while buffering *and* decompressed bytes via `maxOutputLength`, and the
comment explaining both axes is accurate. The issue is the cap's absolute
value relative to the container, and the number of full copies the body makes
on its way to the schema.

`MAX_INFLATED_BODY_BYTES` is `4 * MAX_WORKER_SIZE` = **120 MB**. One request
buffers the compressed body (`readBodyCapped`), the inflated `Buffer`
(`gunzipAsync`), a re-wrapped `Request` body, and then whatever `JSON.parse`
allocates — a UTF-16 string plus the parsed object. The web container is
provisioned at **2048 MiB**.

**Verified.** A 29 MB run-length worker compresses to 28 KB on the wire:

```text
compressed bytes on the wire: 28,260
status 200 | rss before 251MB -> peak 415MB | delta 164MB per request
```

28 KB in, 164 MB of resident memory out — a **~5,800x amplification**, and the
deploy *succeeds*, so it also persists a 29 MB blob. Concurrently, it
accumulates:

```text
6 concurrent | wire bytes total 169,560 | rss 252MB -> peak 640MB | delta 388MB
```

Growth is sublinear (GC keeps partial pace) but real, and the 6 requests took
~5s of wall clock, so a modest sustained rate keeps many in flight. Against
2 GB with a Node baseline already at ~250 MB, this is well inside reach from a
single host, with no credential and ~30 KB per request. `MAX_CONTAINERS = 10`
bounds the blast radius to the whole platform rather than protecting it.

**Recommendation**, cheapest first:

1. **Lower `MAX_WORKER_SIZE`.** 30 MB is orders of magnitude past a real
   bundled agent; the CLI gzips uploads at ~4-5x, so even a large agent is a
   few MB. Dropping it to ~5 MB cuts the per-request ceiling by 6x for free
   and does not need H-1.
2. **Bound concurrency, not just size.** A small semaphore around the
   inflate+parse section makes peak memory a function of a constant instead
   of arrival rate. This is the fix that actually holds — the cap can only
   ever bound one request.
3. **Put H-1's authentication in front of it**, so the cost of trying is an
   account.
4. Longer term, stream the worker to Storage instead of routing it through
   `JSON.parse` — the guest already fetches its own bundle from a signed URL,
   so the bytes need not pass through the replica at all.

---

## M-1 — Studio rate limits are keyed by a caller-chosen scope

**Where:** `packages/aai-studio-server/studio-routes.ts` (`requestScope`),
`studio-route-limits.ts`, `studio-rate-limit.ts`.

The limiters are the thing that would otherwise bound H-1's damage, so they
are worth stating separately. Both are keyed by `scope`:

```ts no-check
const requestScope = (c) =>
  c.var.userId ? studioScope(`user:${c.var.userId}`) : studioScope(c.var.apiKey);
```

For an unauthenticated caller there is no `userId`, so the scope is a hash of
the attacker's own bearer string. Changing one character mints a fresh
window. `CHAT_RATE_LIMIT` (30 / 5 min) and `PROJECT_CREATE_RATE_LIMIT`
(60 / hr) are therefore not limits on anyone who does not wish to be limited —
including on `POST /projects/:project/session`, the most expensive route on
the surface (a Modal spawn per call).

The Postgres backing (`createPgRateLimiter`) is right, and the
fail-closed-on-DB-error decision is right. The identity the window is keyed
to is the gap.

**Recommendation.** Fixing H-1 fixes this, since scopes then derive from
verified identities. Until then, add a coarse per-IP limit on the
unauthenticated-eligible routes (`POST /deploy`, `POST /studio/projects`,
`POST /studio/projects/:project/session`) as a second key alongside the
scope. `POST /deploy` has no limiter of any kind today and should get one
either way.

---

## M-2 — `key-user:` reverse mapping is last-writer-wins

**Where:** `packages/aai-server/supabase-auth.ts`
(`apiKeyOwnerSecretName`),
`packages/aai-studio-server/studio-account-routes.ts`.

`PUT /studio/account/key` writes `key-user:<sha256(key)> → user.id`
unconditionally. The doc comment acknowledges the collision case ("a key two
accounts share follows whichever linked last") and treats it as benign for
shared team keys. It is less benign as an attack: an attacker who learns
Alice's key can sign in with *their own* account and bind Alice's key to it.
From then on Alice's CLI — which authenticates with the raw key and resolves
scope through this mapping — lands in the attacker's studio scope. `aai push`
writes Alice's source into the attacker's workspace; `aai list` shows the
attacker's projects.

This does not grant authority the attacker lacked at the moment of theft
(they hold the key). What it adds is **persistence and exfiltration**: a
passive capture of everything Alice's CLI does subsequently, through a
channel Alice has no way to see. Both scopes stay internally consistent, so
nothing on either side reports a problem — the same silent-divergence failure
mode the backfill in `cli-link/approve` exists to cure.

**Recommendation.** Refuse to rebind a key already mapped to a different
`uid` (409, "that key is already linked to another account"), or require the
rebinding account to prove the key works against AssemblyAI — which H-1's
verification supplies for free. Keep the `cli-link/approve` backfill
idempotent for the same-uid case, since that path is load-bearing for healing
older accounts.

---

## L-1 — `allowedOrigins` documents the CORS default backwards

**Where:** `packages/aai-server/orchestrator.ts:99-100` vs
`packages/aai-server/app-middleware.ts:26-31`.

The option is documented as:

```ts no-check
/** Allowed CORS origins. Defaults to `["*"]` (any origin). */
allowedOrigins?: string[];
```

The implementation does the opposite — `if (!allowedOrigins) return ""`
denies every cross-origin request — and no production caller passes the
option (`index.ts` builds the orchestrator from `ServiceConfig`, which has no
such field). **The runtime behaviour is the safe one.** The risk is purely
that the comment is the thing a future reader trusts: it invites someone to
"fix" the code to match the doc, and it misleads a reviewer into thinking the
surface is `*`-open when it is not.

**Recommendation.** Correct the comment to state deny-by-default, and note
that production passes nothing deliberately. Cheap, and it removes a trap.

---

## L-2 — Vault binds raw secrets as query parameters, unscrubbed

**Where:** `packages/aai-server/secret-store.ts` (`createVaultSecretStore`)
vs `packages/aai-server/app-database.ts` (`scrubSecret`),
`packages/aai-server/service-config.ts` (`installProcessSafetyNets`).

`app-database.ts` scrubs its inlined role password out of any thrown error,
and the comment gives the exact reason: postgres.js attaches the failing
`query`/`parameters` as own properties, and the safety nets log whole error
objects —

```ts no-check
process.on("unhandledRejection", (err) => {
  console.error("Unhandled rejection:", err);
});
```

`console.error` on a raw error prints own enumerable properties.
`createVaultSecretStore` binds raw secret values as `$1`/`$2`
(`select vault.create_secret($1, $2)`) — every agent secret and every user's
AssemblyAI key — and has no equivalent guard.

**I did not find a live leak.** Every `secrets.put` call site is awaited into
the Hono handler, which formats with `errorDetail(err)` (`err.stack` — a
string, no own properties). So today the exposure depends on an invariant
that nothing enforces: that no Vault write ever ends up in a fire-and-forget
promise. The studio has several fire-and-forget paths already
(`settledEdit`, `wake`), so that invariant is one refactor from being false.

**Recommendation.** Make the safety nets log `errorDetail(err)` rather than
the raw object. That is one line, closes the class rather than the instance,
and makes `app-database.ts`'s scrubbing a belt-and-braces measure instead of
the only thing standing between a provisioning failure and a password in the
logs.

---

## What holds up

Stated explicitly, because a findings list on its own misrepresents the code:

- **Ownership checks.** Constant-time comparison (`timingSafeEqual`);
  SHA-256 rather than argon2 is the right call for high-entropy machine
  secrets and the reasoning in `secrets.ts` is correct. The `unclaimed` → 404
  rule in `requireOwner` is subtle and right. Deploy checks ownership for
  generated slugs too, closing the collision case.
- **Dev auth.** `createDevAuth` is genuinely no-auth, and the guard in
  `createStudioAuthFromEnv` — fail boot if any production marker is present
  without an explicit `AAI_LOCAL_DEV=1` — is the correct shape, precisely
  because `isLocalDev` keys off a storage variable that a partial deploy
  could omit.
- **DDL injection.** App-database identifiers are derived from a SHA-256
  digest and shape-asserted (`IDENTIFIER_RE`) before interpolation;
  passwords are locally generated hex, likewise constrained. DDL cannot take
  bind parameters, and this is the right way to handle that. Vault and the
  stores use bind parameters throughout.
- **Guest env delivery.** `modal-agent-sandbox.ts` constructs the exec env
  explicitly — no `...process.env` spread — and boot artifacts are written to
  the sandbox filesystem and hash-verified rather than trusted from the
  spawner.
- **Token entropy.** Every minted token is 32 bytes of `randomBytes`; the
  guest compares bearers with `timingSafeEqual` (`harness-auth.ts`).
- **Logging hygiene.** No credential reaches a log on the request path;
  secret mutations log a slug and a count.
- **Input validation.** `SafePathSchema` normalizes and rejects traversal,
  absolute paths, backslashes, and null bytes. Slug grammar is shared with
  the CLI from one source, and reserved names are enforced at three layers.
- **The gzip middleware** caps both axes correctly (H-2 is about the cap's
  value, not its logic).

## Suggested order of work

1. **L-1** and **L-2** — one-line changes, no design decisions.
2. **H-2 step 1** (lower `MAX_WORKER_SIZE`) — independent of everything else,
   6x reduction.
3. **H-1** — the real fix; **M-1** and **M-2** largely fall out of it.
4. **H-2 step 2** (a concurrency semaphore on deploy body handling) — the
   durable bound.
