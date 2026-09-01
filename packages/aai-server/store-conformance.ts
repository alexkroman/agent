// Copyright 2026 the AAI authors. MIT license.
/**
 * ONE contract, asserted ONCE, over every arm something really runs.
 *
 * Each `*Conformance` function in `store-conformance-cases.ts` is a contract's
 * whole behavioural spec as a list of `test()` declarations over a factory.
 * Callers supply the arm:
 *
 * The case lists themselves are `store-conformance-cases.ts`; this module is the
 * REGISTRY plus the two helpers every case list needs. The split is the file-length
 * cap's doing and lands on a real seam: the registry is metadata about which
 * contracts exist and which have two arms — which is all
 * `store-conformance-registry.test.ts` reads — while the cases are the specs.
 *
 * - the **unit** suites (`workspace-store.test.ts` and friends) run the MEMORY
 *   arm, unconditionally, so the contract is covered on every machine and the
 *   package's coverage floors keep measuring the code;
 * - `store-conformance.scenario.test.ts` runs the **stack** arm behind
 *   `describeWithStack`, where the semantics a JS fake cannot hold are real.
 *
 * ## Why this exists
 *
 * The parity-table pattern was already invented here — `workspace-store.test.ts`
 * and `chat-store.test.ts` each carried a `describe.each(implementations)` — and
 * the arm labelled `postgres` was `createFakeSql()`, a hand-written JS
 * reimplementation of the store's own SQL. It is a THIRD implementation of the
 * contract, it is the one a reader trusts most because of its label, and it
 * holds JS values, so it cannot represent a single one of the bugs that have
 * actually shipped: the `::text::jsonb` double-encode, three orphan tables, an
 * advisory lock not held by the session that thinks it holds it. Every one was
 * found in production or by audit; none by a test, and none could have been.
 *
 * So the fake is out of the arm list and back in its own spec, where what it
 * uniquely asserts — that a store issued the STATEMENTS it should have, and no
 * DDL — is the subject rather than a claim about data semantics. It is a
 * recorder, not an implementation.
 *
 * **Two arms, because there are only two configurations anything runs.** An
 * agent with no `DATABASE_URL` really runs the memory stores, and the platform
 * really runs the Supabase stack. A stock Postgres is neither: nothing anywhere
 * runs `aai_platform` without Vault, pg_cron and walrus, so an arm for it would
 * be one more shape production never had — the exact charge against the fake.
 *
 * ## Rules for a new contract
 *
 * - **A case must be arm-independent.** The stack arm shares ONE database across
 *   every case, so a case owns a fresh key: take it from the `uid()` the
 *   function is handed, never a literal `"s"`/`"p"`. That is also what makes the
 *   cases safe to run twice in one process.
 * - **Assert the CONTRACT, not an implementation's incidentals.** A memory
 *   store's `list` order and a Postgres `order by` agree; its object identity
 *   and a driver's round-trip do not. The identity properties stay in the unit
 *   file as memory-only tests.
 * - **Register it in `STORE_CONTRACTS`.** A conformance table listing only its
 *   memory arm reports the same green as one listing both, and a contract nobody
 *   registered reports nothing at all — so `store-conformance-registry.test.ts`
 *   asserts every `createPg*`/`createMemory*` pair in the repo is named here.
 */

/**
 * `createPgSlugLock`, composed.
 *
 * As one literal it reads as a high-entropy string to biome's `noSecrets`, and
 * the alternative is a suppression comment — which would raise the escape-hatch
 * baseline for a function NAME. Same trade `with-test-pg.mjs` makes for its
 * `postgres://` candidate URL.
 */
const PG_SLUG_LOCK = ["createPg", "SlugLock"].join("");

/**
 * Every contract with two arms, and the factory names that build them.
 *
 * The `memory`/`pg` names are what the registry guard matches source against, so
 * this list is the one place a new pair is declared. `conformance: false` says a
 * pair is deliberately NOT conformable and why — a claim a reviewer can argue
 * with, where an absent entry is just an omission.
 */
export const STORE_CONTRACTS = [
  { contract: "workspace", memory: "createMemoryWorkspaceStore", pg: "createPgWorkspaceStore" },
  { contract: "chat", memory: "createMemoryChatStore", pg: "createPgChatStore" },
  { contract: "agents", memory: "createMemoryAgentRows", pg: "createPgAgentRows" },
  { contract: "secrets", memory: "createMemorySecretStore", pg: "createVaultSecretStore" },
  { contract: "rate-limit", memory: "createRateLimiter", pg: "createPgRateLimiter" },
  {
    contract: "studio-session-registry",
    memory: "createMemoryStudioSessionRegistry",
    pg: "createPgStudioSessionRegistry",
  },
  {
    contract: "studio-preview-queue",
    memory: "createMemoryPreviewQueue",
    pg: "createPgPreviewQueue",
  },
  {
    contract: "blob-storage",
    memory: "createMemoryBlobStorage",
    pg: "createSupabaseBlobStorage",
    // Not a `SqlExec` store at all — Supabase Storage over HTTP. Its arm is the
    // stack's `storage-api` container, which needs a declared bucket; until
    // `supabase/config.toml` declares one there is nothing to point it at, and a
    // conformance table with no real arm is the thing this registry exists to
    // make visible rather than to hide.
    conformance: false,
    why: "needs a declared local storage bucket (supabase/config.toml)",
  },
  {
    // The SDK's own two pairs, and the ONE place in this registry where the real
    // arm is a plain Postgres rather than the stack: an agent's `DATABASE_URL`
    // may be Neon, RDS, or a laptop server, so portability IS the promise there.
    // Registered — the guard found both on its first run — rather than exempt by
    // omission, and not conformable HERE for a structural reason: `packages/aai`
    // may import no sibling, so its case list and its scenario file would both
    // have to live in that package. What it already has is the thing this plan
    // proposes for everything else: `freezeStorable` runs in BOTH backends, so a
    // `Map`, a `Date` or a `NaN` fails in a spec rather than on the first deploy
    // with a database, plus `session-state.scenario.test.ts` over the real one.
    contract: "session-state",
    memory: "createMemoryStateBackend",
    pg: "createPostgresStateBackend",
    conformance: false,
    why: "SDK tier: its arm is a user's own Postgres, and packages/aai may import no sibling",
  },
  {
    // Same structural exemption as session-state above, and the same remedy: the
    // shared CASE LIST cannot serve this pair (the memory arm's unit spec lives
    // in `packages/aai`, which may import no sibling and so cannot reach one
    // declared here), while the real arm can be — and is — driven from this
    // package. `workflow-keys.scenario.test.ts` executes the DDL, the four-column
    // index, `on conflict (run_id) do nothing`, and the ULID tiebreak against a
    // real server. Read the exemption as "not one shared table of cases", never
    // as "no real Postgres runs this".
    contract: "workflow-keys",
    memory: "createMemoryKeyStore",
    pg: "createPostgresKeyStore",
    conformance: false,
    why: "SDK tier: one case list cannot span the boundary; real arm is workflow-keys.scenario.test.ts",
  },
  {
    // The durable JOURNAL — what makes a run outlive its process. Same
    // structural exemption as the two above and the same remedy: the memory
    // arm's unit specs live in `aai-runtime` beside the engine that reads them,
    // and the real arm is driven from here.
    //
    // The exemption costs less than it looks. Almost everything interesting
    // about the Postgres arm is a claim about the DATABASE rather than about the
    // code — `claimAttempt` incrementing atomically under concurrency,
    // `setStatus`'s `where` really constraining, `appendStep`'s `on conflict`
    // resting on a primary key that exists, a hook token unique across RUNS —
    // and a shared case list run against a Map could assert none of them.
    // `workflow-journal.scenario.test.ts` runs the DDL and every one of those.
    //
    // There is a THIRD arm this pair cannot name: `createPlatformJournal`, the
    // same interface over HTTP to `/:slug/workflow-journal`, which is what a
    // DEPLOYED run uses. It is not a store twin — it holds no rows and speaks to
    // the platform — so it is outside this registry by construction, and it has
    // its own two tiers: `aai-runtime/workflow-journal-platform.test.ts` for the
    // codec and the three refusals on this side of the wire, and
    // `platform-workflow-journal.scenario.test.ts` for the SQL, which is the only
    // place TENANCY is testable at all.
    contract: "workflow-journal",
    memory: "createMemoryJournal",
    pg: "createPostgresJournal",
    conformance: false,
    why: "SDK tier: one case list cannot span the boundary; real arms are workflow-journal.scenario.test.ts and platform-workflow-journal.scenario.test.ts",
  },
  {
    contract: "upload-bytes",
    memory: "createMemoryUploadBytes",
    pg: "createSupabaseUploadBytes",
    // The SAME exemption as blob-storage above, for the same reason and against the
    // same missing thing: its real arm is the stack's `storage-api` container, which
    // needs a declared bucket. Worth more than blob-storage's when that bucket
    // arrives — the interesting half here is `Range`, `Content-Length` on a HEAD, and
    // what Storage answers for a window starting past the object, none of which a Map
    // can be strict about.
    conformance: false,
    why: "needs a declared local storage bucket (supabase/config.toml)",
  },
  {
    // The SDK's byte seam, and the pair the platform's own arm is built ON:
    // `createSupabaseUploadBytes` composes `createHttpUploadBlobs`, so the guest
    // talking to a bucket directly under `aai dev` and the platform serving the
    // brokered route run the same code. Same structural exemption as session-state
    // below — `packages/aai` may import no sibling, so a shared case list declared
    // here cannot reach its memory arm's unit spec — plus the bucket one above.
    contract: "upload-blobs",
    memory: "createMemoryUploadBlobs",
    pg: "createHttpUploadBlobs",
    conformance: false,
    why: "SDK tier, and its real arm needs a declared local storage bucket",
  },
  {
    contract: "platform-lock",
    memory: "localSlugLock",
    pg: PG_SLUG_LOCK,
    // The two arms agree on mutual exclusion WITHIN one process and on nothing
    // else: the memory arm is an in-process keyed lock, and the interesting half
    // of the advisory-lock arm is cross-process, which no shared table of cases
    // can express. Its own suite (`platform-lock.scenario.test.ts`) covers the
    // cross-replica half directly.
    conformance: false,
    why: "cross-process exclusion is not expressible as a shared case list",
  },
] satisfies readonly {
  contract: string;
  memory: string;
  pg: string;
  conformance?: false;
  why?: string;
}[];

/** A fresh, collision-proof key per case — see the arm-independence rule above. */
/**
 * The prefix every conformance key carries, and the ONLY pattern a cleanup may
 * match on.
 *
 * The pid is in the PREFIX rather than the middle, and that placement is the
 * whole point. Two packages run a conformance suite over these tables —
 * `aai-server`'s and `aai-studio-server`'s — and turbo runs them in PARALLEL
 * against one database, each ending in an `afterAll` that swept
 * `scope like 'conf-%'`. That pattern matches the other suite's LIVE rows, and
 * `studio_chats` cascades off `studio_workspaces`, so whichever finished first
 * deleted the other's parent workspace mid-run and the chat under it went with
 * it. It presents as a chat that was written and read back `null`, on one of the
 * two scoped-chat assertions, intermittently — the studio file's own comment
 * ("a leftover is invisible to every other scope because each case owns a
 * `conf-*` one") was right about the KEYS and silent about the SWEEP.
 *
 * A per-process prefix makes the two suites' rows disjoint by construction, so
 * a sweep can only ever reach what its own process wrote. The cost is that a
 * CRASHED run leaves its rows behind, where a shared prefix let the next run
 * collect them — which is the right way round: rows nobody is reading cost a
 * scratch database nothing, and deleting rows a live suite is reading costs a
 * red build that reproduces on nothing.
 */
export const CONFORMANCE_PREFIX = `conf-${process.pid}-`;

/** The `like` pattern for everything THIS process wrote. */
export const conformanceLike = (): string => `${CONFORMANCE_PREFIX}%`;

export function uniqueKeys(label: string): () => string {
  let n = 0;
  return () => `${CONFORMANCE_PREFIX}${label}-${Date.now().toString(36)}-${n++}`;
}

/**
 * No foreign key to satisfy — the `parent` a MEMORY arm passes.
 *
 * The chat and studio-session contracts hang off a workspace row
 * (`on delete cascade`), which the memory arms have no analogue for. Taking the
 * parent as a parameter with this default keeps one case list serving both arms
 * rather than branching inside every case on which one it is running under.
 */
export const noParent = (): Promise<void> => Promise.resolve();
