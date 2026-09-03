// Copyright 2026 the AAI authors. MIT license.
/**
 * ONE {@link SessionStateBackend} contract, asserted ONCE, over every backend a
 * session's durable state really lands in.
 *
 * This is `journal-conformance.ts` a second time and `aai-server`'s
 * `store-conformance.ts` a third: read either for the argument behind the
 * pattern, which is not restated here. What this module adds is the registry and
 * the entry point; the cases are `session-state-conformance-slots.ts` (`load`,
 * `commit`, `discard`) and `session-state-conformance-events.ts`
 * (`appendEvents`, `readEvents`, `countEvents`), split for the file-length cap at
 * the seam the interface itself splits on — its own doc calls slots and the
 * event log "two consumers, one backend".
 *
 * ## Why this contract needed a table
 *
 * Because the requirement was written down twice, in prose, as a claim BETWEEN
 * implementations — which is the strongest available signal that nothing checks
 * it:
 *
 * - `session-state-store.ts`: "**Both backends must answer `max + 1`, or the
 *   memory one stops being a valid double for the Postgres one.**"
 * - `session-state-platform.ts`: "the memory one is only a valid test double for
 *   the other because all of them agree."
 *
 * Nothing compared them. `session-state-postgres.test.ts` is an SQL-TEXT
 * recorder (which statements, against which table — a real question, and not
 * this one); `session-state-platform.test.ts` is an HTTP recorder; and the
 * SEMANTICS were asserted for the memory backend only, through the cache above
 * it in `session-state-store.test.ts`. Five suites over three implementations of
 * six methods, sharing no assertion.
 *
 * On its first run the table found the divergence that shape predicts, and it
 * was an edge case about ABSENCE exactly like all five the journal's table
 * found: the memory backend's `appendEvents` was an UPSERT where both databases
 * are `on conflict … do nothing`, so a re-appended index replaced the stored
 * event in the reference and kept it everywhere else. The one code path a retry
 * exists for. Fixed in `session-state-memory.ts`.
 *
 * ## Three backends, FOUR arms, and what each can SEE
 *
 * - **memory** — the reference, in the UNIT tier, unconditionally. A backend
 *   that disagrees with it has a bug unless the interface is what is wrong.
 * - **platform** — in the UNIT tier, over the fake transport in
 *   `session-state-conformance.test.ts`. That fake parses exactly what
 *   `aai-server/session-state-handler.ts` parses and delegates every SEMANTIC to
 *   the reference backend, so the arm tests THIS side of the wire: the request
 *   shapes, `toSlotMap`, `toEvents`, the count-as-a-number refusal. **It cannot
 *   see the platform's own SQL**, and that is the arm's honest limit rather than
 *   an oversight — see "The FOURTH arm" below.
 * - **postgres** — in the SCENARIO tier
 *   (`session-state-conformance-postgres.scenario.test.ts`), behind
 *   `describeWithPg`, where `jsonb`, `on conflict do nothing`, `order by` and a
 *   `bigint` column are the database's answers rather than a fake's.
 * - **platform over the REAL route** — in the SCENARIO tier, in `aai-server`
 *   (`session-state-conformance-platform.scenario.test.ts`). See below.
 *
 * ## The FOURTH arm is the platform's own SQL, and it lives in `aai-server`
 *
 * `platform-session-state.ts`'s statements are invisible to the three arms
 * above, and the journal's table proves that is where a real bug hides: its
 * `createRun` was `on conflict do nothing`, so the platform silently accepted a
 * duplicate run id while the fake-transport arm sat green, and only
 * `aai-server/journal-conformance-platform.scenario.test.ts` — the same case
 * list over the REAL route and a real Postgres — turned it red.
 *
 * That arm exists here now, by the same mechanism:
 * `loadSessionStateConformance()` on `@alexkroman1/aai-runtime/internal` carries
 * this case list across the boundary (`aai-server` imports this package; never
 * the reverse), and it is a LOADER rather than a re-export clause because the
 * case modules import `vitest` — the measurement is in that file.
 *
 * **It found no divergence on the day it landed**, unlike the journal's, which
 * is a fact about `platform-session-state.ts` rather than about the arm. What it
 * did do is take three claims out of the "nothing checks this" column, each
 * A/B'd by reverting the platform's SQL: dropping the `Number()` in
 * `nextEventIndex` (postgres.js hands a `bigint` back as a STRING, and the
 * client refuses a non-number rather than coercing it) reddens **six** cases;
 * turning the append's `on conflict … do nothing` into an upsert reddens **two**;
 * making the commit's upsert a `do nothing` and the read's `>=` exclusive
 * reddens **nine**. The `discard` reach and the `jsonb` normalization named
 * below are pinned there directly, because the shared cases deliberately do not.
 *
 * ## Rules for a new case
 *
 * - **A case must be arm-independent, so it owns a fresh session id.** The
 *   Postgres arm shares ONE schema and the platform arm ONE reference backend
 *   across every case in a file; take every id from {@link SessionStateArm.uid}
 *   and never write a literal `"s1"`. That is also what makes the cases safe to
 *   run twice in one process.
 * - **Compare MEANING, not bytes** — `meaningOf`, `meaningOfEvents`. Both
 *   databases hold `jsonb`, which normalizes; the memory backend preserves the
 *   string it was handed. The consumers above all parse, so a byte comparison
 *   would fail on a storage engine's spelling and say nothing about behaviour.
 * - **Assert the CONTRACT, not an implementation's incidentals.** `name`,
 *   `durable`, which statements a backend issues and what it does with an
 *   unreadable HTTP answer are per-backend claims and stay in the three
 *   per-backend specs, which is why none of them is redundant with this.
 * - **Register the backend below.** A table listing two of three arms reports
 *   the same green as one listing all three;
 *   `session-state-conformance.test.ts` sweeps the tree and fails when a
 *   `create*StateBackend` factory is missing from {@link SESSION_STATE_BACKENDS}.
 *
 * ## `discard` reclaims BOTH — decided, and now a shared case
 *
 * This was the table's headline "does NOT assert" entry, and it is worth keeping
 * the account because the entry is exactly what let the divergence sit. Memory
 * dropped slots and events together, the platform route dropped both in one
 * CTE, and `session-state-postgres.ts` dropped SLOTS ONLY — under an interface
 * sentence that said `discard` "reclaims what the backend is ALLOWED to
 * reclaim, which is not always both". So three implementations gave two answers,
 * nothing failed, and the disagreement was documented rather than tested.
 *
 * The asymmetry had already lost its mechanism: it was justified by an
 * append-only GRANT on a per-app role (`grantSessionTables`), that role went
 * with per-app databases, and what `provisionAppDatabase` issues today is
 * `select, insert, update, delete` on both tables. What was left was a word
 * meaning two things — the same agent's ended session keeping a readable log for
 * up to the retention window on a self-hosted database and losing it
 * immediately on the platform, which a caller cannot act on and which no diff
 * shows.
 *
 * **Decided: the platform's behaviour is the contract, and Postgres was the
 * outlier.** The event log is a debugging convenience rather than a record
 * anything reads back, so a `discard` that keeps it buys nothing and costs the
 * word its meaning. Two shared cases assert it — `discard drops this session's
 * EVENT LOG too` and `discard drops NOBODY else's event log` — which means every
 * arm answers them, the real-route one included. Verified red-then-green: the
 * first case failed on the Postgres arm alone and passes now; the platform arm
 * asserted nothing contradictory, having reclaimed both all along. The retention
 * sweep stays as the backstop for a session whose guest died before it
 * discarded, and there is no migration for existing rows because none are
 * deployed.
 *
 * ## What the table does NOT assert, and why
 *
 * Three points where the backends really differ. A conformance table can only
 * assert what the interface promises, so each is named here instead of being
 * silently decided by whichever backend a case happened to be written against.
 * **A fourth used to head this list and is the section above** — read the two
 * together, because "named as underspecified" is what a decision looks like
 * before somebody makes it, and the entries below are candidates for the same
 * treatment rather than settled law.
 *
 * - **What happens to a value that is not JSON.** Both databases cast to
 *   `jsonb` and refuse (`22P02`); memory stores any string. Nothing above this
 *   seam can produce one — every value arrives from `JSON.stringify` — and the
 *   refusal is the whole reason the column is `jsonb` rather than `text`
 *   (a check the process above cannot fake), so mandating either answer would
 *   either weaken the column or ask memory to validate JSON it was handed. Left
 *   under-specified, out loud.
 * - **Two events carrying the SAME index in ONE `appendEvents` call.** Not
 *   reachable: indices come from a synchronous counter one at a time. Asserting
 *   it would pin a driver's behaviour on a conflict arbiter's speculative
 *   insertion, which is not a promise this interface makes.
 * - **An EMPTY `sessionId`.** The platform route reads it with
 *   `requiredString`, which refuses `""` with a 400; both other backends store
 *   and read it as an ordinary key. Unreachable — every id is minted — and the
 *   route's refusal is the stricter, better answer, so no case pins either.
 * - **Byte-exact serialization**, per the comparison rule above.
 *
 * @internal
 */

import { sessionStateEventConformance } from "./session-state-conformance-events.ts";
import {
  type SessionStateArm,
  sessionStateSlotConformance,
} from "./session-state-conformance-slots.ts";

// The arm vocabulary is declared in the leaf case module and re-exported BY NAME
// here, so a caller wiring an arm imports one module and never has to know the
// cases were split for a line cap. Declaring it here instead would make the
// entry module and its own cases a cycle.
export {
  json,
  meaningOf,
  meaningOfEvents,
  type SessionStateArm,
  sessionStateIds,
  slots,
} from "./session-state-conformance-slots.ts";

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
export type SessionStateBackendEntry = {
  /** The backend's short name — the `name` field it reports about itself. */
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
 * Every {@link SessionStateBackend} implementation, and the tier its arm runs in.
 *
 * `module` and `factory` are what the sweep in
 * `session-state-conformance.test.ts` matches the tree against, so this list is
 * the one place a fourth backend is declared. `conformance: false` says a
 * backend is deliberately NOT conformable and why — a claim a reviewer can argue
 * with, where an absent entry is just an omission.
 */
export const SESSION_STATE_BACKENDS: readonly SessionStateBackendEntry[] = [
  {
    backend: "memory",
    module: "session-state-memory.ts",
    factory: "createMemoryStateBackend",
    /** The reference. Unit tier, unconditionally, on every machine. */
    tier: "unit",
  },
  {
    backend: "platform",
    module: "session-state-platform.ts",
    factory: "createPlatformStateBackend",
    /**
     * Unit tier, over the handler-shaped fake transport. The platform's SQL half
     * is out of this package's reach and has TWO arms in `aai-server`:
     * `platform-session-state.scenario.test.ts`, which covers those statements
     * one at a time, and `session-state-conformance-platform.scenario.test.ts`,
     * which answers THIS case list from the real route over a real Postgres.
     * The second is the arm this fake is structurally blind to — see "The FOURTH
     * arm" above.
     */
    tier: "unit",
  },
  {
    backend: "postgres",
    module: "session-state-postgres.ts",
    factory: "createPostgresStateBackend",
    /** Scenario tier: `jsonb`, `on conflict do nothing` and a `bigint` are the point. */
    tier: "scenario",
  },
];

/**
 * The whole contract, as a list of `test()` declarations over one arm.
 *
 * Both halves, in one call, because a caller wiring up an arm should not have to
 * know the cases were split for a line cap.
 */
export function sessionStateConformance(arm: SessionStateArm): void {
  sessionStateSlotConformance(arm);
  sessionStateEventConformance(arm);
}
