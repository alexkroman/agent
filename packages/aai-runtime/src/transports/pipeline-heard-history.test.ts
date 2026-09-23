// Copyright 2026 the AAI authors. MIT license.
// Unit specs for taking back the unheard tail of a reply already committed to
// history. The wired-up cuts (drain phase, playback tail, a chained turn) live
// in pipeline-transport-heard-cut.test.ts.

import type { Message } from "@alexkroman1/aai";
import type { ModelMessage } from "ai";
import { describe, expect, test, vi } from "vitest";
import { createTestClock } from "../_pipeline-test-fakes.ts";
import { silentLogger } from "../runtime-config.ts";
import { createHeardTracker } from "./pipeline-heard.ts";
import {
  createHeardHistory,
  type PersistedReply,
  truncateToHeard,
} from "./pipeline-heard-history.ts";
import { createPipelineHistory, type PipelineHistory } from "./pipeline-history.ts";
import { createTurnGate } from "./pipeline-turn-gate.ts";

const OPENING = "Let me check. ";
const ANSWER = "Your refund goes to the card ending in 42.";
/** The reply's recorded text: one step's words, a tool call, the answer. */
const TEXT = `${OPENING}${ANSWER}`;

const TOOL_CALL = {
  type: "tool-call" as const,
  toolCallId: "c1",
  toolName: "refund",
  input: {},
};
const TOOL_RESULT: ModelMessage = {
  role: "tool",
  content: [
    {
      type: "tool-result",
      toolCallId: "c1",
      toolName: "refund",
      output: { type: "text", value: "card 42" },
    },
  ],
};

/** A history holding one committed two-step reply, and the reply's record. */
function committed(): { history: PipelineHistory; reply: PersistedReply } {
  const history = createPipelineHistory();
  history.pushConversation({ role: "user", content: "where is my refund" });
  history.pushLlm({ role: "user", content: "where is my refund" });
  const llm = history.pushLlm(
    { role: "assistant", content: [{ type: "text", text: OPENING }, TOOL_CALL] },
    TOOL_RESULT,
    { role: "assistant", content: [{ type: "text", text: ANSWER }] },
  );
  const conversation: Message = { role: "assistant", content: TEXT };
  history.pushConversation(conversation);
  return { history, reply: { text: TEXT, conversation, llm } };
}

describe("truncateToHeard", () => {
  test("a partly heard reply keeps the heard prefix plus the interrupted marker", () => {
    const { history, reply } = committed();
    const heardChars = TEXT.indexOf(" to the card");

    expect(truncateToHeard(history, reply, heardChars)).toEqual({
      removedChars: TEXT.length - heardChars,
      keptChars: "Let me check. Your refund goes".length,
    });
    expect(history.conversation.at(-1)).toEqual({
      role: "assistant",
      content: "Let me check. Your refund goes [interrupted]",
    });
    expect(history.llm).toEqual([
      { role: "user", content: "where is my refund" },
      // The step the caller heard in full is untouched, tool call and all.
      { role: "assistant", content: [{ type: "text", text: OPENING }, TOOL_CALL] },
      TOOL_RESULT,
      { role: "assistant", content: [{ type: "text", text: "Your refund goes [interrupted]" }] },
    ]);
  });

  test("nothing heard drops the assistant text and keeps the tool call and its result", () => {
    const { history, reply } = committed();

    expect(truncateToHeard(history, reply, 0)).toEqual({ removedChars: TEXT.length, keptChars: 0 });
    expect(history.conversation).toEqual([{ role: "user", content: "where is my refund" }]);
    expect(history.llm).toEqual([
      { role: "user", content: "where is my refund" },
      { role: "assistant", content: [TOOL_CALL] },
      TOOL_RESULT,
    ]);
  });

  test("a reply heard to its last word is left exactly as committed", () => {
    const { history, reply } = committed();
    const before = [...history.llm];

    expect(truncateToHeard(history, reply, TEXT.length)).toBeUndefined();
    expect(history.llm).toEqual(before);
    expect(history.conversation.at(-1)?.content).toBe(TEXT);
  });

  test("a reply no longer in history is not written back into it", () => {
    const { history, reply } = committed();
    history.reset();

    expect(truncateToHeard(history, reply, 5)).toBeUndefined();
    expect(history.conversation).toEqual([]);
    expect(history.llm).toEqual([]);
  });

  test("a string-content reply is rewritten as a string", () => {
    const history = createPipelineHistory();
    const llm = history.pushLlm({ role: "assistant", content: ANSWER });
    const heardChars = ANSWER.indexOf(" goes");

    truncateToHeard(history, { text: ANSWER, conversation: undefined, llm }, heardChars);
    expect(history.llm).toEqual([{ role: "assistant", content: "Your refund [interrupted]" }]);
  });
});

describe("createHeardHistory", () => {
  const RATE = 24_000;

  /** Commit the reply, play `heardMs` of its 4s of audio, then cut. */
  function cutAfter(heardMs: number, opts: { resetFirst?: boolean } = {}) {
    const clock = createTestClock();
    const heard = createHeardTracker({ sampleRate: RATE, lagMs: 0, now: clock.now });
    const gate = createTurnGate();
    const info = vi.fn();
    const { history, reply } = committed();
    const track = createHeardHistory({
      history,
      heard,
      gate,
      log: { ...silentLogger, info },
      sid: "s1",
    });
    heard.startReply();
    heard.onText(TEXT, true);
    heard.onAudio(new Int16Array(RATE * 4));
    track(reply, gate.historyEpoch());
    clock.advance(heardMs);
    if (opts.resetFirst) gate.invalidateAll();
    heard.cut();
    return { history, info };
  }

  test("a cut with the reply still playing rewrites it and logs the one indicator line", () => {
    const { history, info } = cutAfter(1000);

    expect(history.conversation.at(-1)?.content).toMatch(/^Let me check\..* \[interrupted\]$/);
    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith("Pipeline heard-history truncated", {
      sid: "s1",
      removedChars: expect.any(Number),
      keptChars: expect.any(Number),
    });
  });

  test("a reply that played out in full is untouched and logs nothing", () => {
    const { history, info } = cutAfter(5000);

    expect(history.conversation.at(-1)?.content).toBe(TEXT);
    expect(info).not.toHaveBeenCalled();
  });

  test("a cut after the conversation was reset does not rewrite on the old one's behalf", () => {
    const { history, info } = cutAfter(1000, { resetFirst: true });

    expect(history.conversation.at(-1)?.content).toBe(TEXT);
    expect(info).not.toHaveBeenCalled();
  });
});
