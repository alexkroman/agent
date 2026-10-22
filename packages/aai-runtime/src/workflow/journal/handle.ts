// Copyright 2026 the AAI authors. MIT license.
/**
 * The PUBLIC face of a run journal: an opaque handle, and the one factory a
 * host may call.
 *
 * {@link JournalStore} is sixteen methods over seven records, and it moves
 * whenever the replay engine learns a new question to ask its store — which
 * is often. While `RuntimeOptions.journal`, `AgentServerOptions.journal` and
 * `runWorkflow`'s options took it by that shape, every such move was a break
 * of three capabilities, for a seam no embedder implements: the three
 * backends (memory, Postgres, the platform's HTTP client) are this package's
 * own. So the options take a {@link WorkflowJournal} — sealed, branded, minted
 * only here — and the store's shape is `/internal`.
 *
 * A handle IS the store at runtime: {@link workflowJournal} brands one and
 * {@link journalStoreOf} reads it back, both casts with no wrapper, so the
 * engine sees exactly the object a backend built.
 *
 * @module
 */

import { createMemoryJournal as createMemoryJournalStore } from "./backends/memory.ts";
import type { JournalStore } from "./types.ts";

/**
 * The seal {@link WorkflowJournal} carries. TYPE-ONLY: there is no value to
 * import, which is what stops a hand-written object from satisfying the type.
 *
 * @public
 */
export declare const workflowJournalBrand: unique symbol;

/**
 * Where a host's durable runs are recorded — an opaque handle a host passes as
 * `RuntimeOptions.journal` (or to `runWorkflow`) and never reads.
 *
 * @sealed Only {@link createMemoryJournal} (and this package's own durable
 * backends) produce one — see {@link workflowJournalBrand}.
 * @public
 */
export type WorkflowJournal = {
  /** The seal — see {@link workflowJournalBrand}. */
  readonly [workflowJournalBrand]: true;
};

/**
 * A run journal in this process's memory, for a host that must hold one across
 * a runtime rebuild.
 *
 * `aai dev` is the reason it exists: it rebuilds the runtime on every file save,
 * and the engine's own default is a FRESH journal per build — so every save
 * discarded the runs. Build one per PROCESS and hand the same handle to each
 * runtime. It does not survive a restart; a deployment that owns a database
 * gets the Postgres journal from `RuntimeOptions.db` instead, and a supplied
 * memory journal never outranks it.
 *
 * @public
 */
export function createMemoryJournal(): WorkflowJournal {
  return workflowJournal(createMemoryJournalStore());
}

/**
 * Brand a store as a handle. The same object — see the module doc.
 *
 * @internal
 */
export function workflowJournal(store: JournalStore): WorkflowJournal {
  // Narrowed to the intersection (a cast the checker can relate), then widened.
  return store as JournalStore & WorkflowJournal;
}

/**
 * The store behind a handle. Every handle was minted by {@link workflowJournal}
 * (the brand is type-only, so nothing else can produce one), which is what makes
 * the cast sound.
 *
 * @internal
 */
export function journalStoreOf(journal: WorkflowJournal): JournalStore;
export function journalStoreOf(journal: WorkflowJournal | undefined): JournalStore | undefined;
export function journalStoreOf(journal: WorkflowJournal | undefined): JournalStore | undefined {
  return journal as (WorkflowJournal & JournalStore) | undefined;
}
