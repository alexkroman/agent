// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai-runtime:runtime` epoch 6.
 *
 * A host that OWNS the durable-run journal — it already has a database, and it
 * hands the runtime a `JournalStore` rather than letting one be built from a
 * `DATABASE_URL`. That is the half `v3.ts` and `v4.ts` do not reach: they fill
 * the executor slots and leave persistence to the runtime, where this is what an
 * embedder copies when the runs belong to their schema. Written the way it was
 * authored at epoch 6, and it must keep compiling for as long as that epoch is
 * advertised as supported.
 *
 * ## What moved, and why epoch 6 survives it
 *
 * Epoch 7 added an optional `startedAt` to `StepEntry` — when the walk reached
 * the step, so `finishedAt - startedAt` is what it cost. Until then an entry
 * carried `attempts` and `finishedAt` and no start, and "which step is slow" was
 * unanswerable from a run's own history.
 *
 * Adding an OPTIONAL member to a record a host both WRITES and READS is not
 * breaking in either direction, which is what makes this a retain. The
 * `appendStep` below constructs an entry with no `startedAt` and still satisfies
 * the type; the reader below renders an absent one as unknown, which is what it
 * would have had to do anyway for a row written before the column existed.
 *
 * **The direction that WOULD break is a REQUIRED member on that record**, and it
 * is worth recording because this field was one decision away from it: had
 * `startedAt` landed required, every host storing entries would owe a start for
 * rows it had already written, and there is no value that honestly stands for
 * one — `0` reads as the epoch and therefore as a step that took fifty-five
 * years, and `finishedAt` reads as a step that took no time. Optional is what
 * makes an unknown start representable.
 *
 * ## The journal arrives as a PARAMETER, and that is a limitation of the surface
 *
 * `RuntimeOptions.journal` is contracted and the type it takes is a FORGOTTEN
 * export — reachable from that signature and exported by no subpath — so a host
 * cannot name it, and the three implementations
 * (`createMemoryJournal`/`createPostgresJournal`/`createPlatformJournal`) are
 * `@internal` and live on `@alexkroman1/aai-runtime/internal`. So this example
 * takes the store it was handed rather than assembling one, exactly as the
 * `uploads` capability's template does for the same reason. That is a finding
 * recorded in `docs/CLAUDE.md`, "What writing the `aai-runtime` epoch templates
 * found", not a shape to copy on purpose.
 *
 * Editing this file to make a future error go away defeats the mechanism: the
 * error IS the finding, and it means epoch 6 has to be dropped with a reason.
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

/** One settled step, as this host renders it for an operator. */
export type StepTiming = {
  key: string;
  attempts: number;
  /**
   * How long the step took, or `undefined` when the entry carries no start.
   *
   * Absent rather than `0`, which is the whole reason `startedAt` is optional:
   * a row written before the field existed has no start, and reporting one as
   * instant is worse than reporting it as unknown.
   */
  durationMs: number | undefined;
};

/**
 * ── EDIT: what "which step was slow" means for your operators. ───────────
 *
 * The read side of the journal a host supplied. `readSteps` is ordered by
 * `finishedAt` with ties broken by `key`, so this is already the run's history
 * in order and needs no sort of its own.
 */
export async function timings(journal: HostJournal, runId: string): Promise<StepTiming[]> {
  const steps = await journal.readSteps(runId);
  return steps.map((step) => ({
    key: step.key,
    attempts: step.attempts,
    durationMs: step.startedAt === undefined ? undefined : step.finishedAt - step.startedAt,
  }));
}

/**
 * ── EDIT: how this host records a step it ran itself. ────────────────────
 *
 * A host driving its own work through the same journal — a backfill, a
 * migration, a step this process ran outside a replay. `appendStep` is
 * idempotent on `key` and answers the STORED entry, so what comes back is
 * authoritative and may not be the entry that was sent.
 */
export async function record(
  journal: HostJournal,
  runId: string,
  key: string,
): Promise<StepTiming> {
  const stored = await journal.appendStep(runId, {
    key,
    name: key.split("#")[0] ?? key,
    status: "ok",
    output: { backfilled: true },
    attempts: 1,
    finishedAt: Date.now(),
  });
  return {
    key: stored.key,
    attempts: stored.attempts,
    durationMs: stored.startedAt === undefined ? undefined : stored.finishedAt - stored.startedAt,
  };
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
