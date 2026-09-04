// Copyright 2026 the AAI authors. MIT license.
// What one step may SEND, in tokens — the budget, the trim, and the
// calibration against the provider's own reported usage. See
// pipeline-context-budget.ts.

import { ASSEMBLYAI_GATEWAY_MODELS } from "@alexkroman1/aai/host-internal";
import type { LanguageModel, ModelMessage } from "ai";
import { describe, expect, test } from "vitest";
import { createFakeLanguageModel } from "../_fake-llm.ts";
import { silentLogger } from "../_test-utils.ts";
import {
  CONTEXT_WINDOW_RESERVE,
  type ContextBudgetStep,
  contextTokenBudget,
  createContextBudget,
  estimateMessageTokens,
  MESSAGE_TOKEN_OVERHEAD,
  modelContextTokens,
  trimToTokenBudget,
} from "./pipeline-context-budget.ts";

/** A gateway id whose window the catalog really carries, read from the catalog. */
const KNOWN_MODEL = "gpt-5.1";
const KNOWN_CONTEXT = ASSEMBLYAI_GATEWAY_MODELS[KNOWN_MODEL].context;

/** A RESOLVED model (the shape the transport holds) carrying `id`. */
function modelWithId(id: string): LanguageModel {
  return Object.assign(createFakeLanguageModel({ script: [] }), { modelId: id });
}

const text = (content: string): ModelMessage => ({ role: "user", content });
/** ~30 estimated tokens each, so a handful of them overflow a small budget. */
const bulky = (i: number): ModelMessage => text(`message ${i} ${"payload ".repeat(25)}`);

const toolCall = (id: string): ModelMessage => ({
  role: "assistant",
  content: [{ type: "tool-call", toolCallId: id, toolName: "lookup", input: {} }],
});
const toolResult = (id: string): ModelMessage => ({
  role: "tool",
  content: [
    {
      type: "tool-result",
      toolCallId: id,
      toolName: "lookup",
      output: { type: "text", value: "ok" },
    },
  ],
});

/** Estimated cost of a whole list, the quantity the budget bounds. */
const cost = (messages: readonly ModelMessage[]): number =>
  messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);

/** A `prepareStep` invocation, with only what the budget reads. */
function step(overrides: Partial<ContextBudgetStep> & Pick<ContextBudgetStep, "messages">) {
  return { stepNumber: 0, steps: [], ...overrides };
}

/** One completed step, reporting `inputTokens` as a provider does. */
const reported = (inputTokens: number | undefined) => ({ usage: { inputTokens } });

describe("modelContextTokens", () => {
  test("answers the catalog's window for an id the gateway advertises", () => {
    expect(modelContextTokens(KNOWN_MODEL)).toBe(KNOWN_CONTEXT);
  });

  test("reads the id off a resolved LanguageModel, not just a string", () => {
    expect(modelContextTokens(modelWithId(KNOWN_MODEL))).toBe(KNOWN_CONTEXT);
  });

  test("answers undefined for a model the catalog does not carry", () => {
    // An author-supplied provider or a custom `registerLlmKind` — see the
    // module doc: unknown is answered as unknown, never as a guessed default.
    expect(modelContextTokens("some-self-hosted-model")).toBeUndefined();
    expect(modelContextTokens(modelWithId("some-self-hosted-model"))).toBeUndefined();
  });
});

describe("contextTokenBudget", () => {
  test("reserves CONTEXT_WINDOW_RESERVE for the prompt, the tools and the reply", () => {
    const budget = contextTokenBudget(KNOWN_MODEL);
    expect(budget).toBe(Math.floor(KNOWN_CONTEXT * (1 - CONTEXT_WINDOW_RESERVE)));
    // Stated independently of the arithmetic above, so a reserve that drifted
    // to zero — spending the WHOLE window on messages — fails here.
    expect(budget).toBeLessThan(KNOWN_CONTEXT);
    expect(budget).toBeGreaterThan(0);
  });

  test("answers undefined for an unknown model", () => {
    expect(contextTokenBudget("some-self-hosted-model")).toBeUndefined();
  });

  test("every advertised gateway model resolves to a positive budget", () => {
    // The catalog is GENERATED, so a regeneration that dropped or zeroed a
    // `context` would otherwise move those models silently onto the fallback.
    for (const id of Object.keys(ASSEMBLYAI_GATEWAY_MODELS)) {
      expect.soft(contextTokenBudget(id), id).toBeGreaterThan(0);
    }
  });
});

describe("estimateMessageTokens", () => {
  test("charges per-message framing on top of the text", () => {
    // The empty message is pure framing, which is what the overhead IS: without
    // it a history of many short messages reads as very nearly free.
    expect(estimateMessageTokens(text(""))).toBeGreaterThanOrEqual(MESSAGE_TOKEN_OVERHEAD);
  });

  test("grows with the size of the message", () => {
    expect(estimateMessageTokens(text("hello world ".repeat(500)))).toBeGreaterThan(
      estimateMessageTokens(text("hello")) * 10,
    );
  });

  test("counts a tool result's STRUCTURE, not only its text", () => {
    // A tool result is almost entirely JSON structure — the shape that made a
    // message-count cap useless — so an estimate reading only text parts would
    // score the 106 KB case at nearly nothing.
    const state: ModelMessage = {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "t1",
          toolName: "read_state",
          output: { type: "json", value: { rows: Array.from({ length: 400 }, (_, i) => ({ i })) } },
        },
      ],
    };
    expect(estimateMessageTokens(state)).toBeGreaterThan(500);
  });

  test("is memoized per message object", () => {
    const message = text("hello");
    expect(estimateMessageTokens(message)).toBe(estimateMessageTokens(message));
  });
});

describe("trimToTokenBudget", () => {
  test("a list that fits comes back untouched, by identity", () => {
    const messages = [bulky(0), bulky(1), bulky(2)];
    const kept = trimToTokenBudget(messages, 10_000, 0);
    expect(kept).toHaveLength(3);
    expect(kept[0]).toBe(messages[0]);
    expect(kept[2]).toBe(messages[2]);
  });

  test("a list that overflows drops oldest until it fits", () => {
    const messages = Array.from({ length: 40 }, (_, i) => bulky(i));
    const kept = trimToTokenBudget(messages, 200, 0);
    expect(kept.length).toBeLessThan(messages.length);
    expect(cost(kept)).toBeLessThanOrEqual(200);
    // Oldest first, newest kept.
    expect(kept.at(-1)).toBe(messages.at(-1));
    expect(kept).not.toContain(messages[0]);
  });

  test("the measured overhead counts against the same budget", () => {
    const messages = Array.from({ length: 20 }, (_, i) => bulky(i));
    const withoutOverhead = trimToTokenBudget(messages, 400, 0);
    const withOverhead = trimToTokenBudget(messages, 400, 300);
    // The system prompt and tool declarations are in the request too, so a
    // measured overhead leaves less room for messages, never more.
    expect(withOverhead.length).toBeLessThan(withoutOverhead.length);
    expect(cost(withOverhead) + 300).toBeLessThanOrEqual(400);
  });

  test("a tool-call/result pair at the boundary goes whole, never split", () => {
    // A `tool` message whose call was cut is rejected outright by both
    // providers, so it fails the request rather than degrading the reply.
    const messages = [
      toolCall("c1"),
      toolResult("c1"),
      ...Array.from({ length: 8 }, (_, i) => bulky(i)),
    ];
    for (let limit = 20; limit <= 400; limit += 7) {
      const kept = trimToTokenBudget(messages, limit, 0);
      const holdsCall = kept.includes(messages[0] as ModelMessage);
      const holdsResult = kept.includes(messages[1] as ModelMessage);
      expect.soft(holdsResult, `limit ${limit}`).toBe(holdsCall);
      expect.soft(kept[0]?.role, `limit ${limit}`).not.toBe("tool");
    }
  });

  test("the newest message survives however far over budget it is", () => {
    // An empty message list is a provider error, and the message left standing
    // is the one the caller just said — dropping it answers nothing.
    const messages = [bulky(0), bulky(1)];
    const kept = trimToTokenBudget(messages, 1, 0);
    expect(kept).toEqual([messages[1]]);
  });

  test("an empty list stays empty rather than throwing", () => {
    expect(trimToTokenBudget([], 100, 0)).toEqual([]);
  });
});

describe("createContextBudget", () => {
  const budgetFor = (llm: LanguageModel) =>
    createContextBudget({ llm, log: silentLogger, sid: "sid-1" });

  test("an unknown context window yields NO preparer, so nothing is trimmed", () => {
    // The fallback the module doc promises: the session is then bounded by
    // DEFAULT_MAX_HISTORY alone, exactly as it was before this existed.
    expect(budgetFor(modelWithId("some-self-hosted-model"))).toBeUndefined();
  });

  test("a list that fits produces no override at all", () => {
    const prepare = budgetFor(KNOWN_MODEL);
    expect(prepare?.(step({ messages: [bulky(0), bulky(1)] }))).toBeUndefined();
  });

  test("a list that overflows is overridden with a trimmed one", () => {
    // `gpt-5.1`'s window is 400k, so overflowing it honestly takes a big list:
    // one message of ~120k tokens against a 300k budget, three times over.
    const huge = (i: number): ModelMessage => text(`m${i} ${"payload ".repeat(120_000)}`);
    const messages = [huge(0), huge(1), huge(2), huge(3)];
    const result = budgetFor(KNOWN_MODEL)?.(step({ messages }));
    expect(result?.messages.length).toBeLessThan(messages.length);
    expect(result?.messages.at(-1)).toBe(messages.at(-1));
    // And the caller's own array is untouched: this bounds the REQUEST, never
    // the record the client, resume and `ctx.messages` read.
    expect(messages).toHaveLength(4);
  });

  /**
   * A measurement saying the last request spent the WHOLE budget.
   *
   * Written as the budget rather than a literal so the case states the claim
   * ("nothing further fits") instead of an arithmetic coincidence, and so it
   * survives a change to the reserve or to the catalog's window.
   */
  const WHOLE_BUDGET = contextTokenBudget(KNOWN_MODEL) ?? 0;

  test("CALIBRATES against the provider's reported inputTokens", () => {
    // Step 0 sends the whole (easily fitting) list. The provider then reports a
    // cost far above this module's estimate of it — the system prompt and the
    // tool declarations, which are in the request and not in the message list —
    // so on step 1 the appended reply no longer fits, though the estimate alone
    // would put the list at a few hundred tokens.
    const prepare = budgetFor(KNOWN_MODEL);
    const first = Array.from({ length: 6 }, (_, i) => bulky(i));
    expect(prepare?.(step({ messages: first }))).toBeUndefined();
    const next = [...first, text("assistant reply")];
    const trimmed = prepare?.({ stepNumber: 1, steps: [reported(WHOLE_BUDGET)], messages: next });
    expect(trimmed?.messages.length).toBeLessThan(next.length);
  });

  test("a provider that reports no inputTokens leaves the estimate alone", () => {
    // `LanguageModelUsage.inputTokens` is `number | undefined`; an absent count
    // must not be read as zero, which would learn an overhead of nothing and
    // (worse) look like a successful calibration. Same list as the case above,
    // which trims — the measurement is the only difference.
    const prepare = budgetFor(KNOWN_MODEL);
    const first = Array.from({ length: 6 }, (_, i) => bulky(i));
    expect(prepare?.(step({ messages: first }))).toBeUndefined();
    const next = [...first, text("assistant reply")];
    expect(
      prepare?.({ stepNumber: 1, steps: [reported(undefined)], messages: next }),
    ).toBeUndefined();
  });

  test("the learned overhead carries into the NEXT turn's first step", () => {
    // The point of building this per SESSION: the system prompt and the tool
    // schemas do not change between turns, so turn 2's step 0 — the step most
    // turns are the whole of — starts calibrated instead of blind.
    const prepare = budgetFor(KNOWN_MODEL);
    const first = Array.from({ length: 6 }, (_, i) => bulky(i));
    prepare?.(step({ messages: first }));
    prepare?.({ stepNumber: 1, steps: [reported(WHOLE_BUDGET)], messages: first });
    // A NEW `streamText` call (stepNumber 0 again), no steps behind it.
    const second = [...first, bulky(99)];
    expect(prepare?.(step({ messages: second }))?.messages.length).toBeLessThan(second.length);
  });

  test("a message list that does not extend the recorded prefix is not calibrated", () => {
    // The identity check. An override is documented to carry forward, so the
    // next step's list should extend the one just sent; if it does not, this
    // module's model of the loop is wrong and estimating everything is the safe
    // move — never trusting a measurement against a list it did not describe.
    const prepare = budgetFor(KNOWN_MODEL);
    prepare?.(step({ messages: Array.from({ length: 6 }, (_, i) => bulky(i)) }));
    const unrelated = [text("something else entirely"), text("and another")];
    expect(
      prepare?.({ stepNumber: 1, steps: [reported(WHOLE_BUDGET)], messages: unrelated }),
    ).toBeUndefined();
  });

  test("a trimmed step's own prefix is what the NEXT step is measured against", () => {
    // The recorded prefix is what was SENT, not what was offered — otherwise
    // the calibration would attribute the provider's count to messages the
    // provider never saw, and (here) would compute an overhead of zero and
    // trim nothing.
    const prepare = budgetFor(KNOWN_MODEL);
    const huge = (i: number): ModelMessage => text(`m${i} ${"payload ".repeat(120_000)}`);
    const messages = [huge(0), huge(1), huge(2), huge(3)];
    const sent = prepare?.(step({ messages }));
    expect(sent?.messages.length).toBeLessThan(messages.length);
    // The next step's list is what was sent plus the step's response messages.
    const next = [...(sent?.messages ?? []), text("assistant reply")];
    const trimmed = prepare?.({
      stepNumber: 1,
      steps: [reported(WHOLE_BUDGET)],
      messages: next,
    });
    expect(trimmed?.messages.length).toBeLessThan(next.length);
  });
});
