// Copyright 2026 the AAI authors. MIT license.
/**
 * ONE {@link JournalStore} contract, asserted ONCE, over every backend a run
 * really journals into.
 *
 * This is `aai-server/store-conformance.ts` a second time, deliberately: read
 * that file first — it carries the argument for the pattern, and nothing here
 * restates it. What this module adds is the registry and the two helpers; the
 * cases themselves are {@link journalRunConformance},
 * {@link journalStepConformance},
 * {@link journalCodecConformance}, {@link journalWaitConformance} and
 * {@link journalResumeConformance}, split for the file-length cap at seams the
 * platform's own store already splits on
 * (`platform-workflow-journal-hooks.ts`): a run, its steps and its attempts
 * answer "what has this run DONE", the sleeps and hooks answer "may this wait
 * still be answered", and the codec cases answer "did the run get back what
 * the step returned" — the one group whose subject is neither the interface nor
 * any backend's SQL, which is why it is the seam the third split landed on.
 *
 * ## Why the journal needed its own table rather than joining that one
 *
 * `STORE_CONTRACTS` registers `workflow-journal` with `conformance: false` and a
 * reason — "one case list cannot span the boundary" — and the reason is true of
 * THAT table: it lives in `aai-server`, and `aai-runtime` may not import it.
 * What it is not is a reason for the contract to go unparried, which is how
 * three implementations of one interface came to be checked by three unrelated
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
 * - **Register the backend below, AND every file that answers over it.** A table
 *   listing two of three arms reports the same green as one listing all three;
 *   `journal-conformance.test.ts` sweeps the tree and fails when a
 *   `workflow-journal-*.ts` factory is missing from {@link JOURNAL_BACKENDS},
 *   and `journal-conformance-arms.test.ts` fails when a declared
 *   {@link JournalArmSite} does not exist, does not invoke the case list, or
 *   sits in a tier other than the one it claims. The second gate is the newer
 *   one and it closed a real hole: the `aai-server` arm was named in a doc
 *   comment and registered nowhere, so deleting it left every gate in the repo
 *   green but one, and that one reported the wrong finding about the wrong file.
 * - **An arm DECLARES what it can do, and the ten `resumableRuns` cases are
 *   the only conditional ones.** {@link JournalArm.resumable} is required, read
 *   at collection time, and drives a reported skip; a case that decides its own
 *   applicability in its BODY and `return`s prints a green checkmark over an
 *   empty test. That is what those ten used to do on both platform arms.
 *
 * @internal
 */

import { type JournalArm, journalRunConformance } from "./journal-conformance-cases.ts";
import { journalCodecConformance } from "./journal-conformance-codec.ts";
import { journalResumeConformance } from "./journal-conformance-resume.ts";
import { journalStepConformance } from "./journal-conformance-steps.ts";
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
  /**
   * Every file that answers the shared case list over this backend.
   *
   * This replaced a single `tier: "unit" | "scenario"`, and the platform entry
   * is why. A backend may have arms in more than one tier AND in more than one
   * PACKAGE — the platform's fake-transport arm is here, and the arm that finds
   * platform bugs is `aai-server`'s, which this package cannot import. `tier`
   * could describe only one of them, so the second lived in the entry's PROSE:
   * named in a doc comment, registered nowhere, asserted by nothing.
   *
   * Deleting that file therefore cost no gate anything it could name. (One went
   * red by ACCIDENT — `store-conformance-registry.test.ts` scans for exported
   * `*Conformance` names reached from a test, and `loadJournalConformance`'s
   * only call site is that arm — so the finding read "loadJournalConformance is
   * reached from a test: expected false to be true", which is the wrong finding
   * about the wrong file, and evaporates the moment a second caller appears or
   * the loader is renamed.)
   *
   * A path is relative to `packages/`, so an arm a package away is as declared
   * as one beside the registry, and `journal-conformance-arms.test.ts` reads
   * every one of them out of the tree.
   */
  arms: readonly JournalArmSite[];
  /** Set when the backend is deliberately NOT conformable. */
  conformance?: false;
  /** Why not — a claim a reviewer can argue with. */
  why?: string;
};

/** One file that runs the shared case list over one backend. */
export type JournalArmSite = {
  /** The test file, relative to `packages/`. */
  file: string;
  /** Which tier it runs in — checked against the filename, not trusted. */
  tier: "unit" | "scenario";
  /** What this arm can see that its siblings cannot. */
  sees: string;
};

/**
 * Every {@link JournalStore} implementation, and every FILE that answers the
 * shared case list over it.
 *
 * `module` and `factory` are what the sweep in `journal-conformance.test.ts`
 * matches the tree against, so this list is the one place a fourth backend is
 * declared; `arms` is what `journal-conformance-arms.test.ts` reads, and is the
 * one place an arm — in this package or a package over — is declared.
 * `conformance: false` says a backend is deliberately NOT conformable and why —
 * a claim a reviewer can argue with, where an absent entry is just an omission.
 */
export const JOURNAL_BACKENDS: readonly JournalBackend[] = [
  {
    backend: "memory",
    module: "workflow-journal-memory.ts",
    factory: "createMemoryJournal",
    arms: [
      {
        file: "aai-runtime/src/journal-conformance.test.ts",
        tier: "unit",
        sees: "the reference, unconditionally, on every machine",
      },
    ],
  },
  {
    backend: "platform",
    module: "workflow-journal-platform.ts",
    factory: "createPlatformJournal",
    arms: [
      {
        file: "aai-runtime/src/journal-conformance.test.ts",
        tier: "unit",
        sees: "THIS side of the wire — the codec, `toRun`/`toStep`, the count-as-string — over a handler-shaped fake transport that delegates every SEMANTIC to the memory reference",
      },
      {
        // The arm that finds platform bugs, and the one a `tier` field could not
        // name. It earned its place on landing: a `createRun` that answered a
        // duplicate run id with SUCCESS left the unit suite at 123 passed while
        // this arm failed the shared case, same tree, same moment.
        file: "aai-server/src/journal-conformance-platform.scenario.test.ts",
        tier: "scenario",
        sees: "the platform's OWN statements — the real route, the guest bearer, and the tables under `aai_platform`",
      },
    ],
  },
  {
    backend: "postgres",
    module: "workflow-journal-postgres.ts",
    factory: "createPostgresJournal",
    arms: [
      {
        file: "aai-runtime/src/journal-conformance-postgres.scenario.test.ts",
        tier: "scenario",
        sees: "`on conflict`, a row count and a unique index as the database's answers rather than a fake's",
      },
    ],
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
  journalStepConformance(arm);
  journalCodecConformance(arm);
  journalWaitConformance(arm);
  journalResumeConformance(arm);
}
