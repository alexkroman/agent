// Copyright 2026 the AAI authors. MIT license.
/**
 * The GATE: what happens between the slow tier naming a tool and the tool
 * running.
 *
 * Four things, in this order, and the order is the design:
 *
 * 1. **The digest argument comes off and is recorded**, before anything can
 *    fail. A call that then fails is precisely the moment the fast tier most
 *    needs to know where the work stands.
 * 2. **A channel call is answered here**, never passed down — `tell_user`,
 *    `ask_user` and `task_done` are the framework's, and the agent has no tool
 *    by those names to run.
 * 3. **A `completes` call is REFUSED while anything is outstanding** —
 *    digest-gated completion, applied to the slow tier's own "work finished"
 *    tool and to the author's hand-off tool alike.
 * 4. **A mutating call gets a digest entry**, opened before and settled on
 *    every exit.
 *
 * Its own module because `session.ts` owns the session's WIRING (the
 * conversation, the wake, the runner) and this owns one call's DECISION — and
 * because the decision reached a cognitive complexity of 29 inside that
 * function, which is the tell that two things were in one place.
 */

import { serializeToolFailure } from "@alexkroman1/aai/host-internal";
import type { Logger } from "../runtime-config.ts";
import {
  channelEffectOf,
  completionRefusal,
  injectInstructionFor,
  takeSummary,
} from "./channel.ts";
import type { DigestStore } from "./digest.ts";
import type { ToolCatalogEntry } from "./view.ts";

/** Runs one tool through the gate. @internal */
export type GatedExecutor = (
  name: string,
  args: Readonly<Record<string, unknown>>,
  signal: AbortSignal,
) => Promise<string>;

/** What {@link createGatedExecutor} needs. @internal */
export type CreateGatedExecutorOptions = {
  digest: DigestStore;
  /** Every tool the slow tier has, classified. A name absent from it is a read. */
  catalog: ReadonlyMap<string, ToolCatalogEntry>;
  completionGate: boolean;
  /** Where a channel call goes: the session's transport. */
  transport: () => { injectTurn?(instruction: string): void };
  /** The runtime's own executor for an agent tool. */
  runTool: GatedExecutor;
  logger: Logger;
  sessionId: string;
};

/** Ids are unique per PROCESS, which is all the digest needs — they never leave it. */
let nextWorkId = 0;

/**
 * The refusal, or `undefined` when nothing is outstanding.
 *
 * A function because the check happens twice — once for the framework's
 * `task_done`, once for an author's own `completes` tool — and a second copy of
 * it is how the two come to disagree about what "outstanding" means.
 */
function refuseIfOutstanding(digest: DigestStore, completionGate: boolean): string | undefined {
  if (!completionGate) return undefined;
  const pending = digest.unsettled().map((e) => e.tool);
  return pending.length === 0 ? undefined : serializeToolFailure(completionRefusal(pending));
}

/**
 * Build the gate for one session.
 *
 * @internal
 */
export function createGatedExecutor(options: CreateGatedExecutorOptions): GatedExecutor {
  const { digest, catalog, completionGate, logger, sessionId } = options;

  /** Step 2: a channel call, answered here. */
  const runChannel = (
    name: string,
    args: Readonly<Record<string, unknown>>,
  ): string | undefined => {
    const channel = channelEffectOf(name, args);
    if (channel === undefined) return undefined;
    if (channel.kind === "done") {
      const refusal = refuseIfOutstanding(digest, completionGate);
      if (refusal !== undefined) return refusal;
    }
    options.transport().injectTurn?.(injectInstructionFor(channel));
    logger.debug("twoTier: channel", { sid: sessionId, kind: channel.kind });
    return JSON.stringify({ delivered: true });
  };

  /** Step 4: the agent's own tool, tracked when it cannot be taken back. */
  const runTracked = async (
    name: string,
    args: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
    tracked: boolean,
  ): Promise<string> => {
    const id = `w${nextWorkId}`;
    nextWorkId += 1;
    if (tracked) digest.open(name, id);
    try {
      const result = await options.runTool(name, args, signal);
      if (tracked) digest.settle(id, "done", "");
      return result;
    } catch (err) {
      // Settled on EVERY exit, which is what stops the completion gate wedging
      // a call: a run abandoned mid-step (timeout, barge-in, session release)
      // would otherwise leave an entry `pending` forever, refusing every later
      // hand-off with nothing able to clear it.
      if (tracked) digest.settle(id, "failed", err instanceof Error ? err.message : String(err));
      throw err;
    }
  };

  return async (name, rawArgs, signal) => {
    const { summary, rest } = takeSummary(rawArgs);
    digest.summarize(summary);

    const channelled = runChannel(name, rest);
    if (channelled !== undefined) return channelled;

    const entry = catalog.get(name);
    if (entry?.completes === true) {
      // Checked BEFORE any entry is opened, so a refused hand-off does not
      // itself become outstanding work — which would make the first refusal
      // refuse everything after it.
      const refusal = refuseIfOutstanding(digest, completionGate);
      if (refusal !== undefined) return refusal;
    }
    // Only a step that CANNOT BE TAKEN BACK is tracked. A read is recorded by
    // its summary alone: SABER's finding is that each additional deviation on a
    // mutating step costs up to 96% of the odds of success on τ-bench Retail
    // while deviations on non-mutating ones cost little or nothing, so tracking
    // every lookup would fill the fast tier's prompt with the half that does
    // not matter.
    return await runTracked(name, rest, signal, entry?.mutates === true);
  };
}
