// Copyright 2026 the AAI authors. MIT license.
/**
 * The STATE DIGEST — the load-bearing half of the fast/slow contract.
 *
 * TalkAct's finding is that the coupling between a fast conversational model
 * and a slow acting one is not a message queue but a rolling summary the slow
 * tier writes as a MANDATORY argument on every action, so the fast tier is
 * grounded "at zero extra model calls". This module is that record. Two things
 * about it are decisions rather than plumbing:
 *
 * **It is written by the SLOW tier and read by the FAST one, never the
 * reverse.** The fast tier's own belief about the state of the work is exactly
 * what hallucinated completion is made of; a digest it could write into would
 * launder that belief into something the next turn reads as fact.
 *
 * **Everything in it is agent-visible by construction.** The summary is a
 * string the slow tier produced from a {@link SlowTierView}, which is itself a
 * projection of the fast tier's own request — so nothing enters here that the
 * conversational model could not have seen. That is not politeness: a
 * verifier holding information the deployed agent will not have is an oracle,
 * and an oracle scores well for a reason that cannot ship. The entries are
 * this session's own tool calls and their outcomes, which is the other half of
 * the same rule.
 *
 * Nothing here calls a model, touches the network, or reads a clock; the store
 * is a plain object over an array, which is what lets the gate's whole decision
 * be a unit test.
 */

import { MAX_STATE_DIGEST_CHARS } from "@alexkroman1/aai";

/**
 * Where one piece of work got to.
 *
 * `"pending"` is the ONLY non-terminal state, and that is what makes the
 * completion gate a mechanical test rather than a judgement — see
 * {@link DigestStore.unsettled}.
 */
export type WorkState =
  /** Proposed, verdict outstanding. The tool has NOT run. */
  | "pending"
  /** Authorized and executed. */
  | "done"
  /** The slow tier refused it. The tool did not run. */
  | "refused"
  /**
   * Executed WITHOUT a verdict, because the slow tier did not answer in time
   * and the timeout policy was to fail open.
   *
   * Terminal — the work really happened — but recorded distinctly so the
   * rendered digest can say the difference, and so a run's rate of these is
   * measurable rather than inferred. A gate that logged nothing here would
   * make "the slow tier is timing out on every call" look identical to "the
   * slow tier is allowing every call".
   */
  | "unverified"
  /** Authorized, then the tool itself failed. */
  | "failed";

/** One piece of work the fast tier proposed. */
export type DigestEntry = {
  readonly id: string;
  readonly tool: string;
  readonly state: WorkState;
  /**
   * What to say about it — the slow tier's own sentence on a verdict, the
   * error on a failure, empty while pending.
   */
  readonly note: string;
};

/** The digest as a reader sees it. */
export type StateDigest = {
  /**
   * Bumped on every write.
   *
   * A reader that wants to know whether anything moved compares this rather
   * than deep-equalling the record — which is what the prompt suffix does, so
   * an unchanged digest re-renders nothing.
   */
  readonly revision: number;
  /** The slow tier's rolling summary of where the work stands. */
  readonly summary: string;
  readonly entries: readonly DigestEntry[];
};

/** One session's digest. @internal */
export type DigestStore = {
  read(): StateDigest;
  /** Record a proposal. The returned id is what {@link DigestStore.settle} takes. */
  open(tool: string, id: string): void;
  settle(id: string, state: Exclude<WorkState, "pending">, note: string): void;
  /**
   * Replace the rolling summary — the slow tier's `state_summary`.
   *
   * A no-op for a blank string, so a slow tier that answered a verdict and
   * nothing else leaves the last real summary standing rather than blanking
   * the fast tier's only grounding.
   */
  summarize(summary: string): void;
  /**
   * Work that has been proposed and not yet settled.
   *
   * The completion gate's whole test. Deliberately NOT "work that did not
   * succeed": a refusal is settled, and blocking completion forever on one
   * would wedge a call that has no way out — the `completes` proposal goes to
   * the slow tier WITH the refusal in its view instead, which is the one place
   * that judgement belongs.
   */
  unsettled(): readonly DigestEntry[];
};

const MAX_ENTRIES = 24;

/**
 * A fresh digest for one session.
 *
 * @internal
 */
export function createDigestStore(): DigestStore {
  let revision = 0;
  let summary = "";
  const entries: DigestEntry[] = [];

  return {
    read: (): StateDigest => ({ revision, summary, entries: [...entries] }),
    open(tool: string, id: string): void {
      revision += 1;
      entries.push({ id, tool, state: "pending", note: "" });
      // The trim drops the OLDEST, and a pending entry can be among them on a
      // very long call. That is the right trade for a bounded prompt: the
      // alternative is a digest that grows for the length of the call, and the
      // cost of it lands on time-to-first-token.
      if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
    },
    settle(id: string, state: Exclude<WorkState, "pending">, note: string): void {
      const at = entries.findIndex((e) => e.id === id);
      // An unknown id is DROPPED rather than appended. It can only mean the
      // entry was trimmed off the front of a long call, and appending a settled
      // entry with no proposal behind it would report the same work twice.
      const current = entries[at];
      if (current === undefined) return;
      revision += 1;
      entries[at] = { id: current.id, tool: current.tool, state, note };
    },
    summarize(next: string): void {
      const trimmed = next.trim();
      if (trimmed === "") return;
      revision += 1;
      summary = trimmed.slice(0, MAX_STATE_DIGEST_CHARS);
    },
    unsettled: (): readonly DigestEntry[] => entries.filter((e) => e.state === "pending"),
  };
}
