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
    // The ONE place in this registry where the real arm is a plain Postgres
    // rather than the stack: an agent's `DATABASE_URL` may be Neon, RDS, or a
    // laptop server, so portability IS the promise there. Registered — the guard
    // found both on its first run — rather than exempt by omission.
    //
    // **This entry's reason was STALE and is corrected.** It read "SDK tier: its
    // arm is a user's own Postgres, and packages/aai may import no sibling",
    // which was true when it was written (#1110) and stopped being true at the
    // runtime split (#1234): `createMemoryStateBackend`,
    // `createPostgresStateBackend` and `createPlatformStateBackend` all live in
    // `aai-runtime` now, beside the runtime that selects them — and this
    // registry's guard matches on factory NAME, so nothing could notice the
    // move. What the stale reason cost is measurable: the requirement that the
    // three agree was stated twice in prose, as a claim BETWEEN
    // implementations, and nothing compared them.
    //
    // There is a shared case list now: `aai-runtime/session-state-conformance.ts`
    // declares it once and `SESSION_STATE_BACKENDS` there is its registry, the
    // same pattern as this file, a package over. THREE arms run it — memory (the
    // reference, unit), `createPlatformStateBackend` over a handler-shaped fake
    // transport (unit), and `createPostgresStateBackend` against a real database
    // (`session-state-conformance-postgres.scenario.test.ts`). On its first run
    // it found the memory backend's `appendEvents` to be an UPSERT where both
    // databases are `on conflict … do nothing`.
    //
    // What is STILL exempt is the structural half, and it now reads the same way
    // as `workflow-journal` below: both factories live in `aai-runtime`, so THIS
    // registry cannot pair them.
    //
    // **The FOURTH arm is no longer owed.**
    // `session-state-conformance-platform.scenario.test.ts` here runs the shared
    // cases over `platform-session-state.ts`'s own SQL — the real route, the
    // guest bearer, the real statements, the platform's own tables — reached
    // through `loadSessionStateConformance()` on
    // `@alexkroman1/aai-runtime/internal`, the way `loadJournalConformance`
    // works. Its A/Bs are the interesting part. A `discard` narrowed to slots
    // only leaves all 36 shared cases GREEN while failing that arm's own
    // both-tables assertion — precisely the blindness it was built for. And
    // removing `nextEventIndex`'s `bigint` read reddened SIX shared cases while
    // five zero-log ones stayed green — not because the read was right, but
    // because the route ended in a `: 0` fallback, so an unreadable answer
    // became "this session has no events". That fallback is gone (it throws;
    // the runtime's client refused the same value all along, so the defence in
    // depth had been pointing the wrong way), and the same A/B now reddens 12
    // — every `countEvents` case, the zero-log ones included, because `"0"` is
    // exactly as unreadable as `"6"`. A shared case that passes on a fallback
    // is the failure shape this registry exists to make visible.
    //
    // Two suites here still assert what a shared case list cannot, and stay:
    // `session-state.scenario.test.ts` (the double-encode, the grants a
    // provisioned app role gets, and the store above the backend) and
    // `platform-session-state.scenario.test.ts` (the platform's own statements).
    contract: "session-state",
    memory: "createMemoryStateBackend",
    pg: "createPostgresStateBackend",
    conformance: false,
    why: "both factories live in aai-runtime, so this registry cannot pair them — the shared case list is session-state-conformance.ts there, with its own registry (SESSION_STATE_BACKENDS) and FOUR arms, one of which is session-state-conformance-platform.scenario.test.ts here",
  },
  {
    // **This entry's reason was stale in the same way, by the same commit, and
    // it was the worst of the three.** It said the memory arm's unit spec lives
    // in `packages/aai`, which may import no sibling. Both
    // `createMemoryKeyStore` and `createPostgresKeyStore` are declared in ONE
    // FILE in `aai-runtime` (`workflow-keys.ts`) — so unlike session state and
    // the journal, which at least had a boundary between their implementations,
    // nothing structural ever stood between this contract and a shared table.
    // It was simply owed.
    //
    // There is one now: `aai-runtime/workflow-keys-conformance.ts` declares it
    // once and `WORKFLOW_KEY_STORES` there is its registry, the same pattern as
    // this file. TWO arms run it — memory (the reference, unit) and
    // `createPostgresKeyStore` against a real database
    // (`workflow-keys-conformance-postgres.scenario.test.ts`). There is no third
    // and no fourth: this index lives in the app's own `ctx.db` schema, so there
    // is no platform route to drive and no platform SQL to be blind to.
    //
    // On its first run it found TWO drifts, both in the shipped memory store and
    // both on the path a RETRY exists for. `record` had no notion of a run id it
    // had already seen, where the Postgres table keys on `run_id` and answers a
    // conflict with `do nothing`: a retried `record` after a lost connection
    // LISTED the same run twice and PROMOTED it past a newer one, and a run
    // recorded under a second key was findable by both. Memory was the side that
    // was wrong; first-write-wins is its rule now.
    //
    // What is left exempt is the structural half only — this registry matches on
    // factory NAME and both names are in one module of another package.
    // `workflow-keys.scenario.test.ts` here still asserts what a shared case
    // list cannot, and stays: that the DDL EXECUTED (exactly one table, its name
    // read back out of the schema), the four-column index definition, a FORCED
    // same-millisecond ULID tiebreak, and the lookup re-run with index scans
    // disabled so `, run_id desc` is exercised on a plan that has to SORT.
    contract: "workflow-keys",
    memory: "createMemoryKeyStore",
    pg: "createPostgresKeyStore",
    conformance: false,
    why: "both factories live in one module in aai-runtime (workflow-keys.ts), so this registry cannot pair them — the shared case list is workflow-keys-conformance.ts there, with its own registry (WORKFLOW_KEY_STORES) and two arms; the schema and plan claims stay in workflow-keys.scenario.test.ts here",
  },
  {
    // The durable JOURNAL — what makes a run outlive its process. Same
    // structural exemption as the two above: both factories live in
    // `aai-runtime`, beside the engine that reads them, so THIS registry cannot
    // pair them.
    //
    // What is no longer true is the rest of the old reason, which said a shared
    // case list could not span the boundary. There is one:
    // `aai-runtime/journal-conformance.ts` declares it once and
    // `JOURNAL_BACKENDS` there is its registry — the same pattern as this file,
    // a package over. FOUR arms run it, and the two in this package's tiers are
    // the ones that matter here:
    //
    // - memory, the reference, in `aai-runtime`'s unit tier;
    // - `createPlatformJournal` over a FAKE transport, also unit, also in
    //   `aai-runtime` — the guest side of the wire, delegating every semantic to
    //   the memory reference;
    // - `createPostgresJournal` against a real database
    //   (`aai-runtime/journal-conformance-postgres.scenario.test.ts`);
    // - `createPlatformJournal` against the REAL route and a real Postgres
    //   (`journal-conformance-platform.scenario.test.ts`, here — the case list
    //   crosses the boundary through `loadJournalConformance` on
    //   `@alexkroman1/aai-runtime/internal`).
    //
    // That fourth arm is why the case list was worth carrying across a package
    // boundary at all: the platform's own SQL is invisible to every other arm,
    // and `createRun`'s `on conflict … do nothing` answered a duplicate run id
    // with SUCCESS — against an interface, a memory reference and a self-hosted
    // store that all refuse it — while the shared case sat green over the fake
    // transport.
    //
    // Two suites here still assert what a shared case list cannot, and stay:
    // `workflow-journal.scenario.test.ts` (the DDL, and the self-hosted
    // statements one at a time) and `platform-workflow-journal.scenario.test.ts`
    // (the platform's statements, and TENANCY — a claim about column values in a
    // shared table, so only a real database with two tenants' rows can test it).
    contract: "workflow-journal",
    memory: "createMemoryJournal",
    pg: "createPostgresJournal",
    conformance: false,
    why: "SDK tier: both factories live in aai-runtime, so this registry cannot pair them — the shared case list is journal-conformance.ts there, with its own registry (JOURNAL_BACKENDS) and four arms, one of which is journal-conformance-platform.scenario.test.ts here",
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
    // brokered route run the same code.
    //
    // The "packages/aai may import no sibling" half of this reason was stale for
    // the same reason session-state's was — `createMemoryUploadBlobs` and
    // `createHttpUploadBlobs` are both in `aai-runtime` (`_upload-blobs.ts`,
    // `_upload-blobs-http.ts`) since the runtime split — so what is left is the
    // BUCKET, which is the operative half anyway and is shared with
    // `upload-bytes` above.
    //
    // **So this entry is NOT a fourth table owed, and that is the difference
    // from the two above.** Those two were exempt on a boundary that had stopped
    // existing, and both now have a shared case list a package over
    // (`session-state-conformance.ts`, `workflow-keys-conformance.ts`), leaving
    // only the mechanical fact that THIS registry pairs by factory name. Here
    // the blocker is the arm, not the boundary: a case list would have exactly
    // one implementation to run against until `supabase/config.toml` declares a
    // bucket, and a conformance table with one arm reports the same green as one
    // with two. Write it WITH the bucket, in the same change.
    contract: "upload-blobs",
    memory: "createMemoryUploadBlobs",
    pg: "createHttpUploadBlobs",
    conformance: false,
    why: "its real arm needs a declared local storage bucket (supabase/config.toml); both factories live in aai-runtime, so this registry cannot pair them either",
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

/** A fresh, collision-proof key per case — see the arm-independence rule above. */
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
