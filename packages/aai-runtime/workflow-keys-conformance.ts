// Copyright 2026 the AAI authors. MIT license.
/**
 * ONE {@link WorkflowKeyStore} contract, asserted ONCE, over every store the
 * correlation-key index really lands in.
 *
 * This is `journal-conformance.ts` a third time and
 * `session-state-conformance.ts` a second: read either for the argument behind
 * the pattern, which is not restated here. What this module adds is the registry
 * and the entry point; the cases are `workflow-keys-conformance-cases.ts`, which
 * also declares the arm vocabulary.
 *
 * ## Why this contract needed a table, and why it was the LAST to get one
 *
 * `aai-server/store-conformance.ts` registered `workflow-keys` with
 * `conformance: false` and the reason "SDK tier: the memory arm's unit spec
 * lives in `packages/aai`, which may import no sibling". That was true when it
 * was written (#1110) and stopped being true at the runtime split (#1234) —
 * `createMemoryKeyStore` and `createPostgresKeyStore` are declared in ONE FILE
 * in this package (`workflow-keys.ts`) — and that registry matches on factory
 * NAME, so nothing could notice the move. It was the *worst* of the three stale
 * exemptions, because the other two at least had a boundary between their
 * implementations; here there was never anything structural in the way of a
 * shared table at all. It was simply owed.
 *
 * What the stale reason cost is the two drifts below, both live in the shipped
 * memory store, both on the code path a RETRY exists for.
 *
 * ## What the table found
 *
 * Two, one shape: `createMemoryKeyStore.record` had no notion of a run id it had
 * already seen, where the Postgres store keys the table on `run_id` and answers
 * a conflict with `do nothing`.
 *
 * - **A retried `record` LISTED the same run twice.** `record(wf, k, r)` twice
 *   answered `[r, r]` in memory and `[r]` on a real server. That is exactly the
 *   case the Postgres store's `on conflict` comment names — "a retried `record`
 *   after a lost connection" — so the reference disagreed with production on
 *   the one path the clause was written for.
 * - **A run recorded under a SECOND key was findable by both.** Memory answered
 *   `[r]` for both keys; Postgres answers `[r]` for the first and `[]` for the
 *   second, which `aai-server/workflow-keys.scenario.test.ts` already pinned
 *   against a real database.
 *
 * **Memory is the side that was wrong, in both.** A run id is unique by
 * construction, so a second `record` naming one is a retry rather than a new
 * fact, and `lookup`'s promise ("run ids started for `key`") is not satisfied by
 * a run that was started for a different one. FIRST WRITE WINS is now the
 * memory store's rule too, which is `on conflict (run_id) do nothing` in a
 * `Set`.
 *
 * ## Three stores, three arms, and what each can SEE
 *
 * - **memory** — the reference, in the UNIT tier, unconditionally
 *   (`workflow-keys-conformance.test.ts`). A store that disagrees with it has a
 *   bug unless the interface is what is wrong.
 * - **postgres** — in the SCENARIO tier
 *   (`workflow-keys-conformance-postgres.scenario.test.ts`), behind
 *   `describeWithPg`, where the lazy DDL, the primary key `on conflict (run_id)
 *   do nothing` rests on, `order by created_at desc, run_id desc` and `limit`
 *   as a bind parameter are the database's answers rather than a fake's.
 * - **platform** — in the UNIT tier, over a transport that decodes exactly what
 *   `aai-server/workflow-keys-handler.ts` decodes and then delegates every
 *   SEMANTIC to the memory reference. So it sees THIS side of the wire: the shape
 *   of every request the client builds, that `record` stamps a `createdAt` at all,
 *   and that `lookup` READS its answer rather than assuming one.
 *
 * **This header used to say "there is no third arm, and there is no fourth",** on
 * the ground that the index lives in the app's own `ctx.db` schema "which is why a
 * workflow app has storage switched on when it is created". Both halves were
 * false by then: `ctx.db` is gone and the platform provisions no database, so the
 * store a DEPLOYED agent actually used was the memory one — the `Map` this table
 * calls the reference, in a sandbox that self-exits. `createPlatformKeyStore`
 * (`workflow-keys-platform.ts`) is the third implementation and the third arm.
 *
 * **The FOURTH arm is owed and is not written**, and the gap is the journal's
 * exactly: the unit platform arm's transport is memory-backed, so it cannot
 * represent a bug in the platform's own SQL — that arm has to be the shared case
 * list over `createPlatformKeyStore` wired to the REAL route and a real Postgres,
 * which can only be stood up from `aai-server`, and doing so needs
 * `createPlatformKeyStore` plus a `loadWorkflowKeyConformance` on
 * `@alexkroman1/aai-runtime/internal` (the loader shape `loadJournalConformance`
 * and `loadSessionStateConformance` already have, and for their measured reason:
 * the case modules pull `vitest`, an optional peer). Until it exists, the
 * platform's statements are covered by `aai-server/
 * platform-workflow-keys.scenario.test.ts` — a per-store suite over a real
 * database including the cross-tenant reads, which is a different question from
 * "does this backend satisfy the shared contract" and does not answer it.
 *
 * **What NO arm can see** is a claim about the DDL or the plan, because a
 * conformance table drives the interface and nothing else:
 * `aai-server/workflow-keys.scenario.test.ts` is where the `create table` and
 * the four-column `create index` are asserted to have EXECUTED, where the ULID
 * tiebreak is forced on a same-millisecond pair, and where the lookup runs a
 * second time with index scans disabled so `, run_id desc` is exercised on a
 * plan that has to SORT. That suite stays, and it is not redundant with this
 * one: it asserts what the schema is, and this asserts what the interface
 * promises.
 *
 * ## Rules for a new case
 *
 * - **A case must be arm-independent, so it owns a fresh WORKFLOW and fresh run
 *   ids.** The Postgres arm shares ONE table across every case, and a lookup is
 *   keyed on the pair — so take every name from {@link WorkflowKeyArm.uid} and
 *   never write a literal `"digest"`/`"wrun_1"`.
 * - **Record serially, oldest first.** `created_at` is the statement's own
 *   transaction time, so concurrent inserts leave the ordering contract up to
 *   the pool. The case module's `recordAll` is the helper.
 * - **Assert the CONTRACT, not an implementation's incidentals.** Which
 *   statements a store issues, the DDL, the index definition, `resolveFindLimit`
 *   and the plan-independence of the tiebreak are per-store claims and stay in
 *   `workflow-keys.test.ts` and in `aai-server/workflow-keys.scenario.test.ts`,
 *   which is why neither is redundant with this.
 * - **Register the store below.** A table listing one of two arms reports the
 *   same green as one listing both; `workflow-keys-conformance.test.ts` sweeps
 *   the tree and fails when a `create*KeyStore` factory is missing from
 *   {@link WORKFLOW_KEY_STORES}.
 *
 * ## What the table does NOT assert, and why
 *
 * - **The ORDER of two runs recorded in the same instant.** Memory's order is
 *   insertion; Postgres breaks a `created_at` tie on `run_id desc`, which is
 *   "the order they were started" only because a real run id is a ULID. The
 *   cases keep the two consistent by minting ascending ids
 *   ({@link workflowKeyIds}) rather than by asserting a tiebreak neither
 *   interface promises — and the tiebreak's own arm, including the
 *   index-scans-disabled plan, is in `aai-server`'s suite.
 * - **DURABILITY.** The memory store is deliberately not durable — a dev server
 *   restart forgets the index, matching what the dev world already does to the
 *   runs themselves — so "survives the process" is the one property the two
 *   arms must NOT agree on.
 * - **A negative or fractional `limit`.** `resolveFindLimit` clamps above this
 *   seam and is specced there; what reaches a store is an integer ≥ 1, plus the
 *   `0` the table does ask about because both stores answer it identically and a
 *   reader should not have to guess.
 * - **Concurrent `record` calls on one key.** Nothing above this seam issues
 *   them (a `start` records once, after the run exists), and the answer would be
 *   a claim about a pool rather than about the index.
 *
 * @internal
 */

import {
  type WorkflowKeyArm,
  workflowKeyConformanceCases,
} from "./workflow-keys-conformance-cases.ts";

// The arm vocabulary is declared in the leaf case module and re-exported BY NAME
// here, so a caller wiring an arm imports one module and never has to know which
// file the cases sit in. Declaring it here instead would make the entry module
// and its own cases a cycle.
export { type WorkflowKeyArm, workflowKeyIds } from "./workflow-keys-conformance-cases.ts";

/**
 * One registered store.
 *
 * Declared as a TYPE and the list ANNOTATED with it, rather than left to
 * `satisfies` the way `STORE_CONTRACTS` is. `satisfies` narrows to the literal,
 * so a field no current entry uses is not on the inferred type at all — and
 * `conformance`/`why` are exactly that: the exemption fields, absent today
 * because both stores really are conformable. The sweep reads them, so inference
 * would make the guard-under-the-guard fail to COMPILE the moment the exemption
 * is unused, which is the moment it is least likely to be noticed.
 */
export type WorkflowKeyStoreEntry = {
  /** The store's short name, as the report calls it. */
  store: string;
  /** The module that declares it, relative to this package's root. */
  module: string;
  /** The factory it exports. */
  factory: string;
  /**
   * Every file that answers the shared case list over this store.
   *
   * This replaced a single `tier: "unit" | "scenario"`, and the platform entry is
   * why — the same lesson `JournalBackend.arms` records: a store may have arms in
   * more than one tier AND in more than one PACKAGE, and a `tier` field can
   * describe only one of them, so the second ends up in the entry's PROSE, which
   * is not a registration. A path is relative to `packages/`, so an arm a package
   * away is as declared as one beside this registry.
   */
  arms: readonly WorkflowKeyArmSite[];
  /** Set when the store is deliberately NOT conformable. */
  conformance?: false;
  /** Why not — a claim a reviewer can argue with. */
  why?: string;
};

/** One file that runs the shared case list over one store. */
export type WorkflowKeyArmSite = {
  /** The test file, relative to `packages/`. */
  file: string;
  /** Which tier it runs in — checked against the filename, not trusted. */
  tier: "unit" | "scenario";
  /** What this arm can see that its siblings cannot. */
  sees: string;
};

/**
 * Every {@link WorkflowKeyStore} implementation, and the tier its arm runs in.
 *
 * `module` and `factory` are what the sweep in
 * `workflow-keys-conformance.test.ts` matches the tree against, so this list is
 * the one place a third store is declared. `conformance: false` says a store is
 * deliberately NOT conformable and why — a claim a reviewer can argue with,
 * where an absent entry is just an omission.
 *
 * **Both entries name the SAME module, and that is the finding this table came
 * out of** rather than a shape to tidy: the two implementations of this
 * interface share one file, so nothing structural ever stood between them and a
 * shared case list. It also means the discovery rule differs from its two
 * siblings' — see the sweep's own note.
 */
export const WORKFLOW_KEY_STORES: readonly WorkflowKeyStoreEntry[] = [
  {
    store: "memory",
    module: "workflow-keys.ts",
    factory: "createMemoryKeyStore",
    arms: [
      {
        file: "aai-runtime/workflow-keys-conformance.test.ts",
        tier: "unit",
        sees: "the reference, unconditionally, on every machine",
      },
    ],
  },
  {
    store: "postgres",
    module: "workflow-keys.ts",
    factory: "createPostgresKeyStore",
    arms: [
      {
        file: "aai-runtime/workflow-keys-conformance-postgres.scenario.test.ts",
        tier: "scenario",
        sees: "the lazy DDL, the primary key that makes `on conflict (run_id) do nothing` a no-op rather than an error, the ordering clause and `limit` as a bind parameter, all as the database's answers",
      },
    ],
  },
  {
    store: "platform",
    // The one entry naming a module of its own — the other two share
    // `workflow-keys.ts`, which is the shape this table came out of. So the
    // FACTORY-name sweep below is what discovers all three, and the module scan is
    // what would find a fourth arriving in a fourth file.
    module: "workflow-keys-platform.ts",
    factory: "createPlatformKeyStore",
    arms: [
      {
        file: "aai-runtime/workflow-keys-conformance.test.ts",
        tier: "unit",
        sees: "THIS side of the wire — the request shape, the `createdAt` the client stamps, and that `lookup` reads its answer — over a handler-shaped transport that delegates every semantic to the memory reference",
      },
      // The arm that would find a bug in the platform's own SQL is NOT here, and
      // the header says what it needs. Naming it in this list before it exists
      // would be the failure `journal-conformance-arms.test.ts` was written for,
      // one direction over: an arm declared and absent from the tree.
    ],
  },
];

/**
 * The whole contract, as a list of `test()` declarations over one arm.
 *
 * A one-line wrapper today, where its two siblings compose two and three case
 * modules — kept for the same reason they have one: a caller wiring an arm calls
 * ONE function, so a case module split out later for the line cap is not a
 * change to every arm.
 */
export function workflowKeyConformance(arm: WorkflowKeyArm): void {
  workflowKeyConformanceCases(arm);
}
