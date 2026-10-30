// Copyright 2026 the AAI authors. MIT license.

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

describe("createExecutedCallLedger — what an interrupted turn really ran", () => {
  test("a call that SETTLED before the cut keeps its real result", () => {
    const ledger = createExecutedCallLedger();
    const cut = new AbortController();
    const turn = ledger.beginTurn(cut.signal);
    const call = ledger.track(RETURN);
    call?.ran();
    call?.settled("Return processed.");
    cut.abort();
    expect(turn.unanswered([])).toEqual([
      { ...RETURN, output: "Return processed.", interrupted: false },
    ]);
  });

  test("a call still RUNNING at the cut is interrupted, with the honest unknown", () => {
    const ledger = createExecutedCallLedger();
    const cut = new AbortController();
    const turn = ledger.beginTurn(cut.signal);
    const call = ledger.track(RETURN);
    call?.ran();
    cut.abort();
    // What `executeTool` hands back after the abort is a `cancelled` failure
    // while the body may have finished the write — it must not be believed.
    call?.settled('{"error":"cancelled"}');
    expect(turn.unanswered([])).toEqual([
      { ...RETURN, output: INTERRUPTED_TOOL_CALL_RESULT, interrupted: true },
    ]);
  });

  test("a call that never reached `executeTool` is not recorded", () => {
    const ledger = createExecutedCallLedger();
    const cut = new AbortController();
    const turn = ledger.beginTurn(cut.signal);
    const call = ledger.track(RETURN);
    cut.abort();
    // The `blocking` start line finished after the cut; executeTool refuses it.
    call?.ran();
    expect(turn.unanswered([])).toEqual([]);
  });

  test("a call starting after the cut, or outside any turn, is not tracked", () => {
    const ledger = createExecutedCallLedger();
    expect(ledger.track(RETURN)).toBeUndefined();
    const cut = new AbortController();
    const turn = ledger.beginTurn(cut.signal);
    cut.abort();
    expect(ledger.track(RETURN)).toBeUndefined();
    turn.end();
    expect(ledger.track(RETURN)).toBeUndefined();
  });

  test("a refusal settles without running, and is a real answer", () => {
    const ledger = createExecutedCallLedger();
    const turn = ledger.beginTurn(new AbortController().signal);
    ledger.track(RETURN)?.settled("Invalid arguments (not sent)");
    expect(turn.unanswered([])).toEqual([
      { ...RETURN, output: "Invalid arguments (not sent)", interrupted: false },
    ]);
  });

  test("a call a completed step already carries is not answered twice", () => {
    const ledger = createExecutedCallLedger();
    const turn = ledger.beginTurn(new AbortController().signal);
    const call = ledger.track(RETURN);
    call?.ran();
    call?.settled("Return processed.");
    const steps = [toolCallMsg("call_ret"), toolResultMsg("call_ret")];
    expect(turn.unanswered(steps)).toEqual([]);
  });

  test("a call settling after the NEXT turn opened stays with its own turn", () => {
    const ledger = createExecutedCallLedger();
    const first = ledger.beginTurn(new AbortController().signal);
    const call = ledger.track(RETURN);
    call?.ran();
    first.end();
    const second = ledger.beginTurn(new AbortController().signal);
    call?.settled("Return processed.");
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
