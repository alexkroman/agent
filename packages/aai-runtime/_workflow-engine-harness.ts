// Copyright 2026 the AAI authors. MIT license.
/**
 * The engine under test, over a memory journal — shared by the two specs that
 * drive it.
 *
 * Its own module because `workflow-engine.test.ts` crossed the 700-line test cap
 * and split at the seam the file already had: LIFECYCLE (`workflow-engine.test.ts`)
 * against a run that PARKS (`workflow-engine-waits.test.ts`). Both need this
 * exact engine, and a copy each is how two specs come to disagree about what
 * they are testing.
 *
 * A `_*-harness.ts` name rather than `_*-test-utils.ts` for a mechanical reason
 * as well as a descriptive one: both are excluded from coverage
 * (`sharedCoverageExclude`), and this is a harness rather than a grab bag.
 */

import { type WorkflowCtx, workflow } from "@alexkroman1/aai";
import { type Mock, vi } from "vitest";
import { silentLogger } from "./_test-utils.ts";
import { createWorkflowEngine, type WorkflowEngine } from "./workflow-engine.ts";
import { createMemoryJournal } from "./workflow-journal-memory.ts";
import type { JournalStore } from "./workflow-journal-types.ts";
import { createMemoryStreams } from "./workflow-streams.ts";

/** The engine's dispatcher, as a spy. May reject: a queue can be unreachable. */
type DispatchSpy = Mock<(runId: string, at?: number) => void | Promise<void>>;

/** A workflow body, as the engine's registry holds one. */
type Body = (input: Record<string, unknown>, ctx: WorkflowCtx) => unknown;

/**
 * An engine over a memory journal, with dispatch held back.
 *
 * `dispatch` is a spy rather than an executor, because `start` and `execute`
 * being separate is the property most of these tests turn on — an engine that
 * ran the run inline would make every assertion below about a run that had
 * already finished.
 */
export function harness(
  bodies: Record<string, Body> = {},
  dispatch: DispatchSpy = vi.fn(),
): { engine: WorkflowEngine; journal: JournalStore; dispatch: DispatchSpy } {
  const journal = createMemoryJournal();
  const workflows = Object.fromEntries(
    Object.entries(bodies).map(([name, run]) => [
      name,
      // The real declaration path, so a def here is the shape `agent({ workflows })`
      // holds rather than an object literal that happens to have a `run`.
      workflow({ description: name, run }),
    ]),
  );
  let n = 0;
  const engine = createWorkflowEngine({
    workflows,
    journal,
    streams: createMemoryStreams(),
    dispatch,
    newRunId: () => `wrun_${++n}`,
    logger: silentLogger,
  });
  return { engine, journal, dispatch };
}
