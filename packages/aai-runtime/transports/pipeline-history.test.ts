// Copyright 2026 the AAI authors. MIT license.

import type { Message } from "@alexkroman1/aai";
import { DEFAULT_MAX_HISTORY } from "@alexkroman1/aai/internal";
import type { ModelMessage } from "ai";
import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { createPipelineHistory, persistInterruptedTurn } from "./pipeline-history.ts";
import { estimateMessageTokens } from "./pipeline-history-budget.ts";

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

  test("caps each view at DEFAULT_MAX_HISTORY (200), trimming oldest", () => {
    const h = createPipelineHistory();
    for (let i = 0; i < 250; i++) {
      h.pushConversation({ role: "user", content: `m${i}` });
      h.pushLlm({ role: "user", content: `m${i}` });
    }
    expect(h.conversation).toHaveLength(200);
    expect(h.llm).toHaveLength(200);
    // Oldest trimmed: m0..m49 gone, m249 retained.
    expect(h.conversation[0]?.content).toBe("m50");
    expect(h.conversation.at(-1)?.content).toBe("m249");
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

// The LLM view holds tool-call/result PAIRS, and the cap is an index trim, so
// its boundary can land between the two. Both providers reject an orphaned
// `tool` message outright (OpenAI: "messages with role 'tool' must be a
// response to a preceding message with 'tool_calls'"), which fails every
// remaining turn of a long call — see capLlm in pipeline-history.ts.
describe("createPipelineHistory — LLM history cap and tool-call pairing", () => {
  test("trimming an assistant tool-call drops the result it orphaned", () => {
    const h = createPipelineHistory();
    // Put a tool pair at the very front of a full window.
    h.pushLlm(toolCallMsg("c1"), toolResultMsg("c1"));
    for (let i = 0; i < DEFAULT_MAX_HISTORY - 2; i++) {
      h.pushLlm({ role: "assistant", content: `filler ${i}` });
    }
    expect(h.llm).toHaveLength(DEFAULT_MAX_HISTORY);
    expect(h.llm[0]?.role).toBe("assistant");
    expect(h.llm[1]?.role).toBe("tool");

    // One more message pushes the window past the tool-call.
    h.pushLlm({ role: "user", content: "one more question" });

    expect(h.llm[0]?.role).not.toBe("tool");
    expect(orphanToolResults(h.llm)).toEqual([]);
  });

  // Turn sizes vary — a text-only turn is 2 messages, a one-tool turn 4, a tool
  // chain more — so the window drifts out of alignment with turn boundaries on
  // its own. A uniform turn size hides this entirely: 4 divides
  // DEFAULT_MAX_HISTORY, so every trim lands on a turn boundary.
  //
  // A SHORT generated list of tool-call counts, consumed CYCLICALLY over a
  // fixed number of turns (AGENTS.md, "Property tests run on fast-check"). The
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
  // Enough turns that the window (200) overflows several times over at every
  // generated shape, including the all-text-turns cycle (2 messages/turn), and
  // no more: this is a UNIT test on a 5s budget shared with 169 other files,
  // and 400x40 timed out under `pnpm test` while passing in ~500 ms alone.
  const TURNS = 120;
  const NUM_RUNS = 25;

  type Coverage = {
    textOnlyTurn: number;
    toolTurn: number;
    multiToolTurn: number;
    healedTrim: number;
  };

  /** One turn's messages. Returns the next tool-call id counter. */
  function pushTurn(
    h: ReturnType<typeof createPipelineHistory>,
    turn: number,
    toolCalls: number,
    callNo: number,
  ): number {
    let next = callNo;
    h.pushLlm({ role: "user", content: `question ${turn}` });
    for (let k = 0; k < toolCalls; k++) {
      const id = `c${next++}`;
      h.pushLlm(toolCallMsg(id), toolResultMsg(id));
    }
    h.pushLlm({ role: "assistant", content: `reply ${turn}` });
    return next;
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
        const h = createPipelineHistory();
        let callNo = 0;
        let pushed = 0;
        let overCap = 0;
        // Collected and asserted ONCE per run rather than per turn: shrinking
        // re-runs the property dozens of times, and an `expect` per turn is
        // most of the cost. Sliced on report, the way `pipeline-fuzz` does it —
        // a systemic break should print a readable sample, not 150 lines of the
        // same thing.
        const orphans: string[] = [];
        for (let turn = 0; turn < TURNS; turn++) {
          const toolCalls = shapes[turn % shapes.length] ?? 0;
          callNo = pushTurn(h, turn, toolCalls, callNo);
          pushed += 2 + toolCalls * 2;
          // Once the window is full it holds exactly DEFAULT_MAX_HISTORY unless
          // the heal shifted a leading `tool` message off the front.
          const healed = pushed >= DEFAULT_MAX_HISTORY && h.llm.length < DEFAULT_MAX_HISTORY;
          recordTurn(cov, toolCalls, healed);
          orphans.push(...orphanToolResults(h.llm));
          if (h.llm.length > DEFAULT_MAX_HISTORY) overCap++;
        }
        expect(orphans.slice(0, 8)).toEqual([]);
        expect(overCap).toBe(0);
      }),
      { numRuns: NUM_RUNS },
    );

    // `HISTORY_FUZZ_COVERAGE=1` prints the table, the way the pipeline and S2S
    // properties do. It is how the actuals below were taken, and how the next
    // person re-takes them.
    if (process.env.HISTORY_FUZZ_COVERAGE === "1") console.log(JSON.stringify(cov));
    // Floors ~3x below the lowest of seven measured runs (ranges in the trailing
    // comments), on the same rule the other property suites here use:
    // fast-check draws a fresh seed per run, so a floor is here to catch a
    // generator that stopped reaching a state, never to pin a count.
    expect(cov.textOnlyTurn, "no turn was ever text-only").toBeGreaterThan(170); // 511-984
    expect(cov.toolTurn, "no turn ever called a tool").toBeGreaterThan(670); // 2016-2489
    expect(cov.multiToolTurn, "no turn ever chained two tool calls").toBeGreaterThan(390); // 1180-1585
    expect(cov.healedTrim, "no trim ever split a tool-call pair").toBeGreaterThan(200); // 609-1125
  });

  test("healing the split never strands a call whose result survived", () => {
    // The trim only ever removes from the front, so a leading `tool` message is
    // the one shape it can produce — a call is never separated from a result
    // that comes after it.
    const h = createPipelineHistory();
    for (let i = 0; i < DEFAULT_MAX_HISTORY; i++) {
      const id = `c${i}`;
      h.pushLlm(toolCallMsg(id), toolResultMsg(id));
      expect(orphanToolResults(h.llm)).toEqual([]);
    }
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
  test("restores the message its own push trimmed at the text cap", () => {
    const h = createPipelineHistory();
    for (let i = 0; i < DEFAULT_MAX_HISTORY; i++) {
      h.pushConversation({ role: "user", content: `turn ${i}` });
    }
    h.pushConversation({ role: "user", content: "RESUME_PROMPT" });
    // The push evicted the oldest turn to stay at the cap.
    expect(h.conversation[0]).toEqual({ role: "user", content: "turn 1" });

    h.dropTrailingUser("RESUME_PROMPT");

    // A rollback that undid the append and not the eviction would leave 199
    // messages starting at `turn 1` — the oldest real turn gone for good.
    expect(h.conversation).toHaveLength(DEFAULT_MAX_HISTORY);
    expect(h.conversation[0]).toEqual({ role: "user", content: "turn 0" });
  });

  test("restores the tool-pair half `capLlm` healed at the LLM cap", () => {
    const h = createPipelineHistory();
    for (let i = 0; i < DEFAULT_MAX_HISTORY / 2; i++) {
      h.pushLlm(toolCallMsg(`c${i}`), toolResultMsg(`c${i}`));
    }
    h.pushLlm({ role: "user", content: "RESUME_PROMPT" });
    // The trim dropped `c0`'s call and exposed its result at the front, which
    // `capLlm` then shifted as well: TWO messages left on this one push.
    expect(h.llm).toHaveLength(DEFAULT_MAX_HISTORY - 1);

    h.dropTrailingUser("RESUME_PROMPT");

    expect(h.llm).toHaveLength(DEFAULT_MAX_HISTORY);
    expect(orphanToolResults(h.llm)).toEqual([]);
  });
});

describe("persistInterruptedTurn — the record is what was HEARD", () => {
  function setup(): {
    history: ReturnType<typeof createPipelineHistory>;
    agentContext: string[];
  } {
    const agentContext: string[] = [];
    return { history: createPipelineHistory(), agentContext };
  }

  test("writes the heard prefix, marked [interrupted]", () => {
    const { history, agentContext } = setup();
    persistInterruptedTurn({
      history,
      heard: "Your balance is",
      persistedLen: 0,
      stepMessages: [],
      updateAgentContext: (t) => agentContext.push(t),
    });
    expect(history.conversation).toEqual([
      { role: "assistant", content: "Your balance is [interrupted]" },
    ]);
    expect(history.llm).toEqual([{ role: "assistant", content: "Your balance is [interrupted]" }]);
    // The STT bias hint is the agent's own voice echoing back, so it gets what
    // was in the air rather than what the model generated.
    expect(agentContext).toEqual(["Your balance is"]);
  });

  test("writes NOTHING to either view when the caller heard none of it", () => {
    const { history, agentContext } = setup();
    persistInterruptedTurn({
      history,
      heard: "",
      persistedLen: 0,
      stepMessages: [],
      updateAgentContext: (t) => agentContext.push(t),
    });
    expect(history.conversation).toEqual([]);
    expect(history.llm).toEqual([]);
    expect(agentContext).toEqual([]);
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
      updateAgentContext: () => undefined,
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
      updateAgentContext: () => undefined,
    });
    expect(history.conversation).toEqual([
      { role: "assistant", content: "Your balance [interrupted]" },
    ]);
    // The step message already carried it, so the LLM view gets no duplicate.
    expect(history.llm).toEqual([]);
  });
});

// The PRIMARY bound on the LLM view. A message count does not correlate with
// tokens — a `retail`-shaped tool result is ~106 KB, and 200 of those is an
// order of magnitude past any context window — so the count cap alone let the
// view overflow the model and fail at the provider mid-call. See
// pipeline-history-budget.ts.
describe("createPipelineHistory — LLM token budget", () => {
  /** Tokens the whole LLM view currently estimates at. */
  const cost = (h: { llm: readonly ModelMessage[] }): number =>
    h.llm.reduce((sum, m) => sum + estimateMessageTokens(m), 0);

  const bulky = (i: number): ModelMessage => ({
    role: "user",
    content: `message ${i} ${"payload ".repeat(200)}`,
  });

  test("a history that fits is untouched, by identity", () => {
    const h = createPipelineHistory(undefined, { llmTokenBudget: 100_000 });
    const sent = [bulky(0), bulky(1), bulky(2)];
    for (const m of sent) h.pushLlm(m);
    expect(h.llm).toHaveLength(3);
    // By identity: the messages in the view are the objects that were pushed,
    // so nothing was rewritten or reconstructed on the way through.
    expect(h.llm[0]).toBe(sent[0]);
    expect(h.llm[2]).toBe(sent[2]);
    expect(cost(h)).toBeLessThanOrEqual(100_000);
  });

  test("a history that overflows trims oldest until it fits", () => {
    const budget = 2000;
    const h = createPipelineHistory(undefined, { llmTokenBudget: budget });
    for (let i = 0; i < 60; i++) h.pushLlm(bulky(i));
    // Well under the message cap, so the COUNT cap cannot be what trimmed.
    expect(h.llm.length).toBeLessThan(DEFAULT_MAX_HISTORY);
    expect(h.llm.length).toBeGreaterThan(0);
    expect(cost(h)).toBeLessThanOrEqual(budget);
    // Oldest first, newest kept: the last message pushed is the last one held.
    expect(h.llm.at(-1)?.content).toContain("message 59");
    expect(JSON.stringify(h.llm)).not.toContain("message 0 ");
  });

  test("the newest message survives however far over budget it is", () => {
    // An empty message list is a provider error, and the message left standing
    // is the one the caller just said — dropping it answers nothing.
    const h = createPipelineHistory(undefined, { llmTokenBudget: 1 });
    h.pushLlm(bulky(0));
    h.pushLlm(bulky(1));
    expect(h.llm).toHaveLength(1);
    expect(h.llm[0]?.content).toContain("message 1");
  });

  test("a tool-call/result pair at the budget boundary goes whole, never split", () => {
    // The trim boundary landing between an assistant `tool-call` and the `tool`
    // message answering it is what both providers reject outright.
    const budget = 1500;
    const h = createPipelineHistory(undefined, { llmTokenBudget: budget });
    h.pushLlm(toolCallMsg("c1"), toolResultMsg("c1"));
    for (let i = 0; i < 40; i++) h.pushLlm(bulky(i));
    const held = JSON.stringify(h.llm);
    // Either the whole pair is still there or neither half is — never one.
    expect(held.includes("tool-call")).toBe(held.includes("tool-result"));
    expect(orphanToolResults(h.llm)).toEqual([]);
    expect(cost(h)).toBeLessThanOrEqual(budget);
  });

  test("an unknown context window falls back to the message-count cap alone", () => {
    // `historyTokenBudget` answers undefined for a model this repo carries no
    // window for (an author-supplied provider, a custom `registerLlmKind`), and
    // the view then behaves exactly as it did before the budget existed.
    const h = createPipelineHistory(undefined, { llmTokenBudget: undefined });
    const bounded = createPipelineHistory(undefined, { llmTokenBudget: 2000 });
    for (let i = 0; i < 250; i++) {
      h.pushLlm(bulky(i));
      bounded.pushLlm(bulky(i));
    }
    expect(h.llm).toHaveLength(DEFAULT_MAX_HISTORY);
    // Stated against the budgeted run of the same script: the fallback keeps a
    // view far more expensive than any budget would allow, deliberately, since
    // guessing a window is what it refuses to do.
    expect(cost(h)).toBeGreaterThan(cost(bounded) * 10);
  });

  test("a seed is budgeted too, not only later pushes", () => {
    const seed: Message[] = Array.from({ length: 60 }, (_, i) => ({
      role: "user",
      content: `seeded ${i} ${"payload ".repeat(200)}`,
    }));
    const h = createPipelineHistory(seed, { llmTokenBudget: 2000 });
    expect(cost(h)).toBeLessThanOrEqual(2000);
    // Only the LLM view is token-bounded; the text view keeps its count cap.
    expect(h.conversation).toHaveLength(60);
  });

  test("a rollback at the token boundary restores what its own push evicted", () => {
    // The same inverse `dropTrailingUser` owes the COUNT cap — a push that
    // trims and a pop that does not leave the window permanently shallower.
    const synthetic = `synthetic ${"payload ".repeat(200)}`;
    const h = createPipelineHistory(undefined, { llmTokenBudget: 2000 });
    for (let i = 0; i < 40; i++) h.pushLlm(bulky(i));
    const before = [...h.llm];
    h.pushLlm({ role: "user", content: synthetic });
    expect(h.llm.length).toBeLessThan(before.length + 1);
    h.dropTrailingUser(synthetic);
    expect(h.llm).toEqual(before);
  });
});
