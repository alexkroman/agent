// Copyright 2026 the AAI authors. MIT license.
/**
 * A journal holding one `running` run, and a replay of a body against it — the
 * pair every replay-engine spec opens with.
 *
 * Both take the run's identity from one object, so a spec that names its own run
 * (`{ runId: "wrun_j", workflow: "billing" }`) passes the same object to each and
 * the seeded record and the replayed walk cannot disagree about which run it is.
 */

import type { WorkflowContext } from "@alexkroman1/aai";
import { createMemoryJournal } from "./journal/backends/memory.ts";
import type { JournalStore } from "./journal/types.ts";
import { replayRun } from "./replay.ts";

/** A workflow body as the engine calls it. */
export type ReplayBody = (
  input: Record<string, unknown>,
  ctx: WorkflowContext,
) => Promise<unknown> | unknown;

/** Which run: defaults to `wrun_1` of `digest`, with an empty input. */
export type ReplayRunIdentity = {
  runId?: string;
  workflow?: string;
  input?: Record<string, unknown>;
};

const identityOf = (run: ReplayRunIdentity) => ({
  runId: run.runId ?? "wrun_1",
  workflow: run.workflow ?? "digest",
  input: run.input ?? {},
});

/** Create the run in `journal` (a fresh memory journal by default) and hand it back. */
export async function seedRun(
  run: ReplayRunIdentity & { journal?: JournalStore } = {},
): Promise<JournalStore> {
  const journal = run.journal ?? createMemoryJournal();
  await journal.createRun({ ...identityOf(run), status: "running", createdAt: Date.now() });
  return journal;
}

/** Replay `body` against `journal` as the run `run` names. */
export function replayOn(
  journal: JournalStore,
  body: ReplayBody,
  run: ReplayRunIdentity & { startedUnder?: string | undefined } = {},
): ReturnType<typeof replayRun> {
  return replayRun({ ...identityOf(run), run: body, journal, startedUnder: run.startedUnder });
}
