// Copyright 2026 the AAI authors. MIT license.
import type { ModelMessage } from "ai";
import { describe, expect, test } from "vitest";
import type { TurnBudget } from "./turn-budget.ts";
import {
  createKeepGoing,
  MAX_FORCED_STEPS,
  pendingTodoCount,
  prepareTurnStep,
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

describe("createKeepGoing", () => {
  test("forces while the plan is open and explains itself exactly once", () => {
    const keep = createKeepGoing();
    const open = [todoCall("in_progress", "pending")];

    const first = keep.consider(open);
    expect(first.force).toBe(true);
    // The notice has to name the way OUT, or it is a constraint the model fights.
    expect(first.notice).toContain("todo_write");
    expect(first.notice).toContain("2 items");

    const second = keep.consider(open);
    expect(second.force).toBe(true);
    expect(second.notice).toBeNull();
  });

  test("does not force an empty plan", () => {
    expect(createKeepGoing().consider([user("hi")])).toEqual({ force: false, notice: null });
  });

  test("stops forcing at the cap, so a stale plan cannot trap the model", () => {
    const keep = createKeepGoing(3);
    const open = [todoCall("pending")];
    expect([1, 2, 3].map(() => keep.consider(open).force)).toEqual([true, true, true]);
    expect(keep.consider(open).force).toBe(false);
  });

  test("the default cap leaves room under MAX_CHAT_STEPS", () => {
    expect(MAX_FORCED_STEPS).toBeLessThan(80);
  });
});

/** A budget stub: the three readers `prepareTurnStep` uses, nothing else. */
function budgetStub(
  over: Partial<TurnBudget> = {},
): Parameters<typeof prepareTurnStep>[0]["budget"] {
  return {
    takeFinalNotice: () => null,
    takeWrapUpNotice: () => null,
    wrappingUp: () => false,
    ...over,
  };
}

describe("prepareTurnStep", () => {
  const open = [todoCall("pending", "in_progress")];

  test("holds an open plan by requiring a tool call", () => {
    const step = prepareTurnStep({
      base: open,
      stepMessages: open,
      budget: budgetStub(),
      keepGoing: createKeepGoing(),
    });
    expect(step.toolChoice).toBe("required");
    expect(step.messages?.at(-1)?.content).toContain("ENDS your turn");
  });

  test("the hard deadline WINS over the force — the closing step must have no tools", () => {
    // The ordering that matters most: a forced tool call on the reserved step
    // would leave the turn ending on a tool result the user never sees.
    //
    // `wrappingUp: false` alongside a fired final notice is a state the clock
    // cannot really produce (hard is past soft), and it is the point: with the
    // realistic `true` the stand-down suppresses the force on its own, so this
    // test passed even with the branches reordered. Holding the stand-down OFF
    // isolates the ORDERING, so the test now fails if either guard is removed.
    const step = prepareTurnStep({
      base: open,
      stepMessages: open,
      budget: budgetStub({ takeFinalNotice: () => "out of time", wrappingUp: () => false }),
      keepGoing: createKeepGoing(),
    });
    expect(step.toolChoice).toBe("none");
    expect(step.messages?.at(-1)?.content).toBe("out of time");
  });

  test("the wrap-up notice is not overridden by a forced tool call", () => {
    // Wrap-up asks for a spoken report; requiring a tool would contradict it.
    const step = prepareTurnStep({
      base: open,
      stepMessages: open,
      // `false` for the same reason as the test above: it isolates the
      // ordering from the stand-down that would otherwise mask it.
      budget: budgetStub({ takeWrapUpNotice: () => "wrap up", wrappingUp: () => false }),
      keepGoing: createKeepGoing(),
    });
    expect(step.toolChoice).toBeUndefined();
    expect(step.messages?.at(-1)?.content).toBe("wrap up");
  });

  test("past the soft deadline the force stands down entirely", () => {
    const step = prepareTurnStep({
      base: open,
      stepMessages: open,
      budget: budgetStub({ wrappingUp: () => true }),
      keepGoing: createKeepGoing(),
    });
    expect(step.toolChoice).toBeUndefined();
  });

  test("an untouched step with no open plan contributes no keys at all", () => {
    const plain = [user("hi")];
    expect(
      prepareTurnStep({
        base: plain,
        stepMessages: plain,
        budget: budgetStub(),
        keepGoing: createKeepGoing(),
      }),
    ).toEqual({});
  });

  test("a compacted step still reports its messages when nothing else applies", () => {
    const compacted = [user("summary")];
    const step = prepareTurnStep({
      base: compacted,
      stepMessages: [user("a"), user("b")],
      budget: budgetStub(),
      keepGoing: createKeepGoing(),
    });
    expect(step.messages).toEqual(compacted);
    expect(step.toolChoice).toBeUndefined();
  });
});
