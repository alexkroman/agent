// Copyright 2026 the AAI authors. MIT license.
import type { ModelMessage } from "ai";
import { describe, expect, test } from "vitest";
import { closingNotice, HARD_TURN_MS, SOFT_TURN_MS, wrapUpNotice } from "./turn-budget.ts";
import {
  createTurnPolicy,
  INITIAL_TURN_STATE,
  keepGoingNotice,
  MAX_FORCED_STEPS,
  pendingTodoCount,
  prepareTurnStep,
  stepTurn,
  type TurnLimits,
  turnExpired,
} from "./turn-continue.ts";

type Status = "pending" | "in_progress" | "completed" | "cancelled";

/** A `todo_write` call as the SDK records it on the assistant message. */
function todoCall(...statuses: Status[]): ModelMessage {
  return {
    role: "assistant",
    content: [
      {
        type: "tool-call",
        toolCallId: `c${statuses.length}`,
        toolName: "todo_write",
        input: { todos: statuses.map((status, i) => ({ content: `step ${i}`, status })) },
      },
    ],
  };
}

const user = (content: string): ModelMessage => ({ role: "user", content });

describe("pendingTodoCount", () => {
  test("counts pending and in_progress, and nothing else", () => {
    expect(pendingTodoCount([todoCall("pending", "in_progress", "completed", "cancelled")])).toBe(
      2,
    );
  });

  test("cancelled is not outstanding — it is the escape hatch, not a third way to stay stuck", () => {
    expect(pendingTodoCount([todoCall("cancelled", "cancelled", "completed")])).toBe(0);
  });

  test("reads the LAST todo_write, so marking the plan done releases the force", () => {
    const messages = [
      todoCall("pending", "pending"),
      user("go on"),
      todoCall("completed", "completed"),
    ];
    expect(pendingTodoCount(messages)).toBe(0);
  });

  test("a conversation that never planned counts zero", () => {
    // The preamble tells the model to skip todo_write for one-step changes and
    // questions, so this is the common short turn — it must never be forced.
    expect(pendingTodoCount([user("what does agent.ts do?")])).toBe(0);
  });

  test("survives a malformed todos payload rather than throwing mid-turn", () => {
    const bad: ModelMessage = {
      role: "assistant",
      content: [
        { type: "tool-call", toolCallId: "x", toolName: "todo_write", input: { todos: "nope" } },
      ],
    };
    expect(pendingTodoCount([bad])).toBe(0);
  });
});

const limits = { softMs: 1000, hardMs: 2000, maxForced: MAX_FORCED_STEPS };
const at = (elapsedMs: number, pending = 0) => ({ elapsedMs, pending });

/** Run observations through the reducer from the start of a turn. */
function run(observations: ReturnType<typeof at>[], lim: TurnLimits = limits) {
  let state = INITIAL_TURN_STATE;
  const actions = observations.map((o) => {
    const next = stepTurn(state, o, lim);
    state = next.state;
    return next.action;
  });
  return { state, actions };
}

describe("stepTurn: the keep-going force", () => {
  test("forces while the plan is open and explains itself exactly once", () => {
    const { actions } = run([at(0, 2), at(10, 2)]);
    expect(actions).toEqual([
      { kind: "force", explain: true },
      { kind: "force", explain: false },
    ]);
  });

  test("the notice names the way OUT, or it is a constraint the model fights", () => {
    expect(keepGoingNotice(2)).toContain("todo_write");
    expect(keepGoingNotice(2)).toContain("2 items");
    expect(keepGoingNotice(1)).toContain("1 item ");
  });

  test("does not force an empty plan", () => {
    expect(run([at(0, 0)]).actions).toEqual([{ kind: "pass" }]);
  });

  test("stops forcing at the cap, so a stale plan cannot trap the model", () => {
    const { actions } = run([at(0, 1), at(1, 1), at(2, 1), at(3, 1)], { ...limits, maxForced: 3 });
    expect(actions.map((a) => a.kind)).toEqual(["force", "force", "force", "pass"]);
  });

  test("an unforced step does not spend the allowance or the explanation", () => {
    const { actions, state } = run([at(0, 0), at(1, 3)]);
    expect(actions[1]).toEqual({ kind: "force", explain: true });
    expect(state.forced).toBe(1);
  });

  test("the default cap leaves room under MAX_CHAT_STEPS", () => {
    expect(MAX_FORCED_STEPS).toBeLessThan(80);
  });
});

describe("stepTurn: the deadlines, and their order against the force", () => {
  test("the hard deadline WINS over the force — the closing step must have no tools", () => {
    // The ordering that matters most: a forced tool call on the reserved step
    // would leave the turn ending on a tool result the user never sees.
    const { actions, state } = run([at(2000, 2)]);
    expect(actions).toEqual([{ kind: "close" }]);
    expect(state.phase).toBe("finalSent");
    expect(turnExpired(state)).toBe(true);
  });

  test("the wrap-up notice is not overridden by a forced tool call", () => {
    // Wrap-up asks for a spoken report; requiring a tool would contradict it.
    const { actions, state } = run([at(1000, 2)]);
    expect(actions).toEqual([{ kind: "wrapUp" }]);
    expect(state.phase).toBe("wrapUpSent");
  });

  test("past the soft deadline the force stands down on EVERY step, not just the notice's", () => {
    // Read off the clock, so taking the notice does not lift the stand-down.
    const { actions } = run([at(0, 2), at(1000, 2), at(1500, 2), at(1999, 2)]);
    expect(actions.map((a) => a.kind)).toEqual(["force", "wrapUp", "pass", "pass"]);
  });

  test("each deadline fires once, and the turn walks working → wrapUpSent → finalSent", () => {
    const { actions, state } = run([at(999), at(1000), at(1001), at(2000), at(2500)]);
    expect(actions.map((a) => a.kind)).toEqual(["pass", "wrapUp", "pass", "close", "pass"]);
    expect(state.phase).toBe("finalSent");
  });

  test("a turn that jumps straight past the hard deadline closes without a wrap-up", () => {
    const { actions } = run([at(0), at(5000), at(6000)]);
    expect(actions.map((a) => a.kind)).toEqual(["pass", "close", "pass"]);
  });

  test("nothing expires before the closing step is handed out", () => {
    // Stopping cold at the deadline can end the turn on a tool call.
    expect(turnExpired(INITIAL_TURN_STATE)).toBe(false);
    expect(turnExpired(run([at(1000)]).state)).toBe(false);
  });
});

describe("prepareTurnStep", () => {
  const open = [todoCall("pending", "in_progress")];
  const obs = at(0, 2);

  test("a force requires a tool call, explaining itself when asked", () => {
    const step = prepareTurnStep({
      base: open,
      stepMessages: open,
      action: { kind: "force", explain: true },
      observation: obs,
    });
    expect(step.toolChoice).toBe("required");
    expect(step.messages?.at(-1)?.content).toContain("ENDS your turn");

    const quiet = prepareTurnStep({
      base: open,
      stepMessages: open,
      action: { kind: "force", explain: false },
      observation: obs,
    });
    expect(quiet).toEqual({ messages: open, toolChoice: "required" });
  });

  test("the closing step takes tools away and carries the closing notice", () => {
    const step = prepareTurnStep({
      base: open,
      stepMessages: open,
      action: { kind: "close" },
      observation: at(HARD_TURN_MS, 2),
    });
    expect(step.toolChoice).toBe("none");
    expect(step.messages?.at(-1)?.content).toBe(closingNotice(HARD_TURN_MS));
  });

  test("the wrap-up step carries the notice and leaves toolChoice alone", () => {
    const step = prepareTurnStep({
      base: open,
      stepMessages: open,
      action: { kind: "wrapUp" },
      observation: at(SOFT_TURN_MS, 2),
    });
    expect(step.toolChoice).toBeUndefined();
    expect(step.messages?.at(-1)?.content).toBe(wrapUpNotice(SOFT_TURN_MS));
  });

  test("an untouched step with no open plan contributes no keys at all", () => {
    const plain = [user("hi")];
    expect(
      prepareTurnStep({
        base: plain,
        stepMessages: plain,
        action: { kind: "pass" },
        observation: at(0),
      }),
    ).toEqual({});
  });

  test("a compacted step still reports its messages when nothing else applies", () => {
    const compacted = [user("summary")];
    const step = prepareTurnStep({
      base: compacted,
      stepMessages: [user("a"), user("b")],
      action: { kind: "pass" },
      observation: at(0),
    });
    expect(step.messages).toEqual(compacted);
    expect(step.toolChoice).toBeUndefined();
  });
});

describe("createTurnPolicy", () => {
  test("reads the plan off the step's messages and holds it open", () => {
    const policy = createTurnPolicy(() => 0);
    const open = [todoCall("pending", "in_progress")];
    const step = policy.prepare(open, open);
    expect(step.toolChoice).toBe("required");
    expect(step.messages?.at(-1)?.content).toBe(keepGoingNotice(2));
    expect(policy.expired()).toBe(false);
  });
});
