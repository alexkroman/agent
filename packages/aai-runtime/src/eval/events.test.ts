// Copyright 2026 the AAI authors. MIT license.

import type { StandardSchemaV1 } from "@alexkroman1/aai/host-internal";
import type { SessionEvent } from "@alexkroman1/aai/protocol";
import { isRecord, omitUndefined } from "@alexkroman1/aai/utils";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import {
  customEventsIn,
  describeToolCalls,
  type EvalToolCall,
  lastStateIn,
  saidIn,
  statesIn,
  TURN_ENDS,
  toolArgsIn,
  toolCallsIn,
  toolNames,
  toolResultIn,
  toolResultsIn,
} from "./events.ts";

/** Every event carries one; nothing here reads it, so one value serves all. */
const meta = { id: "e1", at: 0 };

const called = (id: string, name: string, args: Record<string, unknown>): SessionEvent => ({
  type: "tool.called",
  meta,
  toolCallId: id,
  toolName: name,
  args,
});
const completed = (id: string, result: string): SessionEvent => ({
  type: "tool.completed",
  meta,
  toolCallId: id,
  result,
});
const saidByAgent = (text: string): SessionEvent => ({
  type: "agent-transcript.committed",
  meta,
  text,
});

describe("saidIn", () => {
  test("reads committed replies in order and ignores everything else", () => {
    expect(
      saidIn([
        saidByAgent("Hi there."),
        { type: "agent-transcript.updated", meta, text: "It sh" },
        saidByAgent("It shipped."),
      ]),
    ).toEqual(["Hi there.", "It shipped."]);
  });

  test("is empty for a run that said nothing", () => {
    expect(saidIn([])).toEqual([]);
  });
});

describe("toolCallsIn", () => {
  test("pairs each call with the result that answered it", () => {
    expect(
      toolCallsIn([
        called("c1", "look_up", { id: "W1" }),
        completed("c1", '"shipped"'),
        called("c2", "cancel", { id: "W1" }),
        completed("c2", '"done"'),
      ]),
    ).toEqual([
      { toolCallId: "c1", name: "look_up", args: { id: "W1" }, result: '"shipped"' },
      { toolCallId: "c2", name: "cancel", args: { id: "W1" }, result: '"done"' },
    ]);
  });

  test("reports a call that never completed rather than dropping it", () => {
    const calls = toolCallsIn([called("c1", "look_up", {})]);
    expect(calls).toHaveLength(1);
    // The key is ABSENT rather than undefined: "it called the tool and the tool
    // never returned" is a finding, and a `result` of undefined reads as one.
    expect(calls[0] && "result" in calls[0]).toBe(false);
  });
});

describe("TURN_ENDS", () => {
  test("is the two reply terminators, and nothing that merely looks like one", () => {
    expect([...TURN_ENDS].sort()).toEqual(["reply.cancelled", "reply.completed"]);
    expect(TURN_ENDS.has("agent-transcript.committed")).toBe(false);
  });
});

const emitted = (event: string, data: unknown): SessionEvent => ({
  type: "custom.emitted",
  meta,
  event,
  data,
});
const pushed = (state: unknown): SessionEvent => ({ type: "state.updated", meta, state });

/** A schema, spelled without zod: these readers take any Standard Schema. */
const cartSchema = {
  "~standard": {
    version: 1 as const,
    vendor: "spec",
    validate: (value: unknown) =>
      isRecord(value) && "items" in value
        ? { value: value as { items: number } }
        : { issues: [{ message: "not a cart", path: ["items"] }] },
  },
};

describe("customEventsIn", () => {
  test("reads what the agent named, and filters by name when asked", () => {
    const events = [emitted("wind_down", { at: 3 }), emitted("other", 1), emitted("wind_down", {})];
    expect(customEventsIn(events)).toHaveLength(3);
    expect(customEventsIn(events, "wind_down")).toEqual([
      { event: "wind_down", data: { at: 3 } },
      { event: "wind_down", data: {} },
    ]);
    expect(customEventsIn(events, "never")).toEqual([]);
  });
});

describe("lastStateIn", () => {
  test("answers the LAST frame, which is what the page is showing", () => {
    expect(lastStateIn([pushed({ items: 1 }), pushed({ items: 2 })])).toEqual({ items: 2 });
  });

  test("is undefined when nothing was pushed", () => {
    expect(lastStateIn([saidByAgent("hi")])).toBeUndefined();
  });

  test("validates through a schema, so a changed projection FAILS by name", () => {
    expect(lastStateIn([pushed({ items: 2 })], cartSchema)).toEqual({ items: 2 });
    // The regression an eval exists to catch: the projection changed shape and a
    // cast would have sailed straight past it.
    expect(() => lastStateIn([pushed({ nope: true })], cartSchema)).toThrow(/items: not a cart/);
  });
});

describe("toolResultIn", () => {
  const calls = toolCallsIn([
    called("c1", "look_up", { id: "W1" }),
    completed("c1", '{"status":"shipped"}'),
  ]);

  test("parses the result the model was handed", () => {
    expect(toolResultIn(calls, "look_up")).toEqual({ status: "shipped" });
  });

  test("a PLAIN TEXT result comes back as text, not a SyntaxError", () => {
    // `run_code` prints whatever the snippet printed, so "Saturday" and
    // "3.106855" are ordinary results. An unguarded `JSON.parse` turned the
    // first into `SyntaxError: Unexpected token 'S'` thrown from inside the
    // reader, naming neither the tool nor the case — and it failed a real
    // template eval whose assertion was `toolResultsIn(...).join("\n")`.
    const text = toolCallsIn([called("c1", "run_code", {}), completed("c1", "Saturday")]);
    expect(toolResultIn(text, "run_code")).toBe("Saturday");
  });

  test("text WITH a schema throws, naming the tool and the text", () => {
    // A schema is a declaration that the result has a shape, so text there is a
    // real mismatch — and the message has to say which tool and what it said.
    const text = toolCallsIn([called("c1", "run_code", {}), completed("c1", "Saturday")]);
    expect(() => toolResultIn(text, "run_code", z.object({ a: z.string() }))).toThrow(
      /"run_code" answered text, not JSON.*Saturday/s,
    );
  });

  test("THROWS naming what ran instead — a miss must not read as undefined", () => {
    expect(() => toolResultIn(calls, "cancel")).toThrow(/no call to "cancel".*look_up/s);
    expect(() => toolResultIn([], "cancel")).toThrow(/no tools/);
  });

  test("refuses to guess between two calls to the same tool", () => {
    const twice = toolCallsIn([
      called("c1", "look_up", {}),
      completed("c1", "1"),
      called("c2", "look_up", {}),
      completed("c2", "2"),
    ]);
    expect(() => toolResultIn(twice, "look_up")).toThrow(/2 calls/);
  });

  test("reports a call that never completed as exactly that", () => {
    expect(() => toolResultIn(toolCallsIn([called("c9", "look_up", {})]), "look_up")).toThrow(
      /never completed/,
    );
  });
});

/** One `EvalToolCall`, the shape `toolCallsIn` hands the plural readers. */
const call = (name: string, args: Record<string, unknown>, result?: string): EvalToolCall => ({
  toolCallId: `c-${name}-${result ?? "pending"}`,
  name,
  args,
  ...omitUndefined({ result }),
});

const RUN_CODE = [
  call("run_code", { code: "console.log(1)" }, '"1"'),
  call("think", { note: "hm" }, '"ok"'),
  call("run_code", { code: "console.log(2)" }, '"2"'),
];

describe("toolArgsIn", () => {
  test("reads every call to one tool's arguments, in call order", () => {
    expect(toolArgsIn(RUN_CODE, "run_code")).toEqual([
      { code: "console.log(1)" },
      { code: "console.log(2)" },
    ]);
  });

  test("a tool nothing called answers [] — the claim the plural form makes", () => {
    expect(toolArgsIn(RUN_CODE, "web_search")).toEqual([]);
  });

  test("with a schema it parses, so a renamed argument fails naming the field", () => {
    const Code = z.object({ code: z.string() });
    expect(toolArgsIn(RUN_CODE, "run_code", Code).map((a) => a.code)).toEqual([
      "console.log(1)",
      "console.log(2)",
    ]);
    // The failure the `String(args.code ?? "")` spelling turned into "".
    expect(() => toolArgsIn([call("run_code", { source: "x" })], "run_code", Code)).toThrow(
      /"run_code" call 0's args does not match the schema/,
    );
  });

  test("an incomplete call still has arguments, which is what was asked", () => {
    expect(toolArgsIn([call("run_code", { code: "x" })], "run_code")).toEqual([{ code: "x" }]);
  });

  test("an async schema is refused rather than silently passing", () => {
    // A schema whose `validate` is async is the trap a hand-rolled reader falls
    // into: the promise has no `.issues`, so it passes every case.
    const asyncSchema: StandardSchemaV1<unknown, unknown> = {
      "~standard": {
        version: 1,
        vendor: "spec",
        validate: () => Promise.resolve({ value: {} }),
      },
    };
    expect(() => toolArgsIn(RUN_CODE, "run_code", asyncSchema)).toThrow(/synchronous schema/);
  });
});

describe("toolResultsIn", () => {
  test("parses every result, in call order", () => {
    expect(toolResultsIn(RUN_CODE, "run_code")).toEqual(["1", "2"]);
  });

  test("a tool nothing called answers []", () => {
    expect(toolResultsIn(RUN_CODE, "visit_webpage")).toEqual([]);
  });

  test('an incomplete call THROWS naming its position, never reads as ""', () => {
    // The finding the three hand-rolled `.map((c) => c.result ?? "")` copies
    // dropped: "it called the tool and the tool never returned".
    expect(() =>
      toolResultsIn([RUN_CODE[0] as EvalToolCall, call("run_code", { code: "y" })], "run_code"),
    ).toThrow(/the 2nd call to "run_code" never completed/);
  });

  test("with a schema, a result that stopped matching fails naming the field", () => {
    const Started = z.object({ runId: z.string() });
    expect(toolResultsIn([call("go", {}, '{"runId":"r1"}')], "go", Started)).toEqual([
      { runId: "r1" },
    ]);
    expect(() => toolResultsIn([call("go", {}, '{"id":"r1"}')], "go", Started)).toThrow(
      /"go" result 0 does not match the schema/,
    );
  });
});

describe("statesIn", () => {
  const pushed = (state: unknown): SessionEvent => ({ type: "state.updated", meta, state });

  test("reads every frame in stream order, and lastStateIn's answer is the last", () => {
    const events = [pushed({ n: 1 }), saidByAgent("hi"), pushed({ n: 2 })];
    expect(statesIn(events)).toEqual([{ n: 1 }, { n: 2 }]);
    expect(statesIn(events).at(-1)).toEqual(lastStateIn(events));
  });

  test("is empty for a session that pushed nothing", () => {
    expect(statesIn([saidByAgent("hi")])).toEqual([]);
  });

  test("with a schema every frame is parsed, and a drifted one fails by position", () => {
    const View = z.object({ placed: z.boolean() });
    expect(statesIn([pushed({ placed: false }), pushed({ placed: true })], View)).toEqual([
      { placed: false },
      { placed: true },
    ]);
    expect(() => statesIn([pushed({ placed: false }), pushed({ done: true })], View)).toThrow(
      /state frame 1 does not match the schema/,
    );
  });
});

describe("toolNames", () => {
  test("reads the names in call order — the strongest claim about tool ORDER", () => {
    expect(toolNames(RUN_CODE)).toEqual(["run_code", "think", "run_code"]);
  });

  test("is empty for a turn that called nothing", () => {
    expect(toolNames([])).toEqual([]);
  });
});

describe("describeToolCalls", () => {
  test("names every call, in order, for a failure message", () => {
    expect(describeToolCalls(RUN_CODE)).toBe("called run_code, think, run_code");
  });

  test('an empty list reads as "called no tools", never as an empty bracket', () => {
    // The case the message exists for — the agent answered with a question
    // instead of acting — and `tools called: []` reads like a truncated message.
    expect(describeToolCalls([])).toBe("called no tools");
  });
});
