// Copyright 2026 the AAI authors. MIT license.
// The LLM view's retention, and the tool-call PAIRS it must never split — split
// out of pipeline-history.test.ts at the test-file length cap.

import type { ModelMessage } from "ai";
import fc from "fast-check";
import { describe, expect, test, vi } from "vitest";
import {
  llmTokens,
  orphanToolResults,
  RETAIN,
  toolCallMsg,
  toolResultMsg,
} from "./_history-test-utils.ts";
import { estimateMessageTokens } from "./context-budget.ts";
import { createPipelineHistory } from "./history.ts";

// The LLM view holds tool-call/result PAIRS, and retention cuts the front, so
// a naive cut could land between the two. Both providers reject an orphaned
// `tool` message outright (OpenAI: "messages with role 'tool' must be a
// response to a preceding message with 'tool_calls'"), which fails every
// remaining turn of a long call — see evictLlm in pipeline-history.ts.
describe("createPipelineHistory — LLM history retention and tool-call pairing", () => {
  test("evicting an assistant tool-call takes the result it would orphan", () => {
    const h = createPipelineHistory(undefined, { retainTokens: RETAIN });
    // Put a tool pair at the very front of a full window.
    h.pushLlm(toolCallMsg("c1"), toolResultMsg("c1"));
    for (let i = 0; llmTokens(h.llm) < RETAIN; i++) {
      h.pushLlm({ role: "assistant", content: `filler ${i}` });
    }
    expect(h.llm[0]?.role).toBe("assistant");
    expect(h.llm[1]?.role).toBe("tool");

    // Push until the call is gone, checking at every push that it never left
    // its result behind.
    for (let i = 0; JSON.stringify(h.llm).includes('"c1"'); i++) {
      h.pushLlm({ role: "user", content: `one more question ${i}` });
      expect(h.llm[0]?.role).not.toBe("tool");
      expect(orphanToolResults(h.llm)).toEqual([]);
    }
  });

  // Turn sizes vary — a text-only turn is 2 messages, a one-tool turn 4, a tool
  // chain more — so the window drifts out of alignment with turn boundaries on
  // its own. (Under the old 200-message cap a uniform turn size hid this
  // entirely: 4 divides 200, so every trim landed on a turn boundary.)
  //
  // A SHORT generated list of tool-call counts, consumed CYCLICALLY over a
  // fixed number of turns (.agents/testing.md, "Property tests run on fast-check"). The
  // run makes `TURNS` decisions, and generating one entry per decision would
  // shrink to a wall of numbers rather than to a readable turn-shape cycle.
  // This replaced a hand-rolled LCG over a single fixed walk, which forfeited
  // shrinking on the one bug class the property exists for — a `capLlm` trim
  // orphaning a `tool` message — so a hit reported "iteration 287" instead of
  // the minimal cycle.
  const turnShapesArb = fc.array(fc.integer({ min: 0, max: 3 }), {
    minLength: 1,
    maxLength: 10,
  });
  // Enough turns that the bound (`RETAIN`) overflows several times over at
  // every generated shape, including the all-text-turns cycle (2 messages/turn),
  // and no more: this is a UNIT test on a 5s budget shared with 169 other files,
  // and 400x40 timed out under `pnpm test` while passing in ~500 ms alone.
  const TURNS = 120;
  const NUM_RUNS = 25;

  type Coverage = {
    textOnlyTurn: number;
    toolTurn: number;
    multiToolTurn: number;
    healedTrim: number;
  };

  /**
   * Whether a NAIVE token cut over `pre` — the plain "drop the front while the
   * rest still reaches `RETAIN`", with no regard for pairs — would land on a
   * `tool` message: the state where `evictLlm`'s pair rule is what decides.
   */
  function naiveCutIsTool(pre: readonly ModelMessage[]): boolean {
    let rest = llmTokens(pre);
    let start = 0;
    for (let m = pre[start]; m !== undefined && start < pre.length - 1; m = pre[start]) {
      if (rest - estimateMessageTokens(m) < RETAIN) break;
      rest -= estimateMessageTokens(m);
      start++;
    }
    return start > 0 && pre[start]?.role === "tool";
  }

  /**
   * One turn's messages, pushed as a turn does. Returns the next tool-call id
   * counter, and whether any push's naive cut would have split a pair.
   */
  function pushTurn(
    h: ReturnType<typeof createPipelineHistory>,
    turn: number,
    toolCalls: number,
    callNo: number,
  ): { next: number; healed: boolean } {
    let next = callNo;
    let healed = false;
    const push = (...msgs: ModelMessage[]): void => {
      const before = [...h.llm];
      healed = naiveCutIsTool([...before, ...h.pushLlm(...msgs)]) || healed;
    };
    push({ role: "user", content: `question ${turn}` });
    for (let k = 0; k < toolCalls; k++) {
      const id = `c${next++}`;
      push(toolCallMsg(id), toolResultMsg(id));
    }
    push({ role: "assistant", content: `reply ${turn}` });
    return { next, healed };
  }

  function recordTurn(cov: Coverage, toolCalls: number, healed: boolean): void {
    if (toolCalls === 0) cov.textOnlyTurn++;
    else cov.toolTurn++;
    if (toolCalls >= 2) cov.multiToolTurn++;
    if (healed) cov.healedTrim++;
  }

  test("a long conversation of mixed turn shapes never orphans a tool result", () => {
    // Coverage floors, per AGENTS.md: an all-green property proves nothing
    // about a state the generator never entered, and `healedTrim` — a trim that
    // actually landed between a call and its result, so `capLlm` had to shift a
    // leading `tool` message off — is the only state this property is really
    // about. Accumulated across every run (a floor is about the whole run).
    const cov: Coverage = { textOnlyTurn: 0, toolTurn: 0, multiToolTurn: 0, healedTrim: 0 };
    fc.assert(
      fc.property(turnShapesArb, (shapes) => {
        const h = createPipelineHistory(undefined, { retainTokens: RETAIN });
        let callNo = 0;
        let reached = false;
        let underBound = 0;
        // Collected and asserted ONCE per run rather than per turn: shrinking
        // re-runs the property dozens of times, and an `expect` per turn is
        // most of the cost. Sliced on report, the way `pipeline-fuzz` does it —
        // a systemic break should print a readable sample, not 150 lines of the
        // same thing.
        const orphans: string[] = [];
        for (let turn = 0; turn < TURNS; turn++) {
          const toolCalls = shapes[turn % shapes.length] ?? 0;
          const pushed = pushTurn(h, turn, toolCalls, callNo);
          callNo = pushed.next;
          recordTurn(cov, toolCalls, pushed.healed);
          orphans.push(...orphanToolResults(h.llm));
          // Once the record has reached the bound it never goes back below it
          // — not even when keeping a pair whole took an extra message off.
          const held = llmTokens(h.llm);
          if (held >= RETAIN) reached = true;
          else if (reached) underBound++;
        }
        expect(orphans.slice(0, 8)).toEqual([]);
        expect(underBound).toBe(0);
      }),
      { numRuns: NUM_RUNS },
    );

    // `HISTORY_FUZZ_COVERAGE=1` prints the table, the way the pipeline and S2S
    // properties do. It is how the actuals below were taken, and how the next
    // person re-takes them.
    if (process.env.HISTORY_FUZZ_COVERAGE === "1") console.log(JSON.stringify(cov));
    // Floors ~3x below the lowest of the measured runs (ranges in the trailing
    // comments), on the same rule the other property suites here use:
    // fast-check draws a fresh seed per run, so a floor is here to catch a
    // generator that stopped reaching a state, never to pin a count.
    expect(cov.textOnlyTurn, "no turn was ever text-only").toBeGreaterThan(170); // 511-984
    expect(cov.toolTurn, "no turn ever called a tool").toBeGreaterThan(670); // 2016-2489
    expect(cov.multiToolTurn, "no turn ever chained two tool calls").toBeGreaterThan(390); // 1180-1585
    expect(cov.healedTrim, "no naive cut ever split a tool-call pair").toBeGreaterThan(700); // 2112-2569 over 7 runs at RETAIN = 600
  });

  test("healing the split never strands a call whose result survived", () => {
    // The trim only ever removes from the front, so a leading `tool` message is
    // the one shape it could produce — a call is never separated from a result
    // that comes after it.
    const h = createPipelineHistory(undefined, { retainTokens: RETAIN });
    for (let i = 0; i < 200; i++) {
      const id = `c${i}`;
      h.pushLlm(toolCallMsg(id), toolResultMsg(id));
      expect(orphanToolResults(h.llm)).toEqual([]);
    }
  });

  // A step that ended on an unsafe finish reason: the SDK never ran the call,
  // so the step's messages are the call ALONE (`../../../tools/call-pairs.ts`).
  test("a pushed tool call with no result is answered on the way in, and reported", () => {
    const warn = vi.fn();
    const h = createPipelineHistory(undefined, { log: { warn }, sid: "s1" });
    h.pushLlm({ role: "user", content: "look it up" });
    h.pushLlm(toolCallMsg("c1"));
    expect(h.llm.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
    expect(h.llm[2]).toMatchObject({
      content: [{ type: "tool-result", toolCallId: "c1", output: { type: "error-json" } }],
    });
    expect(warn).toHaveBeenCalledWith("Orphaned tool call repaired", {
      sid: "s1",
      toolCallId: "c1",
      toolName: "lookup",
    });
    // Paired now, so the next write finds nothing to do.
    h.pushLlm({ role: "user", content: "and?" });
    expect(warn).toHaveBeenCalledOnce();
  });

  test("a rewrite that removes a call does not strand its result", () => {
    const h = createPipelineHistory();
    // Matched by identity against the message as STORED, which is what
    // `pushLlm` answers.
    const [, call] = h.pushLlm(
      { role: "user", content: "q" },
      toolCallMsg("c1"),
      toolResultMsg("c1"),
    );
    if (call === undefined) throw new Error("nothing stored");
    h.rewrite({ llm: new Map([[call, null]]) });
    expect(h.llm.map((m) => m.role)).toEqual(["user"]);
  });
});
