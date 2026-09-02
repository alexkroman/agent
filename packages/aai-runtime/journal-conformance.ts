// Copyright 2026 the AAI authors. MIT license.
/**
 * ONE {@link JournalStore} contract, asserted ONCE, over every backend a run
 * really journals into.
 *
 * This is `aai-server/store-conformance.ts` a second time, deliberately: read
 * that file first — it carries the argument for the pattern, and nothing here
 * restates it. What this module adds is the registry and the two helpers; the
 * cases themselves are {@link journalRunConformance} and
 * {@link journalWaitConformance}, split for the file-length cap at the seam the
 * platform's own store already splits on (`platform-workflow-journal-hooks.ts`):
 * a run, its steps and its attempts answer "what has this run DONE", and the
 * sleeps and hooks answer "may this wait still be answered".
 *
 * ## Why the journal needed its own table rather than joining that one
 *
 * `STORE_CONTRACTS` registers `workflow-journal` with `conformance: false` and a
 * reason — "one case list cannot span the boundary" — and the reason is true of
 * THAT table: it lives in `aai-server`, and `aai-runtime` may not import it.
 * What it is not is a reason for the contract to go unparried, which is how
 * three implementations of twelve methods came to be checked by three unrelated
 * suites that shared no assertion. A review of the branch that added the third
 * found FIVE drifts between them, and every one was an edge case about ABSENCE:
 * `undefined` bound to a driver that refuses it, a wire record parsed as a step
 * because it was record-shaped, a compare-and-set that was not one, a `not null`
 * on one side of a column that is nullable on the other, and `""` standing in
 * for a missing correlation id in two backends out of three. That is the shape a
 * conformance table exists to hammer, so the absence matrix is a section of its
 * own below.
 *
 * ## Three backends, three tiers, and what each arm can SEE
 *
 * - **memory** — the reference, in the UNIT tier, unconditionally. A backend
 *   that disagrees with it has a bug unless the interface is what is wrong.
 * - **platform** — in the UNIT tier, over the fake transport in
 *   `journal-conformance.test.ts`. That fake decodes and encodes exactly what
 *   `aai-server/workflow-journal-handler.ts` does and delegates every SEMANTIC
 *   to the reference journal, storing the codec's TEXT the way the platform's
 *   `jsonb` columns do. So the arm is a test of THIS side of the wire — the
 *   codec, `toRun`/`toStep`, the count-as-string, the boolean — which is exactly
 *   where two of the five drifts lived. It is deliberately NOT a JS
 *   reimplementation of the platform's SQL: that would be the third
 *   implementation `store-conformance.ts`'s doc argues against at length, and it
 *   would be the arm a reader trusts most while being unable to represent a
 *   single bug the platform has actually shipped. What that costs is written
 *   down in this file's own report and in `journal-conformance.test.ts`.
 * - **postgres** — in the SCENARIO tier
 *   (`journal-conformance-postgres.scenario.test.ts`), behind `describeWithPg`,
 *   where `on conflict`, a row count and a unique index are the database's
 *   answers rather than a fake's.
 *
 * ## Rules for a new case
 *
 * - **A case must be arm-independent, so it owns fresh keys.** The Postgres arm
 *   shares ONE schema across every case in the file; take every id from
 *   {@link JournalArm.uid} and never write a literal `"wrun_1"`. That is also
 *   what makes the cases safe to run twice in one process.
 * - **Assert the CONTRACT, not an implementation's incidentals.** The memory
 *   journal's `MAX_TERMINAL_RUNS` forgetting and its object-copy semantics are
 *   memory-only and stay in `workflow-journal-memory.test.ts`.
 * - **Compare with `toEqual`, never `toStrictEqual`.** `{ payload: undefined }`
 *   and `{}` are the same answer under an interface whose fields are optional,
 *   and three backends reach the two spellings by three different routes. A
 *   strict compare would fail on the spelling and say nothing about the
 *   behaviour — which is the opposite of what an absence matrix is for.
 * - **Register the backend below.** A table listing two of three arms reports
 *   the same green as one listing all three; `journal-conformance.test.ts`
 *   sweeps the tree and fails when a `workflow-journal-*.ts` factory is missing
 *   from {@link JOURNAL_BACKENDS}.
 *
 * @internal
 */

import { type JournalArm, journalRunConformance } from "./journal-conformance-cases.ts";
import { journalResumeConformance } from "./journal-conformance-resume.ts";
import { journalWaitConformance } from "./journal-conformance-waits.ts";

// The arm vocabulary is declared in the leaf case module and re-exported BY NAME
// here, so a caller wiring an arm imports one module and never has to know the
// cases were split for a line cap. Declaring it here instead would make the entry
// module and its own cases a cycle.
export { type JournalArm, journalIds, keysFor, runOf } from "./journal-conformance-cases.ts";

/**
 * One registered backend.
 *
 * Declared as a TYPE and the list ANNOTATED with it, rather than left to
 * `satisfies` the way `STORE_CONTRACTS` is. `satisfies` narrows to the literal,
 * so a field no current entry uses is not on the inferred type at all — and
 * `conformance`/`why` are exactly that: the exemption fields, absent today
 * because all three backends really are conformable. The sweep reads them, so
 * inference would make the guard-under-the-guard fail to COMPILE the moment the
 * exemption is unused, which is the moment it is least likely to be noticed.
 */
export type JournalBackend = {
  /** The backend's short name, as the report calls it. */
  backend: string;
  /** The module that declares it, relative to this package's root. */
  module: string;
  /** The factory it exports — pinned to the filename by `konsistent.json`. */
  factory: string;
  /** Which tier its arm runs in. */
  tier: "unit" | "scenario";
  /** Set when the backend is deliberately NOT conformable. */
  conformance?: false;
  /** Why not — a claim a reviewer can argue with. */
  why?: string;
};

/**
 * Every {@link JournalStore} implementation, and the tier its arm runs in.
 *
 * `module` and `factory` are what the sweep in `journal-conformance.test.ts`
 * matches the tree against, so this list is the one place a fourth backend is
 * declared. `conformance: false` says a backend is deliberately NOT conformable
 * and why — a claim a reviewer can argue with, where an absent entry is just an
 * omission.
 */
export const JOURNAL_BACKENDS: readonly JournalBackend[] = [
  {
    backend: "memory",
    module: "workflow-journal-memory.ts",
    factory: "createMemoryJournal",
    /** The reference. Unit tier, unconditionally, on every machine. */
    tier: "unit",
  },
  {
    backend: "platform",
    module: "workflow-journal-platform.ts",
    factory: "createPlatformJournal",
    /**
     * Unit tier, over the handler-shaped fake transport. The platform's SQL half
     * is out of this package's reach and has TWO arms in `aai-server`:
     * `platform-workflow-journal.scenario.test.ts` for tenancy, and
     * `journal-conformance-platform.scenario.test.ts`, which answers the shared
     * case list from the real route over a real Postgres. The second is the arm
     * this fake is structurally blind to, and it earned its place on landing: a
     * `createRun` that answered a duplicate run id with SUCCESS left the unit
     * suite at 123 passed while that arm failed the shared case, same tree, same
     * moment. See the module doc.
     */
    tier: "unit",
  },
  {
    backend: "postgres",
    module: "workflow-journal-postgres.ts",
    factory: "createPostgresJournal",
    /** Scenario tier: `on conflict`, a row count and a unique index are the point. */
    tier: "scenario",
  },
];

/**
 * The whole contract, as a list of `test()` declarations over one arm.
 *
 * All three parts, in one call, because a caller wiring up an arm should not have
 * to know the cases were split for a line cap.
 */
export function journalConformance(arm: JournalArm): void {
  journalRunConformance(arm);
  journalWaitConformance(arm);
  journalResumeConformance(arm);
}
