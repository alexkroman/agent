// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai-runtime:runtime` epoch 10.
 *
 * A host that OWNS the durable-run journal AND reports on it — the same starting
 * point as `v6.ts` (a database it already has, a `JournalStore` handed to the
 * runtime rather than built from a `DATABASE_URL`), carried forward to the epoch
 * where an attempt CHARGE became a lease. Written the way it was authored at
 * epoch 10, and it must keep compiling for as long as that epoch is advertised
 * as supported.
 *
 * ## What moved, and why epoch 10 survives it
 *
 * `claimAttempt` and `releaseAttempt` grew a `holder` — the walk that holds the
 * charge — and `claimAttempt` grew a `leaseMs` beside it. Before that a charge
 * was a scalar counter, and a scalar cannot expire: the charge a DEAD walk left
 * was indistinguishable from a live one, so it stood forever and `maxAttempts`
 * deaths on one step key refused that step permanently.
 *
 * Two parameters were ADDED to methods a host IMPLEMENTS, and that direction is
 * not breaking: a function of two parameters satisfies a signature of four, so a
 * store written at epoch 9 still type-checks here. What it loses is behaviour
 * rather than compilation — it counts every claim, including a re-claim by the
 * walk that already held one — which is exactly what the retain is claiming and
 * is why the reader below reports the lease rather than assuming it.
 *
 * **The direction that WOULD break is a host that CALLS one of them**, and there
 * is one plausible reason to: a maintenance job reclaiming charges by hand. That
 * caller now has to name a holder. It is the case to look for when this epoch is
 * eventually dropped.
 *
 * ## The journal arrives as a PARAMETER, which is a limitation of the surface
 *
 * `RuntimeOptions.journal` is contracted and the type it takes is a FORGOTTEN
 * export — reachable from that signature and exported by no subpath — so a host
 * cannot name it, and the three implementations are `@internal`. So this example
 * takes the store it was handed rather than assembling one, exactly as `v6.ts`
 * does and for the same reason. That is a finding recorded in
 * `docs/CLAUDE.md`, "What writing the `aai-runtime` epoch templates found", not
 * a shape to copy on purpose.
 *
 * Editing this file to make a future error go away defeats the mechanism: the
 * error IS the finding, and it means epoch 10 has to be dropped with a reason.
 */

import { agent } from "@alexkroman1/aai";
import { createRuntime, type RuntimeOptions } from "../../../runtime-barrel.ts";

/** ── EDIT: the agent this host runs. ───────────────────────────────────── */
const definition = agent({
  name: "digest-desk",
  systemPrompt: "You summarize links people send you.",
  greeting: "Digest desk.",
});

/**
 * The journal, as this host's own code sees it.
 *
 * Derived from the option rather than written out, because the type it names is
 * not exported: `NonNullable<RuntimeOptions["journal"]>` is the only spelling a
 * host has, and it is the one to copy.
 */
type HostJournal = NonNullable<RuntimeOptions["journal"]>;

/**
 * ── EDIT: how long a charge counts for, in YOUR fleet. ──────────────────
 *
 * The window a claim reads under. It has to clear the longest walk that can
 * legitimately be running, or a live walk's charge expires and the ceiling stops
 * bounding anything; the runtime's own default is an hour for that reason. There
 * is no heartbeat, so a live walk does not refresh its charge.
 */
const LEASE_MS = 60 * 60 * 1000;

/** What this host tells an operator about one step's outstanding attempts. */
export type AttemptReport = {
  key: string;
  /** How many walks hold a LIVE charge on this key, including the reader's. */
  outstanding: number;
};

/**
 * ── EDIT: what "is this step wedged" means for your operators. ───────────
 *
 * A maintenance read, and it has to name a holder like any other claimer: the
 * number is per-walk now, so a reader that made one up would appear as a walk
 * and inflate the answer it came to read. Naming ONE holder and reusing it makes
 * the read idempotent — a claim by a holder that already has a live charge
 * answers the same number rather than a higher one.
 */
export async function outstandingAttempts(
  journal: HostJournal,
  runId: string,
  keys: readonly string[],
): Promise<AttemptReport[]> {
  const reports: AttemptReport[] = [];
  for (const key of keys) {
    reports.push({
      key,
      outstanding: await journal.claimAttempt(runId, key, "ops-probe", LEASE_MS),
    });
  }
  // And it gives its own charges back, so the probe is not one of the walks the
  // next reader counts. A release names the charge, so this can only ever take
  // the probe's own.
  for (const { key } of reports) await journal.releaseAttempt(runId, key, "ops-probe");
  return reports;
}

/**
 * ── EDIT: how this host records a step it ran itself. ────────────────────
 *
 * A backfill, a migration, a step this process ran outside a replay.
 * `appendStep` is idempotent on `key` and answers the STORED entry, so what
 * comes back is authoritative and may not be the entry that was sent.
 */
export async function record(journal: HostJournal, runId: string, key: string): Promise<string> {
  const stored = await journal.appendStep(runId, {
    key,
    name: key.split("#")[0] ?? key,
    status: "ok",
    output: { backfilled: true },
    attempts: 1,
    finishedAt: Date.now(),
  });
  return stored.key;
}

/**
 * ── EDIT: the credentials, and where they may be read. ───────────────────
 *
 * `journal` is the point of this file: with it, durable runs live in the host's
 * own database and the runtime builds nothing. Without it the runtime resolves
 * one itself — a `DATABASE_URL` if there is one, memory otherwise — and the boot
 * line names which.
 */
export function optionsFor(journal: HostJournal): RuntimeOptions {
  return {
    agent: definition,
    env: {},
    providerEnv: { ASSEMBLYAI_API_KEY: process.env.ASSEMBLYAI_API_KEY ?? "" },
    journal,
  };
}

/** Stand the runtime up on the host's own journal. */
export function start(journal: HostJournal): ReturnType<typeof createRuntime> {
  return createRuntime(optionsFor(journal));
}
