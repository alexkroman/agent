// Copyright 2026 the AAI authors. MIT license.

import { ASSEMBLYAI_GATEWAY_MODELS } from "@alexkroman1/aai/host-internal";
import type { LanguageModel, ModelMessage } from "ai";
import { describe, expect, test } from "vitest";
import { createFakeLanguageModel } from "../_fake-llm.ts";
import {
  estimateMessageTokens,
  HISTORY_CONTEXT_RESERVE,
  historyTokenBudget,
  MESSAGE_TOKEN_OVERHEAD,
  modelContextTokens,
} from "./pipeline-history-budget.ts";

/** A gateway id whose window the catalog really carries, read from the catalog. */
const KNOWN_MODEL = "gpt-5.1";
const KNOWN_CONTEXT = ASSEMBLYAI_GATEWAY_MODELS[KNOWN_MODEL].context;

/** A RESOLVED model (the shape the transport holds) carrying `id`. */
function modelWithId(id: string): LanguageModel {
  return Object.assign(createFakeLanguageModel({ script: [] }), { modelId: id });
}

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

describe("historyTokenBudget", () => {
  test("reserves HISTORY_CONTEXT_RESERVE of a known window for prompt, tools and output", () => {
    const budget = historyTokenBudget(KNOWN_MODEL);
    expect(budget).toBe(Math.floor(KNOWN_CONTEXT * (1 - HISTORY_CONTEXT_RESERVE)));
    // Stated independently of the arithmetic above, so a reserve that drifted
    // to zero (spending the WHOLE window on history) fails here.
    expect(budget).toBeLessThan(KNOWN_CONTEXT);
    expect(budget).toBeGreaterThan(0);
  });

  test("answers undefined for an unknown model, so the caller falls back to the count cap", () => {
    expect(historyTokenBudget("some-self-hosted-model")).toBeUndefined();
  });

  test("every advertised gateway model resolves to a positive budget", () => {
    // The catalog is GENERATED, so a regeneration that dropped or zeroed a
    // `context` would otherwise silently move those models onto the fallback.
    for (const id of Object.keys(ASSEMBLYAI_GATEWAY_MODELS)) {
      expect.soft(historyTokenBudget(id), id).toBeGreaterThan(0);
    }
  });
});

describe("estimateMessageTokens", () => {
  const text = (content: string): ModelMessage => ({ role: "user", content });

  test("charges per-message framing on top of the text", () => {
    // The empty message is pure framing, which is what the overhead IS: without
    // it a history of many short messages reads as very nearly free.
    expect(estimateMessageTokens(text(""))).toBeGreaterThanOrEqual(MESSAGE_TOKEN_OVERHEAD);
  });

  test("grows with the size of the message", () => {
    const short = estimateMessageTokens(text("hello"));
    const long = estimateMessageTokens(text("hello world ".repeat(500)));
    expect(long).toBeGreaterThan(short * 10);
  });

  test("counts a tool result's STRUCTURE, not only its text", () => {
    // A tool result is almost entirely JSON structure — the shape that made a
    // message-count cap useless — so an estimate reading only text parts would
    // score the 106 KB case at nearly nothing.
    const bulky: ModelMessage = {
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
    expect(estimateMessageTokens(bulky)).toBeGreaterThan(500);
  });

  test("is memoized per message object", () => {
    const message = text("hello");
    expect(estimateMessageTokens(message)).toBe(estimateMessageTokens(message));
  });
});
