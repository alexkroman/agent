// Copyright 2026 the AAI authors. MIT license.
/**
 * ONE execution of one workflow run: the context its `run` body sees, how a step
 * retries, how a suspension unwinds, and how a drifting step sequence is reported.
 *
 * Split from `workflow-engine.ts`, which keeps the parts that are about the run
 * COLLECTION — claiming, leases, wake timers, recovery, the client surface. The
 * line between them is per-run versus per-engine, and it is also what puts each
 * file under the length cap.
 *
 * Nothing here is on the runtime barrel, so none of it reaches an agent bundle.
 *
 * @internal
 */

import type { Db } from "../sdk/db.ts";
import { findUnjournalable } from "../sdk/journalable.ts";
import { errorMessage } from "../sdk/utils.ts";
import {
  DEFAULT_STEP_BACKOFF_MS,
  DEFAULT_STEP_MAX_ATTEMPTS,
  MAX_WORKFLOW_STEPS,
  type StepOptions,
  type WorkflowContext,
} from "../sdk/workflow.ts";
import { type HostGenerateFn, toGenerateFn } from "./generate.ts";
import type { Logger } from "./runtime-config.ts";
import type { WorkflowStore } from "./workflow-store.ts";

/**
 * Thrown by `ctx.sleep()` to unwind a run that has more to do later.
 *
 * A class rather than a sentinel value so it cannot be confused with an
 * author's own error, and reachable only from `host/` — it is not on the runtime
 * barrel, so it never reaches an agent bundle. That is the property that matters:
 * an author who caught it around a `sleep` would silently convert a suspension
 * into a completed run, so only the engine may recognize it.
 */
/**
 * Thrown by `ctx.continueAs()` to end this run and hand its work to a successor.
 *
 * A separate class from {@link Suspended} because the engine's answer is different
 * in kind: a suspension RELEASES the run to be claimed again, while this one
 * settles it and creates a new row. Sharing one class would make that a boolean on
 * the error, i.e. two behaviours behind one name.
 */
export class ContinueAs extends Error {
  /** The successor run's input. A field rather than a parameter property, which
   * `erasableSyntaxOnly` forbids. */
  readonly input: unknown;
  constructor(input: unknown) {
    super("workflow run continued as a new run");
    this.name = "ContinueAs";
    this.input = input;
  }
}

export class Suspended extends Error {
  /** Epoch ms the run becomes due again. Declared as a field rather than a
   *  constructor parameter property, which `erasableSyntaxOnly` forbids. */
  readonly wakeAt: number;

  constructor(wakeAt: number) {
    super("workflow suspended");
    this.name = "Suspended";
    this.wakeAt = wakeAt;
  }
}

/**
 * The error a step raises once it is out of attempts.
 *
 * A shutdown mid-step is not a step failure: the run keeps its journal and
 * resumes from where it stopped, so the message says so rather than blaming the
 * step — and `execute` reads the same signal to leave the run claimable.
 */
function stepFailure(stepId: string, maxAttempts: number, cause: unknown, aborted: boolean): Error {
  if (aborted) {
    return new Error(`workflow step "${stepId}" abandoned: host is shutting down`);
  }
  return new Error(
    `workflow step "${stepId}" failed after ${maxAttempts} attempt(s): ${errorMessage(cause)}`,
    { cause },
  );
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
    signal.addEventListener("abort", finish, { once: true });
  });
}

/** Run one step's function, retrying transient failures with backoff. */
async function attempt<T>(
  stepId: string,
  fn: () => Promise<T> | T,
  options: StepOptions | undefined,
  signal: AbortSignal,
  logger: Logger,
): Promise<T> {
  const maxAttempts = options?.maxAttempts ?? DEFAULT_STEP_MAX_ATTEMPTS;
  const backoffMs = options?.backoffMs ?? DEFAULT_STEP_BACKOFF_MS;
  let last: unknown;
  for (let n = 1; n <= maxAttempts; n++) {
    if (signal.aborted) break;
    try {
      return await fn();
    } catch (err) {
      last = err;
      logger.error(`workflow step "${stepId}" attempt ${n}/${maxAttempts} failed`, {
        error: errorMessage(err),
      });
      if (n < maxAttempts) await delay(backoffMs * 2 ** (n - 1), signal);
    }
  }
  throw stepFailure(stepId, maxAttempts, last, signal.aborted);
}

/**
 * One execution's context, plus the step ids it actually reached.
 *
 * The second half is what makes a determinism violation REPORTABLE — see
 * {@link reportSequenceDrift}.
 */
export type Execution = { ctx: WorkflowContext; claimedSteps: Set<string> };

/** What building one execution's context needs from the engine around it. */
export type ExecutionDeps = {
  store: WorkflowStore;
  db: Db;
  env: Readonly<Record<string, string>>;
  generate: HostGenerateFn | undefined;
  logger: Logger;
};

/**
 * Build the context one execution of one run sees.
 *
 * A factory over the engine's dependencies rather than a closure inside it, so
 * the per-run machinery can live in its own file without threading five
 * parameters through every call.
 */
export function createContextFactory(deps: ExecutionDeps) {
  const { store, db, env, generate, logger } = deps;
  return function buildContext(
    runId: string,
    journal: Map<string, unknown>,
    signal: AbortSignal,
  ): Execution {
    // Per-name call counters, so a step name reused in a loop yields one
    // journal entry per iteration rather than replaying the first forever.
    // Prefixed by kind (`s:` author step, `t:` timer) so a `sleep` can never
    // collide with a step an author happened to name the same thing.
    const ordinals = new Map<string, number>();
    /**
     * Every id this execution computed, whether it replayed a journaled entry
     * or ran fresh. Compared against the journal when the execution unwinds: an
     * entry nobody claimed means the SEQUENCE changed, which is the one rule an
     * author owns and the one failure that was previously silent.
     */
    const claimedSteps = new Set<string>();
    const nextId = (kind: "s" | "t", name: string): string => {
      const key = `${kind}:${name}`;
      const n = ordinals.get(key) ?? 0;
      ordinals.set(key, n + 1);
      const id = `${key}#${n}`;
      claimedSteps.add(id);
      return id;
    };

    /**
     * Journal one entry and enforce the run's step cap.
     *
     * BOTH `step` and `sleep` go through here, because the cap is about the
     * journal's SIZE rather than about author steps: replay reads every row
     * back through `ctx.db`, so a run that sleeps in a loop overruns
     * `MAX_DB_RESULT_ROWS` exactly as a run that steps in a loop does — and a
     * journal that cannot be read in full replays as a run with no history.
     */
    const record = async (stepId: string, output: unknown): Promise<void> => {
      // Refused BEFORE the write, and deliberately not retried: a value the
      // journal cannot hold is an authoring mistake, not a transient failure, and
      // the whole point is to fail on this execution rather than hand the resume
      // a different value. See `findUnjournalable`.
      const unjournalable = findUnjournalable(output);
      if (unjournalable !== undefined) {
        throw new Error(
          `workflow step "${stepId}" returned ${unjournalable}, which the run journal ` +
            "cannot store: step outputs are written as JSON and read back on the next " +
            "replay. Return the JSON form (an ISO string, an array of entries) and " +
            "rebuild the value outside the step.",
        );
      }
      const count = await store.recordStep(runId, stepId, output);
      journal.set(stepId, output);
      if (count >= MAX_WORKFLOW_STEPS) {
        throw new Error(
          `workflow run ${runId} exceeded ${MAX_WORKFLOW_STEPS} journal entries; ` +
            "split the work into child runs",
        );
      }
    };

    const ctx: WorkflowContext = {
      env,
      db,
      generate: toGenerateFn(generate, { signal }),
      runId,
      signal,
      async blob(
        blobId: string,
      ): Promise<{ contentType: string; bytes: Uint8Array<ArrayBuffer> } | undefined> {
        const stored = await store.getBlob(blobId);
        if (!stored) return;
        return {
          contentType: stored.contentType,
          // `new Uint8Array(buf)`, not `Uint8Array.from(buf)`: the latter goes
          // through the iterator path element by element. The copy itself is
          // NOT redundant — `Buffer.from(str, "base64")` may allocate out of
          // Node's shared pool, so its `.buffer` is other buffers' too, and
          // exclusive ownership is what lets this be typed `Uint8Array<
          // ArrayBuffer>` and handed to a `fetch` body or a `Blob` without the
          // caller re-copying it (see `WorkflowContext.blob`).
          bytes: new Uint8Array(Buffer.from(stored.base64, "base64")),
        };
      },

      releaseBlob(blobId: string): Promise<boolean> {
        return store.deleteBlob(blobId);
      },

      async step<T>(name: string, fn: () => Promise<T> | T, options?: StepOptions): Promise<T> {
        const stepId = nextId("s", name);
        // Replay: a journaled step is a fact, and re-running it is exactly
        // what durability is supposed to prevent.
        if (journal.has(stepId)) return journal.get(stepId) as T;
        const output = await attempt(stepId, fn, options, signal, logger);
        await record(stepId, output);
        return output;
      },
      continueAs(input: unknown): never {
        // Unwinds like `sleep` and journals NOTHING: the successor's identity is
        // the engine's to mint (it needs the store), and journaling a decision
        // that has not been acted on would leave a replay of THIS run continuing
        // twice if the settle failed in between.
        throw new ContinueAs(input);
      },
      async sleep(ms: number): Promise<void> {
        const stepId = nextId("t", "sleep");
        const journaled = journal.get(stepId);
        // Already scheduled on an earlier life of this run: either the wake
        // time has passed (fall through and keep going) or it has not (suspend
        // again, without moving the deadline — a resumed run must not have its
        // sleep extended by however long it waited to be picked up).
        if (typeof journaled === "number") {
          if (Date.now() >= journaled) return;
          throw new Suspended(journaled);
        }
        const wakeAt = Date.now() + Math.max(0, ms);
        await record(stepId, wakeAt);
        throw new Suspended(wakeAt);
      },
    };
    return { ctx, claimedSteps };
  };
}

/**
 * Report a journal this execution did not fully replay.
 *
 * Step ids are `<kind>:<name>#<ordinal>` assigned by CALL ORDER, so a body
 * whose sequence of `step`/`sleep` calls varies between replays computes
 * different ids — the journal lookup misses, and the step runs a second time
 * with its earlier result orphaned. Nothing reported that: the run still
 * completed, having silently re-done work and grown its journal toward
 * {@link MAX_WORKFLOW_STEPS} on every replay.
 *
 * A journaled id nobody claimed is exactly that signature. At every unwind
 * point — completion, failure, and suspension alike — an execution has
 * necessarily walked past every entry a previous life recorded, because the
 * only way to reach a later `sleep` is through the earlier ones. So this
 * needs no exemption for a suspended run, and a hit is real rather than a
 * timing artefact.
 *
 * It reports rather than throws: the run's work is done and failing it would
 * turn a correctness warning into lost output. The rule stays the author's;
 * this is the signal that they broke it.
 */
export function reportSequenceDrift(
  logger: Logger,
  workflow: string,
  runId: string,
  journal: Map<string, unknown>,
  claimedSteps: Set<string>,
  thrown?: unknown,
): void {
  // Only for a boundary the RUN chose. An unclaimed journal entry means "a replay
  // walked past a step this one did not", which holds on completion and on both
  // control-flow unwinds — `sleep`/`continueAs` are reachable only THROUGH every
  // earlier entry — and does NOT hold on a failure, which abandons the rest of the
  // body by definition. Reported unconditionally, a run whose steps are CONCURRENT
  // (`Promise.all` over `ctx.step`, the shape `transcription-desk` ships) named
  // every sibling the rejection cancelled: a real failure buried under a list of
  // invented determinism violations, on exactly the shape the docs recommend.
  if (thrown !== undefined && !(thrown instanceof Suspended || thrown instanceof ContinueAs)) {
    return;
  }
  if (journal.size === 0) return;
  const orphaned = [...journal.keys()].filter((id) => !claimedSteps.has(id));
  if (orphaned.length === 0) return;
  const shown = orphaned.slice(0, 5).join(", ");
  logger.error(
    `workflow "${workflow}" run ${runId} did not replay ${orphaned.length} journaled step(s) ` +
      `(${shown}${orphaned.length > 5 ? ", …" : ""}): the step sequence changed between ` +
      "replays, so recorded work was re-done instead of reused. Branch only on values that " +
      "came out of a step or the run input — never on Date.now() or Math.random() read " +
      "directly in the workflow body.",
  );
}
