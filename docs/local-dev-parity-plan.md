# Local dev: replacing the in-memory stores with Docker Supabase

Status: proposal. Covers (a) running the platform's real backing services
locally in Docker instead of the in-memory stores, and (b) whether local dev
should spawn Modal sandboxes instead of subprocess guests.

**Verdict up front:** do the Supabase half, as an opt-in profile — not the
default. Do **not** make Modal sandboxes the local default; they are already
one env var away and that is the right place for them.

## What "local memory dev" is today

`isLocalDev(env)` (`packages/aai-server/_boot.ts`) is one boolean:

```ts
env.AAI_LOCAL_DEV === "1" || !env.SUPABASE_S3_ENDPOINT
```

Four unrelated decisions hang off it:

| Decision | Local dev | Production |
| --- | --- | --- |
| Blob storage (`buildStorage`) | unstorage memory driver | Supabase Storage over S3 |
| Platform stores (`buildPlatformDb`) | memory secrets/agents/workspaces/chats, in-process event emitter, in-process slug lock | Vault, Postgres rows, Supabase Realtime, lease-row lock |
| Browser auth (`createStudioAuthFromEnv`) | `createDevAuth` — self-describing `dev.<b64>.dev` tokens, no verification | Supabase Auth (GitHub OAuth) |
| Sandbox backend (`describeSandboxBackend`) | `subprocess` | `modal` |

What the memory path therefore never exercises locally: the Vault SQL
(`vault.create_secret` / `decrypted_secrets`), the `postgres_changes` change
stream that drives sandbox invalidation and studio preview SSE, the pg_cron
sweeps, the Postgres slug-lock lease and its cache-invalidation wrapper, the
workspace row's optimistic `version` conflict/retry path, the two
cross-replica registries (`sandbox_registry`, `studio_sessions`), the S3
`getKeys` pagination loop, and every table's lazy-create DDL.

That is a lot of production-only surface, and it is the surface where bugs
are least visible: a missed change event just means a sandbox lingers, a
missed grant means a filtered subscribe fails with `invalid column for
filter`. Nothing in the local loop can see any of it.

### One thing worth fixing regardless

`buildPlatformDb` returns memory stores whenever `isLocalDev` is true, even
when `SUPABASE_DB_URL` is set — only `appDb` gets wired to the real cluster.
Meanwhile `createStudioAuthFromEnv`'s guard documents `AAI_LOCAL_DEV=1` as
"user intent, e.g. pointing dev at a real database on purpose". That
configuration cannot currently exist: setting the flag takes the platform
stores away. The escape hatch the guard describes is unreachable.

## Is there a package that does this?

**For Supabase: yes, and it is the whole answer.** The Supabase CLI ships
the entire stack as a Docker Compose project — Postgres (with `supabase_vault`
and `pg_cron` available), GoTrue, Realtime, Storage including its
S3-compatible protocol endpoint, PostgREST, and Studio — behind
`supabase start`. It installs as a devDependency:

```sh
pnpm add -Dw supabase
pnpm supabase init && pnpm supabase start
```

Do **not** hand-roll a `docker-compose.yml`. The CLI pins mutually
compatible image versions, wires the Realtime/Storage service keys, seeds the
JWT secrets, and creates buckets declaratively from `supabase/config.toml`:

```toml
[storage.buckets.aai-agents]
public = false
```

`supabase status` prints the values the server needs, including the S3 access
key/secret pair. A hand-written compose file would have to reproduce all of
that and would drift the first time a service image bumps.

**For Modal: no.** There is no local Modal emulator — `modal run`/`modal
serve` execute remotely against your account. The nearest thing to a local
sandbox emulator is the `subprocess` backend this repo already has.

## Plan (Supabase half)

Roughly a day of work, mostly config and docs.

1. **Add `supabase` as a root devDependency and commit `supabase/config.toml`**
   with the `aai-agents` bucket declared and a fixed project id. No compose
   file of our own.
2. **Split `isLocalDev` into orthogonal switches.** Keep the current
   single-flag behavior as the default so nothing changes for anyone who does
   nothing, but let each decision be named independently — something like
   `AAI_STORE_BACKEND=memory|postgres`, `AAI_STORAGE_BACKEND=memory|s3`,
   `AAI_AUTH_MODE=dev|supabase`, alongside the existing `SANDBOX_BACKEND`.
   Derive each from `isLocalDev` when unset. This is the load-bearing change:
   without it, pointing dev at Postgres also silently arms production auth and
   Modal sandboxes.
   - Preserve the safety property in `createStudioAuthFromEnv`: dev auth is
     *no* auth, so it must stay impossible to reach it accidentally against a
     hosted database. Explicit `AAI_AUTH_MODE=dev` is user intent; inferring
     it from the absence of a variable is what the existing guard exists to
     stop.
3. **Add `pnpm dev:local-stack`** — `supabase start`, then export the values
   from `supabase status` into the dev server's env and run
   `dev:aai-server`. Concretely: `SUPABASE_DB_URL` →
   `postgresql://postgres:postgres@127.0.0.1:54322/postgres`, `SUPABASE_URL` →
   `http://127.0.0.1:54321`, `SUPABASE_S3_ENDPOINT` →
   `http://127.0.0.1:54321/storage/v1/s3`, plus the service-role, publishable,
   and S3 keys.
4. **Verify the four extension-level dependencies** on the local image, since
   these are the plausible failure points, in descending order of risk:
   - `pg_cron` — needs `shared_preload_libraries`; if it is not preloadable
     locally, `schedulePlatformSweeps` already fails non-fatally (logged), so
     this degrades rather than blocks. Accept the degradation if so.
   - `supabase_vault` — `createVaultSecretStore` is pure SQL against
     `vault.secrets` / `vault.decrypted_secrets`; needs the extension present.
   - Realtime — `ensureRealtimeSetup` creates the publication and the
     `service_role` SELECT grants; confirm a filtered subscribe actually
     fires locally, since a silent no-op here looks exactly like "the feature
     is just slow".
   - Storage S3 — confirm the unstorage S3 driver's path-style addressing and
     the `region` value (`local`) that Supabase's endpoint expects, and that
     the signed `ListObjectsV2` loop in `s3-storage.ts` works against it.
5. **Local browser sign-in.** `createSupabaseAuth` only verifies tokens; the
   client only offers GitHub OAuth. So either register a GitHub OAuth app with
   an `http://127.0.0.1:54321/auth/v1/callback` callback and put its
   credentials in `config.toml`, or run the local stack with
   `AAI_AUTH_MODE=dev` and skip Supabase Auth. Recommend documenting both and
   defaulting the profile to dev auth — the auth path is the least valuable
   part of the parity gain and the most annoying to set up per contributor.
6. **Document the profile in CLAUDE.md** under "Modal sandbox notes" /
   "Stateless server", including which production-only code paths it does and
   does not cover, and add a reset recipe (`supabase db reset`).
7. **Optional follow-up:** point `workspace-build-integration.test.ts`, or a
   new integration tier, at the local stack behind an env guard, so the
   Postgres store implementations get real coverage instead of only the memory
   ones. This is where the parity work starts paying for itself in CI rather
   than only in manual testing.

Explicitly out of scope: making the local stack the default for
`pnpm dev:aai-server`, and making it a prerequisite for `pnpm test`. The unit
suites should keep running with no Docker daemon present.

## Plan (Modal half) — and why not to do it

Making local dev spawn Modal sandboxes needs no code at all today:
`SANDBOX_BACKEND=modal` plus `MODAL_TOKEN_ID`/`MODAL_TOKEN_SECRET`. That it is
already this easy is most of the argument against making it the default. The
costs of the default flip:

- **Publish and preview deploys break without a public tunnel.** Both run the
  literal `aai deploy` CLI *inside the guest*, against the origin from
  `resolvePublicOrigin` — `http://localhost:8080` locally. A Modal sandbox
  cannot reach that. It would need ngrok/cloudflared plus
  `AAI_PUBLIC_ORIGIN` for every contributor. (Voice sessions are fine: the
  browser dials the guest's public tunnel and the host only makes outbound
  calls.)
- **Every guest edit costs a snapshot-image build.** The harness image tag is
  content-addressed over the harness and toolchain, so touching anything in
  `packages/aai-guest` mints a new tag and the next spawn pays a builder
  sandbox plus an `npm install` before it runs. That is the inner loop.
- **Credentials and spend per contributor**, for a loop that currently needs
  neither.
- **Latency**: remote spawn plus tunnel dial on every `test_agent`.

CLAUDE.md already worked through the equivalent reasoning when the Apple
`container` backend was removed: a dev backend that is *nearly* production
buys nothing that either neighbour does better. The same holds here in the
other direction — `subprocess` for iteration, `SANDBOX_BACKEND=modal` when the
question is "does this really work". The only change worth making is
documentation: write down the tunnel + `AAI_PUBLIC_ORIGIN` requirement, since
today the first thing a developer hits when they try `SANDBOX_BACKEND=modal`
locally is a Publish that fails for a reason nothing explains.

## Should the in-memory implementations be deleted?

No. They are not primarily a dev-mode convenience — they are the test doubles
for the whole `aai-server` + `aai-studio-server` unit suites. Around thirty
test files construct `createMemorySecretStore` / `createMemoryAgentRows` /
`createMemoryWorkspaceStore` / `createMemoryChatStore` /
`createMemoryPlatformEvents` / `localSlugLock` / `createTestStore`, directly
or through `test-utils.ts` and `_test-combined.ts`. Deleting them makes a
Docker daemon a prerequisite for `pnpm test`, and turns a fast forks-pool
suite into one bounded by Postgres round trips — a large, permanent cost paid
on every run, to remove code that is a few dozen lines per store.

The legitimate worry behind the question is **drift**: two implementations of
one interface where tests only ever see the cheap one. But look at where the
drift actually is. `workspace-store.test.ts` and `chat-store.test.ts` already
run behavioral parity suites (`describe.each`) across both implementations —
so memory-vs-pg is pinned. What is *not* pinned is that the "postgres" arm of
those suites runs against a hand-written fake `SqlExec`: a `Map` that
reimplements the store's SQL semantics in TypeScript. Nothing anywhere proves
that fake agrees with real Postgres.

So the untested seam is fake-SQL-vs-Postgres, and deleting the memory stores
does not touch it. The fix is step 7 — run the existing suites against the
Docker stack's real Postgres — which closes the actual gap and keeps the fast
path. Two cheap follow-ups in the same direction:

- Extend the `describe.each` parity pattern to the stores that lack it
  (`agent-store`, `secret-store`), so every pair is pinned by one shared
  suite rather than two independent ones.
- Where a memory implementation is only reachable from tests after the
  profile lands, move it to `test-utils.ts` rather than deleting it — it
  stops counting as production source for coverage, and stops reading like a
  second supported backend.

The narrower version of the question — should the *dev server* stop
defaulting to memory, i.e. should `pnpm dev:aai-server` require Docker — is a
judgement call worth revisiting once the profile has been in use for a while.
The case against flipping it now: most work in this repo (CLI, UI, SDK,
templates) never touches the platform stores, and a default that needs a
daemon running is a default that gets worked around. Ship the profile, see
who uses it, then decide.

## Assessment

**Supabase in Docker: worth it.** It is cheap (one devDependency, no bespoke
compose file), offline, reversible, and it closes a genuine fidelity gap over
code that is otherwise only ever exercised in production — Vault SQL, change
streams, lock leases, version conflicts, registry rows. The main risk is the
usual one for local stacks: it rots if nothing forces it to keep working,
which is the argument for step 7 (point an integration tier at it) rather
than leaving it as a documented ritual.

Two conditions on that yes: keep memory as the zero-setup default (a
contributor fixing a CLI bug should not need a Docker daemon), and do step 2
first — without splitting the flag, the profile drags production auth and
remote sandboxes along with it, which is how it ends up unused.

**Modal sandboxes locally: not as a default.** Keep the two tiers. Spend the
effort on documenting the tunnel requirement instead.
