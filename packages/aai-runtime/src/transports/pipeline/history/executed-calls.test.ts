// Copyright 2026 the AAI authors. MIT license.

import type { Message } from "@alexkroman1/aai";
import type { ModelMessage } from "ai";
import { describe, expect, test } from "vitest";
import { pairToolCalls } from "../../../tools/index.ts";
import { toolCallMsg, toolResultMsg } from "./_history-test-utils.ts";
import {
  createExecutedCallLedger,
  type ExecutedToolCall,
  INTERRUPTED_TOOL_CALL_RESULT,
} from "./executed-calls.ts";
import { createPipelineHistory, persistInterruptedTurn } from "./history.ts";

const RETURN = {
  toolCallId: "call_ret",
  toolName: "return_delivered_order_items",
  input: { order_id: "#W123" },
};

/** The `tool` message the call core records for `RETURN`. */
const recorded = (content: string): Message => ({
  role: "tool",
  content,
  toolName: RETURN.toolName,
  toolCallId: RETURN.toolCallId,
});

/** What the executor answers once the call's signal aborts. */
const CANCELLED = '{"error":"This operation was aborted"}';

/** A ledger with one open turn and `RETURN` tracked under a fresh signal. */
function oneCall() {
  const ledger = createExecutedCallLedger();
  const turn = ledger.beginTurn();
  const cut = new AbortController();
  const call = ledger.track({ ...RETURN, signal: cut.signal });
  return { ledger, turn, cut, call };
}

describe("createExecutedCallLedger — what an unfinished turn really ran", () => {
  test("a call that SETTLED before the cut keeps its real result, in both views", () => {
    const { ledger, turn, cut, call } = oneCall();
    call?.ran();
    expect(ledger.conversationResult(recorded("Return processed."))).toEqual(
      recorded("Return processed."),
    );
    call?.settled("Return processed. (rows)");
    cut.abort();
    expect(turn.unanswered([])).toEqual([
      { ...RETURN, output: "Return processed. (rows)", interrupted: false },
    ]);
  });

  test("a call still RUNNING at the cut is the honest unknown, in both views", () => {
    const { ledger, turn, cut, call } = oneCall();
    call?.ran();
    cut.abort();
    // The executor's answer after the abort, while the body may have finished
    // the write — neither view may believe it.
    expect(ledger.conversationResult(recorded(CANCELLED))).toEqual(
      recorded(INTERRUPTED_TOOL_CALL_RESULT),
    );
    call?.settled(CANCELLED);
    expect(turn.unanswered([])).toEqual([
      { ...RETURN, output: INTERRUPTED_TOOL_CALL_RESULT, interrupted: true },
    ]);
  });

  test("a call that never reached `executeTool` is recorded in NEITHER view", () => {
    const { ledger, turn, cut, call } = oneCall();
    cut.abort();
    // The `blocking` start line finished after the cut; executeTool refuses it.
    call?.ran();
    expect(ledger.conversationResult(recorded(CANCELLED))).toBeNull();
    expect(turn.unanswered([])).toEqual([]);
  });

  test("READING is a cut: a call still pending then stays interrupted when it settles", () => {
    // A failed turn: nothing aborted this call's signal, but the turn is over
    // and its history is being written now.
    const { ledger, turn, call } = oneCall();
    call?.ran();
    expect(turn.unanswered([])).toEqual([
      { ...RETURN, output: INTERRUPTED_TOOL_CALL_RESULT, interrupted: true },
    ]);
    // Its late real answer cannot make the two views disagree.
    expect(ledger.conversationResult(recorded("Return processed."))).toEqual(
      recorded(INTERRUPTED_TOOL_CALL_RESULT),
    );
  });

  test("a FATAL throw is recorded nowhere — the model is never given it", () => {
    const { turn, call } = oneCall();
    call?.ran();
    call?.threw();
    expect(turn.unanswered([])).toEqual([]);
  });

  test("a call starting after its cut, or outside any turn, is not tracked", () => {
    const ledger = createExecutedCallLedger();
    expect(ledger.track(RETURN)).toBeUndefined();
    const turn = ledger.beginTurn();
    const cut = new AbortController();
    cut.abort();
    expect(ledger.track({ ...RETURN, signal: cut.signal })).toBeUndefined();
    turn.end();
    expect(ledger.track(RETURN)).toBeUndefined();
  });

  test("an untracked call's result reaches the conversation view unchanged", () => {
    const ledger = createExecutedCallLedger();
    expect(ledger.conversationResult(recorded(CANCELLED))).toEqual(recorded(CANCELLED));
  });

  test("a refusal settles without running, and is a real answer", () => {
    const { turn, call } = oneCall();
    call?.settled("Invalid arguments (not sent)");
    expect(turn.unanswered([])).toEqual([
      { ...RETURN, output: "Invalid arguments (not sent)", interrupted: false },
    ]);
  });

  test("a call a completed step already carries is not answered twice", () => {
    const { turn, call } = oneCall();
    call?.ran();
    call?.settled("Return processed.");
    const steps = [toolCallMsg("call_ret"), toolResultMsg("call_ret")];
    expect(turn.unanswered(steps)).toEqual([]);
  });

  test("a call settling after the NEXT turn opened stays with its own turn", () => {
    const { ledger, turn: first, call } = oneCall();
    call?.ran();
    first.end();
    const second = ledger.beginTurn();
    call?.settled("Return processed.");
    expect(ledger.conversationResult(recorded("Return processed."))).toEqual(
      recorded("Return processed."),
    );
    expect(first.unanswered([])).toHaveLength(1);
    expect(second.unanswered([])).toEqual([]);
  });
});

describe("persistInterruptedTurn — the cut step's executed calls", () => {
  const ran: ExecutedToolCall = { ...RETURN, output: "Return processed.", interrupted: false };
  const running: ExecutedToolCall = {
    toolCallId: "call_slow",
    toolName: "lookup",
    input: {},
    output: INTERRUPTED_TOOL_CALL_RESULT,
    interrupted: true,
  };

  test("lands as ONE well-formed pair, with the heard text ahead of the calls", () => {
    const history = createPipelineHistory();
    history.pushLlm({ role: "user", content: "return it" });
    persistInterruptedTurn({
      history,
      heard: "Let me process that return.",
      persistedLen: 0,
      stepMessages: [],
      executedCalls: [ran, running],
    });
    expect(history.llm.slice(1)).toEqual([
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me process that return. [interrupted]" },
          { type: "tool-call", ...RETURN },
          { type: "tool-call", toolCallId: "call_slow", toolName: "lookup", input: {} },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call_ret",
            toolName: RETURN.toolName,
            output: { type: "text", value: "Return processed." },
          },
          {
            type: "tool-result",
            toolCallId: "call_slow",
            toolName: "lookup",
            output: { type: "text", value: INTERRUPTED_TOOL_CALL_RESULT },
          },
        ],
      },
    ] satisfies ModelMessage[]);
    // Nothing for the pairing guard to repair: the history is valid as written.
    expect(pairToolCalls(history.llm).repairs).toEqual([]);
    expect(history.conversation).toEqual([
      { role: "assistant", content: "Let me process that return. [interrupted]" },
    ]);
  });

  test("is persisted even when the caller heard nothing — the call ran either way", () => {
    const history = createPipelineHistory();
    persistInterruptedTurn({
      history,
      heard: "",
      persistedLen: 0,
      stepMessages: [],
      executedCalls: [ran],
    });
    expect(history.llm.map((m) => m.role)).toEqual(["assistant", "tool"]);
    expect(history.conversation).toEqual([]);
  });

  test("follows the completed steps, and takes only the text past them", () => {
    const history = createPipelineHistory();
    const steps = [toolCallMsg("call_a"), toolResultMsg("call_a")];
    persistInterruptedTurn({
      history,
      heard: "Found it. Returning now.",
      persistedLen: "Found it. ".length,
      stepMessages: steps,
      executedCalls: [ran],
    });
    expect(history.llm.slice(0, 2)).toEqual(steps);
    expect(history.llm[2]).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "Returning now. [interrupted]" }, { type: "tool-call" }],
    });
    expect(history.llm[3]?.role).toBe("tool");
  });
});
