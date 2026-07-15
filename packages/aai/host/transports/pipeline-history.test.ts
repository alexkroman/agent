// Copyright 2026 the AAI authors. MIT license.

import { describe, expect, test } from "vitest";
import type { Message } from "../../sdk/types.ts";
import { createPipelineHistory } from "./pipeline-history.ts";

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
