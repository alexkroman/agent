// Copyright 2026 the AAI authors. MIT license.

import type { ModelMessage } from "ai";
import { describe, expect, test } from "vitest";
import { DEFAULT_MAX_HISTORY } from "../../sdk/constants.ts";
import type { Message } from "../../sdk/types.ts";
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

  test("a long conversation of mixed turn shapes never orphans a tool result", () => {
    // Turn sizes vary — a text-only turn is 2 messages, a one-tool turn 4, a
    // tool chain more — so the window drifts out of alignment with turn
    // boundaries on its own. A uniform turn size hides this entirely: 4
    // divides DEFAULT_MAX_HISTORY, so every trim lands on a turn boundary.
    let state = 12_345;
    const rnd = (): number => {
      state = (state * 1_103_515_245 + 12_345) & 0x7f_ff_ff_ff;
      return state / 0x7f_ff_ff_ff;
    };
    const h = createPipelineHistory();
    let callNo = 0;
    for (let turn = 0; turn < 400; turn++) {
      h.pushLlm({ role: "user", content: `question ${turn}` });
      const toolCalls = Math.floor(rnd() * 3);
      for (let k = 0; k < toolCalls; k++) {
        const id = `c${callNo++}`;
        h.pushLlm(toolCallMsg(id), toolResultMsg(id));
      }
      h.pushLlm({ role: "assistant", content: `reply ${turn}` });
      expect(orphanToolResults(h.llm)).toEqual([]);
      expect(h.llm.length).toBeLessThanOrEqual(DEFAULT_MAX_HISTORY);
    }
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
