// Copyright 2026 the AAI authors. MIT license.

import type { Message } from "@alexkroman1/aai";
import type { ModelMessage } from "ai";
import { describe, expect, test, vi } from "vitest";
import { pairToolCalls } from "../tool-call-pairs.ts";
import {
  LONG_PROMPT,
  llmTokens,
  orphanToolResults,
  RETAIN,
  textTokens,
  toolCallMsg,
  toolResultMsg,
} from "./_pipeline-history-test-fakes.ts";
import { estimateMessageTokens, trimToTokenBudget } from "./pipeline-context-budget.ts";
import { createPipelineHistory, persistInterruptedTurn } from "./pipeline-history.ts";

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
