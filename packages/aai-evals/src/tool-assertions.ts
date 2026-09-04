// Copyright 2026 the AAI authors. MIT license.
/**
 * The TOOL half of the assertion vocabulary — what a verifying agent claims.
 *
 * A sibling of `assertions.ts` rather than more of it, because that file is at
 * its 500-line cap; the two are one vocabulary and {@link toolAssertions} is
 * spread straight into the scope, so a case never names this module.
 *
 * ## Why these three, and not more
 *
 * The vocabulary next door was written for a VOICE desk, where the interesting
 * claims are "it called the right tool with the right arguments" and "it called
 * them in that order" — and every one of them takes a TEXT agent's events
 * unchanged, since a text agent emits the same `SessionEvent` union
 * (`text-agent-events.ts`). What it had no way to say is the claim a
 * VERIFYING agent — a coding agent, the shipped example being the studio's own
 * — is graded on:
 *
 * - **Did anything come back RED?** `calledTool(name, { result })` asks whether
 *   SOME call to one tool carried a substring. A verification is the other
 *   quantifier over the other axis: did any result, from any of these tools,
 *   carry a diagnostic — and how many did, which is the repair count.
 *   {@link ToolAssertions.toolResultMatching} and its negative are that.
 * - **Was every write CHECKED?** `toolOrder(["write_file", "check_types"])` is a
 *   SUBSEQUENCE claim, so it holds when the agent wrote nine files and checked
 *   once. "Every write is followed by a check" is per-occurrence and is what an
 *   author means; {@link ToolAssertions.eachToolFollowedBy} is that.
 *
 * `aai-evals/src/studio-target.ts` is the measured evidence for both. It grades
 * the studio's coding agent over real HTTP and carries, by hand, a
 * `VERIFYING_TOOLS` set, a `redChecks` list, a `testAgentRuns` tally and a
 * `redExcerpts` collection — which is these two assertions written as a fold
 * over a transport.
 *
 * ## What is deliberately NOT here: the classification
 *
 * The pattern stays the CASE's (`/error TS\d/`, `/Tests: FAILED/`). A tool's
 * result is a wire string that the tool chose the words of, so "this output
 * means the build failed" is a fact about that tool and not about the event
 * stream — and a vocabulary that shipped a `buildFailed()` would be asserting
 * on prose the agent's own tools are free to reword. The event stream does not
 * change that and this module does not pretend it does: what it removes is the
 * COUNTING and the failure MESSAGE, which is what every hand-rolled version got
 * subtly wrong (a call that never completed rendering identically to one that
 * answered green).
 *
 * @module
 */

import { describeToolCalls, type EvalToolCall } from "@alexkroman1/aai-runtime/eval";
import type { EvalRecorder } from "./runner.ts";

/** How much of a matching result a failure message carries. */
const RESULT_EXCERPT = 200;

/** Bounds a counting assertion holds its tally to. */
export type CountBounds = {
  /** Exactly this many. Wins over `min`/`max`. */
  readonly count?: number;
  /** At least this many. Defaults to one, or to none when `max` is given. */
  readonly min?: number;
  /** At most this many — a ceiling, implying no floor of its own. */
  readonly max?: number;
};

/** What a counting assertion decided, and how to say what it asked for. */
export type CountVerdict = {
  readonly ok: boolean;
  /**
   * The bound as a label suffix — `""`, `" =2"`, `" >=1 <=3"`.
   *
   * Already carrying its leading space, so a caller composes
   * `` `event(${type}${bound})` `` with no conditional of its own. The two
   * callers used to spell that conditional out separately, which is how the
   * first copy of this logic lost the suffix entirely.
   */
  readonly bound: string;
};

/**
 * Is `n` within `bounds`, and what did the assertion ask for?
 *
 * One declaration for every counting claim in the vocabulary — `event()`,
 * `calledTool(… { count })` and {@link ToolAssertions.toolResultMatching}.
 *
 * The defaults are the load-bearing part. NO bounds mean at least one, because
 * every one of these is a positive claim. A `max` alone is a pure CEILING and
 * implies no floor: "at most two of these verifications came back red" has to
 * hold over an agent that produced NONE, or the assertion a case wrote as a
 * ceiling silently asserts a floor as well — which is what the spelled-out
 * copy in `event()` did (`event(type, { max: 3 })` could not hold at zero, and
 * `{ max: 0 }` could not hold at all). `{ max: 0 }` therefore means never,
 * which is what the negative arms spell as their own method.
 */
export function countVerdict(n: number, bounds: CountBounds): CountVerdict {
  const wanted = bounds.count;
  const min = wanted ?? bounds.min ?? (bounds.max === undefined ? 1 : 0);
  const max = wanted ?? bounds.max ?? Number.POSITIVE_INFINITY;
  const parts: string[] = [];
  if (bounds.min !== undefined) parts.push(`>=${bounds.min}`);
  if (bounds.max !== undefined) parts.push(`<=${bounds.max}`);
  const asked = wanted === undefined ? parts.join(" ") : `=${wanted}`;
  return { ok: n >= min && n <= max, bound: asked === "" ? "" : ` ${asked}` };
}

/** Which calls a result claim covers, and how many must match. */
export type ToolResultOptions = CountBounds & {
  /**
   * Only results from these tools count.
   *
   * A SET of names rather than one, because a verification is a property of the
   * output and not of which tool ran it: an agent whose cheaper check catches
   * the error first would otherwise score zero reds while having written
   * exactly the same wrong code — the argument `studio-target.ts`'s own
   * `VERIFYING_TOOLS` carries. Absent, every tool's result counts.
   */
  readonly tools?: readonly string[];
};

/** The tool-result and tool-sequence arms of {@link EvalScope}. */
export type ToolAssertions = {
  /**
   * A tool result matched `pattern`, within these bounds.
   *
   * The repair-count claim: `{ tools: [...], max: 2 }` is "at most two of these
   * verifications came back red".
   */
  toolResultMatching(pattern: string | RegExp, options?: ToolResultOptions): void;
  /** No tool result matched `pattern` — the green-at-the-end claim. */
  noToolResultMatching(
    pattern: string | RegExp,
    options?: { readonly tools?: readonly string[] },
  ): void;
  /**
   * EVERY call to `first` is followed by a later call to `second`.
   *
   * Stronger than `toolOrder([first, second])`, which is a subsequence and so
   * holds when nine writes were followed by one check.
   *
   * ZERO calls to `first` FAILS rather than holding vacuously, on this
   * vocabulary's standing rule that "nothing was measured" is not "nothing was
   * wrong" — an agent that wrote no file is the finding, not the exemption.
   */
  eachToolFollowedBy(first: string, second: string): void;
};

/**
 * Does `call`'s result carry `pattern`? A string matches case-insensitively.
 *
 * A call that never COMPLETED matches nothing — it has no result to carry a
 * diagnostic. That is the honest reading and it is why the failure detail goes
 * through `describeToolCalls`, which names such a call: "no result matched"
 * and "the tool never returned" want different fixes.
 */
function resultMatches(call: EvalToolCall, pattern: string | RegExp, lowered: string): boolean {
  const text = call.result;
  if (text === undefined) return false;
  return typeof pattern === "string" ? text.toLowerCase().includes(lowered) : pattern.test(text);
}

/** The calls a result claim covers, given its optional tool filter. */
function covered(
  calls: readonly EvalToolCall[],
  tools: readonly string[] | undefined,
): readonly EvalToolCall[] {
  if (tools === undefined) return calls;
  const wanted = new Set(tools);
  return calls.filter((call) => wanted.has(call.name));
}

/** `" in write_file|edit_file"`, or nothing — the label's scope half. */
function scopeSuffix(tools: readonly string[] | undefined): string {
  return tools === undefined ? "" : ` in ${tools.join("|")}`;
}

function short(text: string): string {
  return text.length <= RESULT_EXCERPT ? text : `${text.slice(0, RESULT_EXCERPT)}…`;
}

/**
 * Build the tool-result and tool-sequence arms over `calls`.
 *
 * `check` is the scope's own recording function, prefix and all, so a failure
 * here names the turn exactly as the arms next door do.
 */
export function toolAssertions(
  check: EvalRecorder["check"],
  calls: readonly EvalToolCall[],
): ToolAssertions {
  const matchesIn = (
    pattern: string | RegExp,
    tools: readonly string[] | undefined,
  ): { readonly scope: readonly EvalToolCall[]; readonly hits: readonly EvalToolCall[] } => {
    const scope = covered(calls, tools);
    const lowered = typeof pattern === "string" ? pattern.toLowerCase() : "";
    return { scope, hits: scope.filter((call) => resultMatches(call, pattern, lowered)) };
  };

  return {
    toolResultMatching(pattern, options = {}) {
      const { scope, hits } = matchesIn(pattern, options.tools);
      const verdict = countVerdict(hits.length, options);
      check(
        verdict.ok,
        `toolResultMatching(${String(pattern)}${scopeSuffix(options.tools)})${verdict.bound}`,
        // The call list, not just the tally: a claim that missed is almost
        // always a claim about a tool that never ran, and `describeToolCalls`
        // is the one renderer that says so — including a call that never
        // completed, which every hand-rolled version printed as a green one.
        `${hits.length} of ${scope.length} result(s) matched; ${describeToolCalls(scope)}`,
      );
    },

    noToolResultMatching(pattern, options = {}) {
      const { scope, hits } = matchesIn(pattern, options.tools);
      const first = hits[0];
      check(
        hits.length === 0,
        `noToolResultMatching(${String(pattern)}${scopeSuffix(options.tools)})`,
        first === undefined
          ? `${scope.length} result(s) checked`
          : // The offending output itself, which is the whole value of this
            // failing: "one of four results matched" says nothing a reader can
            // act on, where the diagnostic does.
            `${hits.length} of ${scope.length} matched, first from ${first.name}: ${short(first.result ?? "")}`,
      );
    },

    eachToolFollowedBy(first, second) {
      const names = calls.map((call) => call.name);
      // Walked from the END, so each call's "was there a later one" question is
      // answered in one pass rather than by a nested scan per occurrence.
      let seenSecond = false;
      let unfollowed = 0;
      let total = 0;
      for (const name of [...names].reverse()) {
        if (name === second) seenSecond = true;
        if (name !== first) continue;
        total += 1;
        if (!seenSecond) unfollowed += 1;
      }
      check(
        total > 0 && unfollowed === 0,
        `eachToolFollowedBy(${first} → ${second})`,
        total === 0
          ? `${first} was never called; called: ${names.join(" → ") || "no tools"}`
          : `${unfollowed} of ${total} ${first} call(s) had no later ${second}; called: ${names.join(" → ")}`,
      );
    },
  };
}
