// Copyright 2026 the AAI authors. MIT license.

import type { Message } from "@alexkroman1/aai";
import type { ModelMessage } from "ai";
import fc from "fast-check";
import { describe, expect, test, vi } from "vitest";
import { estimateConversationTokens } from "../_history-retention.ts";
import { pairToolCalls } from "../tool-call-pairs.ts";
import { estimateMessageTokens, trimToTokenBudget } from "./pipeline-context-budget.ts";
import { createPipelineHistory, persistInterruptedTurn } from "./pipeline-history.ts";

/**
 * A small memory bound, so a spec reaches it in tens of messages rather than
 * megabytes. The default (`HISTORY_RETAIN_TOKENS`) is sized against the largest
 * request budget, and `_history-retention.test.ts` holds why it cannot reach
 * into a request; what is pinned HERE is the history's own use of the bound.
 */
const RETAIN = 600;
const textTokens = (ms: readonly Message[]): number =>
  ms.reduce((n, m) => n + estimateConversationTokens(m), 0);
const llmTokens = (ms: readonly ModelMessage[]): number =>
  ms.reduce((n, m) => n + estimateMessageTokens(m), 0);
/** A rolled-back prompt long enough that its push always evicts something. */
const LONG_PROMPT = `RESUME_PROMPT ${"please continue where you left off ".repeat(8)}`;

describe("createPipelineHistory", () => {
  test("starts empty when unseeded", () => {
    const h = createPipelineHistory();
    expect(h.conversation).toEqual([]);
    expect(h.llm).toEqual([]);
  });

  test("seeds both views from prior text history", () => {
    const seed: Message[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ];
    const h = createPipelineHistory(seed);
    expect(h.conversation).toHaveLength(2);
    expect(h.llm).toHaveLength(2);
    // Copied, not aliased — mutating the source must not leak in.
    (seed as Message[]).push({ role: "user", content: "later" });
    expect(h.conversation).toHaveLength(2);
  });

  test("pushConversation and pushLlm append to their own views independently", () => {
    const h = createPipelineHistory();
    h.pushConversation({ role: "user", content: "look me up" });
    h.pushLlm(
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "t1", toolName: "lookup", input: {} }],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "t1",
            toolName: "lookup",
            output: { type: "text", value: "USER_123" },
          },
        ],
      },
    );
    expect(h.conversation).toHaveLength(1);
    expect(h.llm).toHaveLength(2);
    // The tool result lives only in the LLM view, not the text view.
    expect(JSON.stringify(h.llm)).toContain("USER_123");
    expect(JSON.stringify(h.conversation)).not.toContain("USER_123");
  });

  test("reset clears both views", () => {
    const h = createPipelineHistory([{ role: "user", content: "hi" }]);
    h.pushLlm({ role: "assistant", content: "hi there" });
    h.reset();
    expect(h.conversation).toEqual([]);
    expect(h.llm).toEqual([]);
  });

  test("retains each view to `retainTokens`, trimming the oldest and never below it", () => {
    const h = createPipelineHistory(undefined, { retainTokens: RETAIN });
    for (let i = 0; i < 250; i++) {
      h.pushConversation({ role: "user", content: `m${i}` });
      h.pushLlm({ role: "user", content: `m${i}` });
    }
    // At least the bound — what the request budget relies on — and no more
    // than one message over it: one more eviction would go below.
    expect(textTokens(h.conversation)).toBeGreaterThanOrEqual(RETAIN);
    expect(textTokens(h.conversation.slice(1))).toBeLessThan(RETAIN);
    expect(llmTokens(h.llm)).toBeGreaterThanOrEqual(RETAIN);
    expect(llmTokens(h.llm.slice(1))).toBeLessThan(RETAIN);
    // Oldest trimmed, newest retained.
    expect(h.conversation[0]?.content).not.toBe("m0");
    expect(h.conversation.at(-1)?.content).toBe("m249");
  });

  test("has no message cap: an ordinary long call keeps every message", () => {
    // The 200-message cap this replaced dropped the front of any call past 100
    // turns, however short they were. A message count predicts neither memory
    // nor request size; the request is budgeted in tokens per step.
    const h = createPipelineHistory();
    for (let i = 0; i < 1000; i++) {
      h.pushConversation({ role: "user", content: `m${i}` });
      h.pushLlm({ role: "user", content: `m${i}` });
    }
    expect(h.conversation).toHaveLength(1000);
    expect(h.llm).toHaveLength(1000);
  });

  test("strips signature-less reasoning parts (avoids Anthropic replay warning)", () => {
    const h = createPipelineHistory();
    h.pushLlm({
      role: "assistant",
      content: [
        { type: "reasoning", text: "let me think..." },
        { type: "text", text: "Hello." },
      ],
    });
    expect(h.llm).toHaveLength(1);
    expect(JSON.stringify(h.llm)).not.toContain("reasoning");
    expect(JSON.stringify(h.llm)).toContain("Hello.");
  });

  test("drops an assistant message that is only signature-less reasoning", () => {
    const h = createPipelineHistory();
    h.pushLlm({ role: "assistant", content: [{ type: "reasoning", text: "thinking..." }] });
    expect(h.llm).toHaveLength(0);
  });

  test("keeps OpenAI reasoning items (required alongside their message item)", () => {
    // The OpenAI Responses API rejects a message item whose paired reasoning
    // item (rs_...) is missing from the replayed input, so these must survive.
    const h = createPipelineHistory();
    h.pushLlm({
      role: "assistant",
      content: [
        { type: "reasoning", text: "", providerOptions: { openai: { itemId: "rs_123" } } },
        { type: "text", text: "Hello.", providerOptions: { openai: { itemId: "msg_123" } } },
      ],
    });
    expect(h.llm).toHaveLength(1);
    expect(JSON.stringify(h.llm)).toContain("rs_123");
    expect(JSON.stringify(h.llm)).toContain("Hello.");
  });

  test("keeps a standalone OpenAI reasoning item", () => {
    const h = createPipelineHistory();
    h.pushLlm({
      role: "assistant",
      content: [{ type: "reasoning", text: "", providerOptions: { openai: { itemId: "rs_9" } } }],
    });
    expect(h.llm).toHaveLength(1);
    expect(JSON.stringify(h.llm)).toContain("rs_9");
  });

  test("keeps Anthropic reasoning that carries a valid thinking signature", () => {
    const h = createPipelineHistory();
    h.pushLlm({
      role: "assistant",
      content: [
        {
          type: "reasoning",
          text: "deliberation",
          providerOptions: { anthropic: { signature: "sig-abc" } },
        },
        { type: "text", text: "Answer." },
      ],
    });
    expect(h.llm).toHaveLength(1);
    expect(JSON.stringify(h.llm)).toContain("deliberation");
    expect(JSON.stringify(h.llm)).toContain("sig-abc");
  });

  test("keeps Anthropic redacted-thinking reasoning", () => {
    const h = createPipelineHistory();
    h.pushLlm({
      role: "assistant",
      content: [
        {
          type: "reasoning",
          text: "",
          providerOptions: { anthropic: { redactedData: "enc-blob" } },
        },
      ],
    });
    expect(h.llm).toHaveLength(1);
    expect(JSON.stringify(h.llm)).toContain("enc-blob");
  });

  test("pushToolResult reaches the tool-facing view and NOT the model's", () => {
    // The LLM view already holds the step's own assistant/`tool` PAIR; a second
    // copy from here would be the orphan result `capLlm` exists to remove.
    const h = createPipelineHistory([{ role: "user", content: "where is my order" }]);
    h.pushToolResult({
      role: "tool",
      content: "eta=tue",
      toolName: "lookup_order",
      toolCallId: "c1",
    });
    expect(h.conversation).toEqual([
      { role: "user", content: "where is my order" },
      { role: "tool", content: "eta=tue", toolName: "lookup_order", toolCallId: "c1" },
    ]);
    expect(h.llm).toEqual([{ role: "user", content: "where is my order" }]);
  });

  test("pushToolResult does not bump the revision", () => {
    // That epoch gates adopting a preemptive speculation, and a speculation's
    // request is assembled from `llm` — untouched here. Bumping would discard a
    // legitimate speculation every time a tool finished, which is exactly when
    // one is in flight.
    const h = createPipelineHistory();
    const before = h.revision.current();
    h.pushToolResult({ role: "tool", content: "{}", toolCallId: "c1" });
    expect(h.revision.isCurrent(before)).toBe(true);
  });

  test("pushToolResult retains the tool-facing view like every other push", () => {
    const seed = Array.from({ length: 200 }, (_, i) => ({
      role: "user" as const,
      content: `m${i}`,
    }));
    const h = createPipelineHistory(seed, { retainTokens: textTokens(seed) });
    h.pushToolResult({ role: "tool", content: LONG_PROMPT, toolCallId: "c1" });
    expect(h.conversation[0]).not.toEqual(seed[0]);
    expect(h.conversation.at(-1)).toMatchObject({ role: "tool", toolCallId: "c1" });
    expect(textTokens(h.conversation)).toBeGreaterThanOrEqual(textTokens(seed));
  });

  test("a seeded tool result reaches the tool-facing view only", () => {
    // What a reconnect hands `seedHistory`. In the LLM view it would be an
    // orphan, and mapping it to an assistant message — which is what
    // `toModelMessage` does with any non-`user` role — would tell the model it
    // had SAID the tool's serialized output.
    const h = createPipelineHistory();
    h.seed([
      { role: "user", content: "hi" },
      { role: "tool", content: "eta=tue", toolName: "lookup_order", toolCallId: "c1" },
      { role: "assistant", content: "Tuesday." },
    ]);
    expect(h.conversation).toHaveLength(3);
    expect(h.llm).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "Tuesday." },
    ]);
  });

  test("a model view seeds the LLM with the call/result PAIR, the conversation with the result", () => {
    // What `restoreHistory` hands over now: each prior call as the pair a live
    // turn leaves, so the model remembers it without an orphan result — and
    // without text shaped like a call for it to imitate (`modelHistoryOf`).
    const h = createPipelineHistory();
    const conversation: Message[] = [
      { role: "user", content: "hi" },
      { role: "tool", content: "eta=tue", toolName: "lookup_order", toolCallId: "c1" },
      { role: "assistant", content: "Tuesday." },
    ];
    const pair = [toolCallMsg("c1"), toolResultMsg("c1")];
    h.seed(conversation, [
      { role: "user", content: "hi" },
      ...pair,
      { role: "assistant", content: "Tuesday." },
    ]);
    expect(h.conversation).toEqual(conversation);
    expect(h.llm).toEqual([
      { role: "user", content: "hi" },
      ...pair,
      { role: "assistant", content: "Tuesday." },
    ]);
  });

  test("a model view is re-PAIRED on the way in, so a stray half cannot slip through", () => {
    // `modelHistoryOf` never builds a half-pair; this is the door's own guard,
    // the same one every other write goes through.
    const log = { warn: vi.fn() };
    const h = createPipelineHistory(undefined, { log, sid: "s1" });
    h.seed(
      [{ role: "user", content: "hi" }],
      [
        { role: "user", content: "hi" },
        toolResultMsg("c9"),
        { role: "assistant", content: "Hello." },
      ],
    );
    expect(h.llm).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "Hello." },
    ]);
    expect(log.warn).toHaveBeenCalledWith("Orphaned tool result dropped", {
      sid: "s1",
      toolCallId: "c9",
      toolName: "lookup",
    });
  });

  test("a seed of pairs past the bound never leaves an orphan, wherever the cut lands", () => {
    // A long resumed conversation is retained to the memory bound on the way
    // in, and a turn with one call is 4 messages. `shift` trailing replies move
    // the cut through every offset within a turn — including the one between a
    // call and its result.
    const turns: ModelMessage[] = [];
    for (let i = 0; i < 60; i++) {
      turns.push({ role: "user", content: `q${i}` }, toolCallMsg(`c${i}`), toolResultMsg(`c${i}`));
      turns.push({ role: "assistant", content: `a${i}` });
    }
    const fronts = new Set<string>();
    for (let shift = 0; shift < 12; shift++) {
      const tail = Array.from({ length: shift }, (_, i) => ({
        role: "assistant" as const,
        content: `more ${i}`,
      }));
      const h = createPipelineHistory(undefined, { retainTokens: RETAIN });
      h.seed([{ role: "user", content: "q0" }], [...turns, ...tail]);
      fronts.add(h.llm[0]?.role ?? "none");
      expect(h.llm.length).toBeLessThan(turns.length);
      expect(llmTokens(h.llm)).toBeGreaterThanOrEqual(RETAIN);
      expect(orphanToolResults(h.llm)).toEqual([]);
      expect(pairToolCalls(h.llm).repairs).toEqual([]);
    }
    // The cut moved: a window can start on a user turn, a call, or — once a
    // stranded result is healed away — a reply.
    expect(fronts).toEqual(new Set(["user", "assistant"]));
  });

  test("the per-request token budget never splits a seeded pair, at any limit", () => {
    // The second trim a seeded history meets: `trimToTokenBudget` cuts the
    // front of each REQUEST to the model's window, independently of retention.
    const llm: ModelMessage[] = [];
    for (let i = 0; i < 6; i++) {
      llm.push({ role: "user", content: `q${i}` }, toolCallMsg(`c${i}`), toolResultMsg(`c${i}`));
      llm.push({ role: "assistant", content: `a${i}` });
    }
    const total = llm.reduce((n, m) => n + estimateMessageTokens(m), 0);
    const leading = new Set<string>();
    for (let limit = 0; limit <= total; limit++) {
      const sent = trimToTokenBudget(llm, limit, 0);
      leading.add(sent[0]?.role ?? "none");
      expect(sent[0]?.role).not.toBe("tool");
      expect(pairToolCalls(sent).repairs).toEqual([]);
    }
    // The cut moved through the turn, not only across turn boundaries.
    expect(leading).toEqual(new Set(["user", "assistant"]));
  });

  test("a CONSTRUCTOR seed makes the same subtraction as `seed`", () => {
    // Two doors onto one rule: `createPipelineHistory(seed)` is what the
    // transport takes at construction, `seed()` what a reconnect calls.
    const h = createPipelineHistory([
      { role: "user", content: "hi" },
      { role: "tool", content: "eta=tue", toolCallId: "c1" },
    ]);
    expect(h.conversation).toHaveLength(2);
    expect(h.llm).toEqual([{ role: "user", content: "hi" }]);
  });
});

/** Tool-call ids that appear as a result with no preceding call. */
function orphanToolResults(llm: readonly ModelMessage[]): string[] {
  const called = new Set<string>();
  const orphans: string[] = [];
  for (const m of llm) {
    if (!Array.isArray(m.content)) continue;
    for (const part of m.content as { type?: string; toolCallId?: string }[]) {
      if (part.type === "tool-call" && part.toolCallId !== undefined) called.add(part.toolCallId);
      if (
        part.type === "tool-result" &&
        part.toolCallId !== undefined &&
        !called.has(part.toolCallId)
      ) {
        orphans.push(part.toolCallId);
      }
    }
  }
  return orphans;
}

const toolCallMsg = (id: string): ModelMessage =>
  ({
    role: "assistant",
    content: [{ type: "tool-call", toolCallId: id, toolName: "lookup", input: {} }],
  }) as ModelMessage;

const toolResultMsg = (id: string): ModelMessage =>
  ({
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: id,
        toolName: "lookup",
        output: { type: "text", value: "ok" },
      },
    ],
  }) as ModelMessage;

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
  // so the step's messages are the call ALONE (`../tool-call-pairs.ts`).
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

describe("createPipelineHistory — dropTrailingUser", () => {
  test("drops a matching trailing user message from both views", () => {
    // A synthetic prompt (false-interruption resume, silence nudge) is pushed
    // before the LLM stream runs. When the turn is aborted having produced
    // nothing — a resume mooted by the user's real turn — leaving it behind puts
    // "the user did not actually say anything" in front of the model directly
    // ahead of the words the user did say.
    const h = createPipelineHistory();
    h.pushConversation({ role: "user", content: "where is my order" });
    h.pushLlm({ role: "user", content: "where is my order" });
    h.pushConversation({ role: "user", content: "RESUME_PROMPT" });
    h.pushLlm({ role: "user", content: "RESUME_PROMPT" });

    h.dropTrailingUser("RESUME_PROMPT");

    expect(h.conversation).toEqual([{ role: "user", content: "where is my order" }]);
    expect(h.llm).toEqual([{ role: "user", content: "where is my order" }]);
  });

  test("leaves a trailing message it did not write alone", () => {
    const h = createPipelineHistory();
    h.pushConversation({ role: "user", content: "cancel my order" });
    h.pushLlm({ role: "user", content: "cancel my order" });

    h.dropTrailingUser("RESUME_PROMPT");

    expect(h.conversation).toHaveLength(1);
    expect(h.llm).toHaveLength(1);
  });

  test("leaves the prompt in place once something was persisted after it", () => {
    // The turn produced a reply tail, which is persisted beside the prompt and
    // answers it — dropping the prompt would orphan that assistant message.
    const h = createPipelineHistory();
    h.pushConversation({ role: "user", content: "RESUME_PROMPT" });
    h.pushLlm({ role: "user", content: "RESUME_PROMPT" });
    h.pushConversation({ role: "assistant", content: "As I was saying [interrupted]" });
    h.pushLlm({ role: "assistant", content: "As I was saying [interrupted]" });

    h.dropTrailingUser("RESUME_PROMPT");

    expect(h.conversation).toHaveLength(2);
    expect(h.llm).toHaveLength(2);
  });

  test("is a no-op on empty history", () => {
    const h = createPipelineHistory();
    h.dropTrailingUser("RESUME_PROMPT");
    expect(h.conversation).toEqual([]);
    expect(h.llm).toEqual([]);
  });

  // Two regression pins beside the property in
  // `pipeline-history-rollback.integration.test.ts`: a pin says "this shape still
  // works", the property says "no depth breaks it".
  test("restores the messages its own push evicted at the text bound", () => {
    const h = createPipelineHistory(undefined, { retainTokens: RETAIN });
    for (let i = 0; textTokens(h.conversation) < RETAIN; i++) {
      h.pushConversation({ role: "user", content: `turn ${i}` });
    }
    const full = [...h.conversation];
    h.pushConversation({ role: "user", content: LONG_PROMPT });
    // The push evicted the oldest turns to stay at the bound.
    expect(h.conversation[0]).not.toEqual({ role: "user", content: "turn 0" });

    h.dropTrailingUser(LONG_PROMPT);

    // A rollback that undid the append and not the eviction would leave the
    // view starting past `turn 0` — the oldest real turns gone for good.
    expect(h.conversation).toEqual(full);
  });

  test("restores the whole tool pair `evictLlm` took at the LLM bound", () => {
    const h = createPipelineHistory(undefined, { retainTokens: RETAIN });
    for (let i = 0; llmTokens(h.llm) < RETAIN; i++) {
      h.pushLlm(toolCallMsg(`c${i}`), toolResultMsg(`c${i}`));
    }
    const full = [...h.llm];
    h.pushLlm({ role: "user", content: LONG_PROMPT });
    // The eviction took `c0`'s call AND its result: the pair goes whole.
    expect(h.llm[0]?.role).toBe("assistant");
    expect(h.llm.length).toBeLessThan(full.length + 1);

    h.dropTrailingUser(LONG_PROMPT);

    expect(h.llm).toEqual(full);
    expect(orphanToolResults(h.llm)).toEqual([]);
  });
});

describe("persistInterruptedTurn — the record is what was HEARD", () => {
  function setup(): { history: ReturnType<typeof createPipelineHistory> } {
    return { history: createPipelineHistory() };
  }

  test("writes the heard prefix, marked [interrupted]", () => {
    const { history } = setup();
    persistInterruptedTurn({
      history,
      heard: "Your balance is",
      persistedLen: 0,
      stepMessages: [],
    });
    expect(history.conversation).toEqual([
      { role: "assistant", content: "Your balance is [interrupted]" },
    ]);
    expect(history.llm).toEqual([{ role: "assistant", content: "Your balance is [interrupted]" }]);
  });

  test("writes NOTHING to either view when the caller heard none of it", () => {
    const { history } = setup();
    persistInterruptedTurn({
      history,
      heard: "",
      persistedLen: 0,
      stepMessages: [],
    });
    expect(history.conversation).toEqual([]);
    expect(history.llm).toEqual([]);
  });

  test("still pushes the completed tool steps when nothing was heard", () => {
    // A turn whose tools ran left a real trace even if the caller heard no
    // words; dropping the steps makes the next turn re-call them.
    const { history } = setup();
    persistInterruptedTurn({
      history,
      heard: "",
      persistedLen: 0,
      stepMessages: [toolCallMsg("c1"), toolResultMsg("c1")],
    });
    expect(history.llm).toHaveLength(2);
    expect(history.conversation).toEqual([]);
  });

  test("a persistedLen past the heard prefix produces no LLM tail, not a bad slice", () => {
    // `persistedLen` indexes the GENERATED text, which the heard prefix is
    // shorter than — an unclamped slice would run off the end.
    const { history } = setup();
    persistInterruptedTurn({
      history,
      heard: "Your balance",
      persistedLen: 999,
      stepMessages: [],
    });
    expect(history.conversation).toEqual([
      { role: "assistant", content: "Your balance [interrupted]" },
    ]);
    // The step message already carried it, so the LLM view gets no duplicate.
    expect(history.llm).toEqual([]);
  });
});
