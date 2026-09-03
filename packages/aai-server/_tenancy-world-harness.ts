// Copyright 2026 the AAI authors. MIT license.
/**
 * The tenant-partitioned REFERENCE world, the deliberately leaky variants of
 * it, and the check that walks an arm and the reference through one program.
 *
 * The per-store semantics live next door — `_tenancy-journal-harness.ts` for
 * the twelve journal methods, `_tenancy-state-harness.ts` for uploads and
 * session state. What is here is the part that makes the world a WORLD: the
 * per-slug buckets, which bucket each predicate resolves against, and the
 * step-by-step comparison.
 *
 * ## The oracle is the MODEL, not a sibling implementation
 *
 * This matters enough to say plainly, because the usual differential trap does
 * not apply here and it would be easy to assume it does. A property that
 * compares two implementations is blind to any defect they share — both sides
 * wrong the same way, property green. This world is not an implementation of the
 * platform's SQL. It is a `Map<slug, Tables>`: a row physically lives INSIDE the
 * bucket of the tenant that wrote it, and every applier is handed exactly one
 * bucket. A cross-tenant read, mutation or delete is therefore not merely absent
 * from it — it is UNREPRESENTABLE, so the reference cannot mirror a tenancy leak
 * however the SQL is written. The invariant is true of the model by
 * construction, which is what makes the model the definition of the invariant
 * rather than a second opinion about it.
 *
 * The cost of that choice is the other direction: the reference must also
 * reproduce each method's SEMANTICS (`createRun`'s refusal, `setStatus`'s
 * compare-and-set, `appendStep`'s first-write-wins, `claimHook`'s `union all`
 * over a pre-statement snapshot), and a mistake there shows up as a divergence.
 * That is the safe failure — a false RED, never a false green — and every
 * semantic next door names the statement it mirrors.
 *
 * ## The leaky variants are the property's own non-vacuity proof
 *
 * {@link Leak} names six ways to lose a tenancy predicate, each modelled on a
 * real line of the code under test — most importantly `hook-release`, which is
 * `setStatus`'s `released` CTE losing its `h.slug = $1`. That is the leak a text
 * gate structurally cannot see, because the statement still carries `slug = $1`
 * on its `moved` arm afterwards. `platform-tenancy.test.ts` asserts the property FAILS
 * against each one, in the unit tier, with no database — so the discrimination
 * the scenario arm depends on is proven on every CI run rather than once by
 * hand.
 */

import { isRecord } from "@alexkroman1/aai/utils";
import {
  applyHookOp,
  applyRunOp,
  applyStepOp,
  type HookOp,
  type RunOp,
  type StepOp,
  type Tables,
  type Targets,
} from "./_tenancy-journal-harness.ts";
import {
  type Answer,
  type Census,
  noteAnswer,
  noteOp,
  type Op,
  SLUGS,
  type Slug,
  sortTenantDump,
  type TenantDump,
} from "./_tenancy-ops-harness.ts";
import {
  applySessionOp,
  applyUploadOp,
  type SessionOp,
  type UploadOp,
} from "./_tenancy-state-harness.ts";

/** Both arms answer this, so one check can drive either. */
export type TenancyStore = {
  /** Empty both tenants. Called per property run, including every shrink. */
  reset(): Promise<void>;
  apply(op: Op): Promise<Answer>;
  dumpAll(): Promise<Record<Slug, TenantDump>>;
};

/**
 * A tenancy predicate deliberately dropped, each one a real line of the code
 * under test.
 *
 * `flat` is the whole-world control (one shared bucket, every statement blind).
 * The other five are surgical, and they are the interesting ones: a property
 * that only catches a totally slug-blind store is not evidence about a store
 * that lost ONE predicate.
 */
export type Leak =
  | "flat"
  | "hook-release"
  | "hook-delivery"
  | "attempt-conflict"
  | "session-discard"
  | "run-read";

/** Where one divergence was found. Returned rather than asserted — see below. */
export type Divergence = {
  at: number;
  op: Op;
  /** `"answered"` for the call's own answer, or `"tenant <slug>'s rows"`. */
  what: string;
  expected: unknown;
  actual: unknown;
};

const emptyTables = (): Tables => ({
  runs: new Map(),
  steps: new Map(),
  attempts: new Map(),
  holders: new Map(),
  sleeps: new Map(),
  hooks: new Map(),
  uploads: new Map(),
  slots: new Map(),
  events: new Map(),
});

/**
 * Which family an op belongs to, as sets rather than a 23-case dispatch switch.
 *
 * The membership lists have to agree with the `Extract` unions next door, and
 * the appliers' `default` arms are what say so out loud: a `t` that reaches the
 * wrong applier throws naming the model rather than answering something
 * plausible.
 */
const RUN_OPS: ReadonlySet<Op["t"]> = new Set(["createRun", "getRun", "listRuns", "setStatus"]);
const STEP_OPS: ReadonlySet<Op["t"]> = new Set([
  "appendStep",
  "readSteps",
  "claimAttempt",
  "claimSleep",
  "wakeSleeps",
]);
const HOOK_OPS: ReadonlySet<Op["t"]> = new Set(["claimHook", "deliverHook", "closeHook"]);
const UPLOAD_OPS: ReadonlySet<Op["t"]> = new Set([
  "claimUpload",
  "insertUpload",
  "updateUpload",
  "finishUpload",
  "readUpload",
]);

export const isRunOp = (op: Op): op is RunOp => RUN_OPS.has(op.t);
export const isStepOp = (op: Op): op is StepOp => STEP_OPS.has(op.t);
export const isHookOp = (op: Op): op is HookOp => HOOK_OPS.has(op.t);
export const isUploadOp = (op: Op): op is UploadOp => UPLOAD_OPS.has(op.t);

const dump = (t: Tables): TenantDump =>
  sortTenantDump({
    runs: [...t.runs.values()].map((row) => ({ ...row })),
    steps: [...t.steps.values()].map(({ name: _name, error: _error, ...row }) => ({ ...row })),
    attempts: [...t.attempts.values()].map((row) => ({ ...row })),
    sleeps: [...t.sleeps.values()].map((row) => ({ ...row })),
    hooks: [...t.hooks.values()].map((row) => ({ ...row })),
    uploads: [...t.uploads.values()].map((row) => ({ ...row, parts: [...row.parts] })),
    slots: [...t.slots.values()].map((row) => ({ ...row })),
    events: [...t.events.values()].map((row) => ({ ...row })),
  });

/**
 * The reference, or a variant of it with one predicate dropped.
 *
 * @param leak - which tenancy predicate to lose; omitted for the reference.
 */
export function createReferenceWorld(leak?: Leak): TenancyStore {
  let world = new Map<Slug, Tables>();
  let shared = emptyTables();

  const build = (): void => {
    world = new Map(SLUGS.map((slug) => [slug, emptyTables()]));
    shared = emptyTables();
  };
  build();

  /** The one bucket a method may touch — or the shared one, under `flat`. */
  const own = (slug: Slug): Tables => {
    if (leak === "flat") return shared;
    const tables = world.get(slug);
    if (!tables) throw new Error(`tenancy reference has no bucket for ${slug}`);
    return tables;
  };

  /** Own bucket first, then the rest — the HARDER shape for a leak to hide in. */
  const widened = (t: Tables): Tables[] => [t, ...SLUGS.map(own).filter((x) => x !== t)];
  /** For the reference, every predicate resolves against this tenant and nothing else. */
  const targetsFor = (t: Tables): Targets => ({
    runRead: leak === "run-read" ? widened(t) : [],
    hookRelease: leak === "hook-release" ? widened(t) : [t],
    hookDelivery: leak === "hook-delivery" ? widened(t) : [t],
    attempts: leak === "attempt-conflict" ? shared : t,
    events: leak === "session-discard" ? widened(t) : [t],
  });

  const apply = (op: Op): Answer => {
    const t = own(op.slug);
    const targets = targetsFor(t);
    if (isRunOp(op)) return applyRunOp(t, op, targets);
    if (isStepOp(op)) return applyStepOp(t, op, targets);
    if (isHookOp(op)) return applyHookOp(t, op, targets);
    if (isUploadOp(op)) return applyUploadOp(t, op);
    return applySessionOp(t, op satisfies SessionOp, targets.events);
  };

  return {
    reset: async () => {
      build();
    },
    apply: async (op) => apply(op),
    dumpAll: async () => {
      const out = {} as Record<Slug, TenantDump>;
      for (const slug of SLUGS) out[slug] = dump(own(slug));
      return out;
    },
  };
}

/**
 * Walk one arm and the reference through the same program, checking the
 * partition after EVERY step, and answer the first divergence.
 *
 * Two checks per step, and both are needed:
 *
 * - the ANSWER, which is what catches a read that returned a neighbour's row
 *   (including a refusal that named a neighbour's run);
 * - the whole per-tenant DUMP, which is what catches a write or a DELETE that
 *   landed in a neighbour's rows even though nobody has read it back yet. The
 *   target leak — `setStatus` releasing every tenant's hooks on a colliding run
 *   id — is exactly this shape, and a property that only compared answers would
 *   need the victim to happen to read afterwards.
 *
 * It RETURNS the divergence rather than asserting it, so the `expect` lives
 * inside the property body where it belongs (and where Biome's
 * `noMisplacedAssertion` insists it live). {@link explain} turns one into the
 * failure message.
 */
export async function checkPartition(
  store: TenancyStore,
  ops: readonly Op[],
  seen: Census,
): Promise<Divergence | undefined> {
  await store.reset();
  const reference = createReferenceWorld();
  await reference.reset();

  for (const [at, op] of ops.entries()) {
    // The census reads the REFERENCE's state, so a leaking arm cannot talk its
    // own coverage up.
    noteOp(seen, await reference.dumpAll(), op);
    const expected = await reference.apply(op);
    const actual = await store.apply(op);
    if (!same(expected, actual)) return { at, op, what: "answered", expected, actual };
    noteAnswer(seen, expected);

    const wantDump = await reference.dumpAll();
    const gotDump = await store.dumpAll();
    for (const slug of SLUGS) {
      if (same(wantDump[slug], gotDump[slug])) continue;
      return {
        at,
        op,
        what: `tenant ${slug}'s rows`,
        expected: wantDump[slug],
        actual: gotDump[slug],
      };
    }
  }
  return undefined;
}

/**
 * One value in a shape two arms can be compared in.
 *
 * Object keys SORTED and `undefined` entries dropped; array order preserved,
 * because ordering is part of the contract (`listRuns` is newest-first,
 * `readSteps` is by `finished_at`) and the dumps are already canonically sorted
 * by `sortTenantDump`. Both halves earn their place: `loadSlots` answers a
 * RECORD built by iterating rows, so its key order is the driver's on one arm
 * and a `Map`'s on the other; and `exactOptionalPropertyTypes` makes an absent
 * `expected` a different type from `expected: undefined` while the two are the
 * same fact, which is what `readUpload`'s `omitUndefined` is doing on the store
 * side.
 */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([key, entry]) => [key, canonical(entry)]),
  );
}

/** Structural equality over the dumps and answers. */
const same = (a: unknown, b: unknown): boolean =>
  JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

/** One divergence as a failure message a reader can act on. */
export function explain(bad: Divergence): string {
  return (
    `op ${bad.at} (${bad.op.t} on ${bad.op.slug}) — ${bad.what} outside its tenant.\n` +
    `expected ${JSON.stringify(bad.expected)}\n` +
    `actual   ${JSON.stringify(bad.actual)}`
  );
}
