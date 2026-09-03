// Copyright 2026 the AAI authors. MIT license.
/**
 * The GRAMMAR: the colliding identifier pools, the weighted op shapes, and the
 * prologue every generated program starts from.
 *
 * Split from `_tenancy-ops-harness.ts` at the seam that file already had — this
 * says what a program IS, the vocabulary there says what an op and a dump ARE,
 * and `_tenancy-census-harness.ts` says what a program REACHED. All three are
 * re-exported from the ops harness, so no caller has to know which file a
 * symbol is in. The edge back to that file is TYPE-ONLY, so the re-export is
 * not a runtime cycle.
 *
 * ## Every pool is shared, and that is the whole point
 *
 * `platform-workflow-journal.ts`, `platform-uploads.ts` and
 * `platform-session-state.ts` all state the same claim — "the slug is part of
 * every primary key and every statement, so a guessed id reaches nothing". The
 * ids in question are CALLER-CHOSEN: `createRun` takes `run.runId` from the
 * guest, `claimUpload` takes the upload id, `claimHook` takes the token, and
 * session ids come off the wire. So a generator that mints a fresh id per tenant
 * proves nothing at all: it tests a world in which no two tenants ever name the
 * same row, which is exactly the world a leak needs in order to hide.
 *
 * Hence one pool per identifier kind, drawn from by BOTH slugs, and a fixed
 * {@link PROLOGUE} in two halves — a COLLIDING row of every kind under both
 * tenants, and an ASYMMETRIC set held by one tenant only. The second half is
 * what puts every "foreign" state one generated op away: without it a program
 * had to generate the writer AND the reader AND have them land in that order,
 * which made the rarest states a fraction of a percent per op and a floor on
 * them a coin toss. Forcing the collision by INSERTING a prologue rather than
 * filtering generated values keeps every drawn value legal, which is what keeps
 * shrinking well behaved.
 *
 * ## The shapes are WEIGHTED
 *
 * Twenty-three op shapes drawn uniformly make each one ~4% of a draw, and the
 * interesting states are conjunctions over a shape AND an id AND a slug — so the
 * state that catches the target leak (a terminal `setStatus` while the neighbour
 * holds a hook on the same run id) came out at about half a percent per op,
 * measured, and its negative control passed only on lucky seeds. The weights
 * buy the states, not the ops: `setStatus`, `deliverHook`, `discardSession` and
 * the upload writers are the shapes whose cross-tenant state is a conjunction,
 * so they are drawn more often.
 *
 * ## Why the payloads are JSON SCALARS
 *
 * `input`, `output`, `payload`, a slot `value` and an event `event` are all
 * `jsonb` columns, and `jsonb` NORMALIZES — `{"topic":"otters"}` is stored and
 * read back as `{"topic": "otters"}`, which every one of those modules' docs
 * records as a real divergence from an in-memory reference that preserves bytes.
 * A scalar (`1`, `"x"`) has one spelling, so the reference and the database
 * agree byte for byte and a divergence in the comparison can only ever be a
 * tenancy divergence. Pinning the normalization itself is
 * `jsonb-encoding.scenario.test.ts`'s job, not this file's.
 *
 * ## The timestamps are STAMPED, not generated
 *
 * `listRuns` orders by `created_at desc, run_id desc` and `readSteps` by
 * `finished_at, key`. A generated timestamp collides, and a tie inside one
 * tenant makes the row order a property of the database's physical layout — a
 * flake that would read as a leak. {@link label} therefore assigns a distinct
 * increasing stamp per writing op, so every ordering in play is total.
 */

import fc from "fast-check";
import type { Op } from "./_tenancy-ops-harness.ts";

/** The two tenants. Their own slugs, so nothing here is another suite's rows. */
export const SLUGS = ["tenancy-alpha", "tenancy-beta"] as const;

export type Slug = (typeof SLUGS)[number];

/**
 * Three run ids, not two: the prologue plants `wf_r0` under BOTH tenants and
 * `wf_r1` under one, so a pool of two would leave `createRun` with nothing but
 * refusals to generate.
 */
const RUN_IDS = ["wf_r0", "wf_r1", "wf_r2"] as const;
const KEYS = ["k!0", "k!1"] as const;
const TOKENS = ["tok0", "tok1", "tok2"] as const;
const UPLOAD_IDS = ["up0", "up1", "up2"] as const;
const SESSIONS = ["sess0", "sess1"] as const;
const CORRELATIONS = ["corr0", "corr1"] as const;
const WORKFLOWS = ["digest", "recap"] as const;
/** See "Why the payloads are JSON SCALARS" above. */
const SCALARS = ["1", "2", '"x"'] as const;
/**
 * No `pending`: a run is created `pending`, so generating it as a TARGET buys
 * nothing and it halved the rate of the terminal move the release CTE hangs off.
 */
const STATUSES = ["running", "completed", "failed", "cancelled"] as const;
const SLEEP_KINDS = ["sleep", "hookTimeout"] as const;

const el = <T>(xs: readonly T[]): fc.Arbitrary<T> => fc.constantFrom(...xs);
const opt = <T>(a: fc.Arbitrary<T>): fc.Arbitrary<T | undefined> =>
  fc.option(a, { nil: undefined });
/** A weighted shape. See "The shapes are WEIGHTED" above for how the numbers were picked. */
const w = (weight: number, arbitrary: fc.Arbitrary<Op>): fc.WeightedArbitrary<Op> => ({
  weight,
  arbitrary,
});

/**
 * One generated call.
 *
 * Every id is drawn from a shared pool and every op carries its own slug, so an
 * interleaving is what the generator produces naturally rather than something
 * the harness has to arrange.
 */
const opArb: fc.Arbitrary<Op> = fc.oneof(
  w(
    3,
    fc.record({
      t: fc.constant("createRun" as const),
      slug: el(SLUGS),
      runId: el(RUN_IDS),
      workflow: el(WORKFLOWS),
      input: opt(el(SCALARS)),
      createdAt: fc.constant(0),
    }),
  ),
  w(5, fc.record({ t: fc.constant("getRun" as const), slug: el(SLUGS), runId: el(RUN_IDS) })),
  w(
    1,
    fc.record({
      t: fc.constant("listRuns" as const),
      slug: el(SLUGS),
      workflow: el(WORKFLOWS),
      limit: el([1, 10]),
    }),
  ),
  w(
    7,
    fc.record({
      t: fc.constant("setStatus" as const),
      slug: el(SLUGS),
      runId: el(RUN_IDS),
      status: el(STATUSES),
      result: opt(el([{ output: "1" }, { error: "boom" }])),
      expect: opt(el([["pending"], ["running"], ["pending", "running"]])),
    }),
  ),
  w(
    3,
    fc.record({
      t: fc.constant("appendStep" as const),
      slug: el(SLUGS),
      runId: el(RUN_IDS),
      key: el(KEYS),
      status: el(["completed", "failed"]),
      output: opt(el(SCALARS)),
      finishedAt: fc.constant(0),
    }),
  ),
  w(3, fc.record({ t: fc.constant("readSteps" as const), slug: el(SLUGS), runId: el(RUN_IDS) })),
  w(
    3,
    fc.record({
      t: fc.constant("claimAttempt" as const),
      slug: el(SLUGS),
      runId: el(RUN_IDS),
      key: el(KEYS),
      // A charge is a LEASE held by a WALK, so which walk is claiming is part of
      // the operation. Drawn from a SMALL pool on purpose: what makes the answer
      // interesting is two walks colliding on one key and one walk re-claiming
      // its own charge, and a fresh id per op would generate neither.
      holder: el(["walk-1", "walk-2"] as const),
    }),
  ),
  w(
    2,
    fc.record({
      t: fc.constant("claimSleep" as const),
      slug: el(SLUGS),
      runId: el(RUN_IDS),
      key: el(KEYS),
      wakeAt: el([1, 2, 3]),
      correlationId: opt(el(CORRELATIONS)),
      kind: el(SLEEP_KINDS),
    }),
  ),
  w(
    3,
    fc.record({
      t: fc.constant("wakeSleeps" as const),
      slug: el(SLUGS),
      runId: el(RUN_IDS),
      now: el([0, 1, 2]),
      correlationIds: opt(el([[CORRELATIONS[0]], [CORRELATIONS[1]], [...CORRELATIONS]])),
    }),
  ),
  w(
    3,
    fc.record({
      t: fc.constant("claimHook" as const),
      slug: el(SLUGS),
      runId: el(RUN_IDS),
      key: el(KEYS),
      token: el(TOKENS),
    }),
  ),
  w(
    6,
    fc.record({
      t: fc.constant("deliverHook" as const),
      slug: el(SLUGS),
      token: el(TOKENS),
      payload: opt(el(SCALARS)),
    }),
  ),
  w(
    2,
    fc.record({
      t: fc.constant("closeHook" as const),
      slug: el(SLUGS),
      runId: el(RUN_IDS),
      key: el(KEYS),
    }),
  ),
  w(
    2,
    fc.record({
      t: fc.constant("claimUpload" as const),
      slug: el(SLUGS),
      id: el(UPLOAD_IDS),
      name: el(["a.wav", "b.wav"]),
      expected: opt(el([0, 8])),
    }),
  ),
  w(
    1,
    fc.record({
      t: fc.constant("insertUpload" as const),
      slug: el(SLUGS),
      id: el(UPLOAD_IDS),
      name: el(["a.wav", "b.wav"]),
      size: el([0, 4]),
    }),
  ),
  w(
    5,
    fc.record({
      t: fc.constant("updateUpload" as const),
      slug: el(SLUGS),
      id: el(UPLOAD_IDS),
      size: el([1, 4]),
      complete: fc.boolean(),
    }),
  ),
  w(
    3,
    fc.record({
      t: fc.constant("finishUpload" as const),
      slug: el(SLUGS),
      id: el(UPLOAD_IDS),
      size: el([2, 6]),
    }),
  ),
  w(1, fc.record({ t: fc.constant("readUpload" as const), slug: el(SLUGS), id: el(UPLOAD_IDS) })),
  w(
    2,
    fc.record({
      t: fc.constant("commitSlots" as const),
      slug: el(SLUGS),
      sessionId: el(SESSIONS),
      values: el([
        { cart: "1" },
        { caller: "2" },
        { cart: '"x"', caller: "1" },
        {} as Record<string, string>,
      ]),
    }),
  ),
  w(
    1,
    fc.record({ t: fc.constant("loadSlots" as const), slug: el(SLUGS), sessionId: el(SESSIONS) }),
  ),
  w(
    2,
    fc.record({
      t: fc.constant("appendEvents" as const),
      slug: el(SLUGS),
      sessionId: el(SESSIONS),
      events: el([
        [{ index: 0, event: "1" }],
        [{ index: 1, event: "2" }],
        [
          { index: 0, event: '"x"' },
          { index: 2, event: "1" },
        ],
      ]),
    }),
  ),
  w(
    1,
    fc.record({
      t: fc.constant("readEvents" as const),
      slug: el(SLUGS),
      sessionId: el(SESSIONS),
      startIndex: el([0, 1]),
      limit: el([1, 10]),
    }),
  ),
  w(
    1,
    fc.record({
      t: fc.constant("nextEventIndex" as const),
      slug: el(SLUGS),
      sessionId: el(SESSIONS),
    }),
  ),
  w(
    3,
    fc.record({
      t: fc.constant("discardSession" as const),
      slug: el(SLUGS),
      sessionId: el(SESSIONS),
    }),
  ),
);

const [A, B] = SLUGS;

/** The colliding half: a row of every kind under BOTH tenants, same ids. */
const COLLIDING: readonly Op[] = [
  { t: "createRun", slug: A, runId: "wf_r0", workflow: "digest", input: "1", createdAt: 0 },
  { t: "createRun", slug: B, runId: "wf_r0", workflow: "digest", input: "2", createdAt: 0 },
  { t: "claimHook", slug: A, runId: "wf_r0", key: "k!0", token: "tok0" },
  { t: "claimHook", slug: B, runId: "wf_r0", key: "k!0", token: "tok0" },
  // A hook on a SECOND colliding run id, so the terminal-release state does not
  // hinge on one draw out of three. `(slug, token)` is unique, not `token`, so
  // both tenants may hold `tok1`.
  { t: "claimHook", slug: A, runId: "wf_r1", key: "k!1", token: "tok1" },
  { t: "claimHook", slug: B, runId: "wf_r1", key: "k!1", token: "tok1" },
  { t: "claimAttempt", slug: A, runId: "wf_r0", key: "k!0", holder: "walk-1" },
  { t: "claimAttempt", slug: B, runId: "wf_r0", key: "k!0", holder: "walk-1" },
  {
    t: "claimSleep",
    slug: A,
    runId: "wf_r0",
    key: "k!0",
    wakeAt: 3,
    correlationId: "corr0",
    kind: "sleep",
  },
  {
    t: "claimSleep",
    slug: B,
    runId: "wf_r0",
    key: "k!0",
    wakeAt: 3,
    correlationId: "corr0",
    kind: "sleep",
  },
  {
    t: "appendStep",
    slug: A,
    runId: "wf_r0",
    key: "k!0",
    status: "completed",
    output: "1",
    finishedAt: 0,
  },
  {
    t: "appendStep",
    slug: B,
    runId: "wf_r0",
    key: "k!0",
    status: "completed",
    output: "2",
    finishedAt: 0,
  },
  { t: "claimUpload", slug: A, id: "up0", name: "a.wav", expected: 8 },
  { t: "claimUpload", slug: B, id: "up0", name: "b.wav", expected: 8 },
  { t: "commitSlots", slug: A, sessionId: "sess0", values: { cart: "1" } },
  { t: "commitSlots", slug: B, sessionId: "sess0", values: { cart: "2" } },
  { t: "appendEvents", slug: A, sessionId: "sess0", events: [{ index: 0, event: "1" }] },
  { t: "appendEvents", slug: B, sessionId: "sess0", events: [{ index: 0, event: "2" }] },
];

/**
 * The asymmetric half: a row of every kind held by ONE tenant only.
 *
 * This is what makes every "foreign" state — a read, a write or a delete aimed
 * at an id only the neighbour holds — reachable in a single generated op.
 */
const LOPSIDED: readonly Op[] = [
  { t: "createRun", slug: A, runId: "wf_r1", workflow: "recap", input: '"x"', createdAt: 0 },
  // The mirror image, so a foreign read is reachable from EITHER side rather
  // than only from B.
  { t: "createRun", slug: B, runId: "wf_r2", workflow: "recap", input: "2", createdAt: 0 },
  { t: "claimHook", slug: A, runId: "wf_r2", key: "k!0", token: "tok2" },
  { t: "claimAttempt", slug: A, runId: "wf_r1", key: "k!1", holder: "walk-2" },
  {
    t: "claimSleep",
    slug: A,
    runId: "wf_r1",
    key: "k!1",
    wakeAt: 3,
    correlationId: "corr1",
    kind: "sleep",
  },
  {
    t: "appendStep",
    slug: A,
    runId: "wf_r1",
    key: "k!1",
    status: "failed",
    output: undefined,
    finishedAt: 0,
  },
  { t: "claimUpload", slug: A, id: "up1", name: "a.wav", expected: undefined },
  { t: "claimUpload", slug: B, id: "up2", name: "b.wav", expected: 0 },
  { t: "commitSlots", slug: A, sessionId: "sess1", values: { caller: "1" } },
  { t: "appendEvents", slug: A, sessionId: "sess1", events: [{ index: 0, event: "1" }] },
];

/** Both halves. A run in which the tenants never collided proves nothing. */
export const PROLOGUE: readonly Op[] = [...COLLIDING, ...LOPSIDED];

/** Distinct increasing stamps for every ordering key — see the module doc. */
export function label(ops: readonly Op[]): Op[] {
  let stamp = 0;
  return ops.map((op) => {
    if (op.t === "createRun") return { ...op, createdAt: ++stamp };
    if (op.t === "appendStep") return { ...op, finishedAt: ++stamp };
    return op;
  });
}

/** The prologue plus a generated interleaving, stamped. */
export const programArb: fc.Arbitrary<Op[]> = fc
  .array(opArb, { minLength: 3, maxLength: 18 })
  .map((generated) => label([...PROLOGUE, ...generated]));
