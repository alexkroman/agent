/**
 * Every vitest run's fast-check SEED — a vitest `setupFiles` entry, in
 * `vitest.shared.ts`'s `sharedSetupFiles`.
 *
 * A gating run (`pnpm test`, `check:local`, CI) draws ONE fixed seed, so each
 * property and each of its coverage floors is decided by the code alone. With
 * a fresh seed per run, a floor set under the minimum of 20 sampled runs fails
 * by chance (`uploads/byte-util.test.ts`: 32 of 20,000 simulated runs), and the
 * repo's ~150 floors made a stray red run likely on code nobody touched.
 *
 * Exploring new inputs is still the point of a property, so it moved to a run
 * that does not gate: `pnpm test:fuzz` sets `AAI_FC_SEED=random`, and a finding
 * it prints replays with `AAI_FC_SEED=<the seed it printed>`. A property that
 * passes its own `seed` keeps it — per-call parameters win over these.
 *
 * `configureGlobal` lands in fast-check's module state, so this must load the
 * SAME copy the specs do: the root's `fast-check` is the catalog version, one
 * path in the store.
 */

import fc from "fast-check";

/** The gating seed. Changing it re-rolls every property at once — re-check the floors. */
export const GATING_SEED = 20_261_024;

const raw = process.env.AAI_FC_SEED;
if (raw !== "random") {
  const seed = raw === undefined || raw === "" ? GATING_SEED : Number(raw);
  if (!Number.isInteger(seed)) {
    throw new Error(`AAI_FC_SEED must be an integer or "random", got ${JSON.stringify(raw)}`);
  }
  fc.configureGlobal({ ...fc.readConfigureGlobal(), seed });
}
