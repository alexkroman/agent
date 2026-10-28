// Copyright 2026 the AAI authors. MIT license.
import type { Message } from "@alexkroman1/aai";
import type { ToolSchema } from "@alexkroman1/aai/manifest";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, test, vi } from "vitest";
import { makeLogger } from "../_logger-test-utils.ts";
import { isFailedToolResult } from "../_prepare-step.ts";
import {
  INTERRUPTED_RESULT,
  mismatchResult,
  transcriptOf,
  verifierPrompt,
  verifyWrite,
  withWriteVerification,
} from "./write-verifier.ts";

const RETURN: ToolSchema = {
  type: "function",
  name: "return_items",
  description: "Return delivered items.",
  parameters: { type: "object" },
  annotations: { readOnlyHint: false },
};
const LOOKUP: ToolSchema = {
  type: "function",
  name: "get_order",
  description: "Look up an order.",
  parameters: { type: "object" },
  annotations: { readOnlyHint: true },
};

function modelReplying(text: string) {
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: "text" as const, text }],
      finishReason: { unified: "stop" as const, raw: undefined },
      usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 1, text: 1, reasoning: undefined },
      },
      warnings: [],
    }),
  });
}
const CONVERSATION: Message[] = [
  { role: "user", content: "Return everything except the pet bed." },
  { role: "tool", toolName: "get_order", content: '{"items":[{"name":"Pet Bed"}]}' },
  { role: "assistant", content: "Returning all three items now." },
];

describe("transcriptOf / verifierPrompt", () => {
  test("labels each party and every tool result", () => {
    expect(transcriptOf(CONVERSATION)).toBe(
      "CALLER: Return everything except the pet bed.\n" +
        'RESULT of get_order: {"items":[{"name":"Pet Bed"}]}\n' +
        "AGENT: Returning all three items now.",
    );
  });

  test("the prompt carries the instructions, the conversation and the planned call", () => {
    const prompt = verifierPrompt({
      instructions: "Policy: refunds go to the original payment method.",
      transcript: transcriptOf(CONVERSATION),
      tool: RETURN,
      args: { order_id: "#W1" },
    });
    expect(prompt).toContain("Policy: refunds go to the original payment method.");
    expect(prompt).toContain("CALLER: Return everything except the pet bed.");
    expect(prompt).toContain(
      'return_items: Return delivered items.\narguments: {"order_id":"#W1"}',
    );
    expect(prompt).toContain("including when you are merely unsure");
  });
});

describe("verifyWrite", () => {
  const base = { instructions: "", messages: CONVERSATION, tool: RETURN, args: {} };

  test("a named mismatch is a refusal", async () => {
    const model = modelReplying(
      '{"verdict":"mismatch","mismatch":"The caller asked to keep the pet bed."}',
    );
    expect(await verifyWrite({ ...base, model })).toEqual({
      ok: false,
      mismatch: "The caller asked to keep the pet bed.",
    });
  });

  test("ok, a mismatch with nothing named, a broken reply, or an error all pass", async () => {
    expect(await verifyWrite({ ...base, model: modelReplying('{"verdict":"ok"}') })).toEqual({
      ok: true,
    });
    expect(await verifyWrite({ ...base, model: modelReplying('{"verdict":"mismatch"}') })).toEqual({
      ok: true,
    });
    expect(await verifyWrite({ ...base, model: modelReplying("not json") })).toEqual({ ok: true });
    const failing = new MockLanguageModelV3({
      doGenerate: async () => {
        throw new Error("model unavailable");
      },
    });
    expect(await verifyWrite({ ...base, model: failing })).toEqual({ ok: true });
  });
});

describe("withWriteVerification", () => {
  function wrap(verdict: { ok: true } | { ok: false; mismatch: string }) {
    const inner = vi.fn(async () => "done");
    const check = vi.fn(async () => verdict);
    const exec = withWriteVerification(inner, {
      schemas: [RETURN, LOOKUP],
      check,
      log: makeLogger(),
      sid: "s1",
    });
    return { exec, inner, check };
  }

  test("a read runs without a check", async () => {
    const { exec, inner, check } = wrap({ ok: false, mismatch: "x" });
    expect(await exec("get_order", {})).toBe("done");
    expect(check).not.toHaveBeenCalled();
    expect(inner).toHaveBeenCalledOnce();
  });

  test("a write that passes runs", async () => {
    const { exec, inner } = wrap({ ok: true });
    expect(await exec("return_items", { id: 1 })).toBe("done");
    expect(inner).toHaveBeenCalledOnce();
  });

  test("a held write does not run, and the same call made again does", async () => {
    const { exec, inner, check } = wrap({ ok: false, mismatch: "The caller kept the pet bed." });
    expect(await exec("return_items", { id: 1 })).toBe(
      mismatchResult("The caller kept the pet bed."),
    );
    expect(inner).not.toHaveBeenCalled();
    // A DIFFERENT call is checked afresh…
    await exec("return_items", { id: 2 });
    expect(check).toHaveBeenCalledTimes(2);
    // …but the model insisting on the first one gets it run, unchecked.
    expect(await exec("return_items", { id: 1 })).toBe("done");
    expect(check).toHaveBeenCalledTimes(2);
  });

  // The check opens a window the write did not have. A barge-in during it
  // aborts the turn, and the write must not land afterwards.
  test("a turn aborted while the check runs does not get its write", async () => {
    const inner = vi.fn(async () => "done");
    const turn = new AbortController();
    const seen: (AbortSignal | undefined)[] = [];
    const exec = withWriteVerification(inner, {
      schemas: [RETURN],
      check: async (_tool, _args, signal) => {
        seen.push(signal);
        turn.abort(); // the caller speaks while the check is out
        return { ok: true };
      },
      log: makeLogger(),
      sid: "s1",
    });
    expect(await exec("return_items", { id: 1 }, "s1", [], { signal: turn.signal })).toBe(
      INTERRUPTED_RESULT,
    );
    expect(inner).not.toHaveBeenCalled();
    expect(seen).toEqual([turn.signal]);
  });

  // The failed-call memo must not refuse the confirmed retry.
  test("the hold is not a failure the memo would remember", () => {
    expect(isFailedToolResult(mismatchResult("x"))).toBe(false);
  });
});
