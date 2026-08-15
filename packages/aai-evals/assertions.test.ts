// Copyright 2026 the AAI authors. MIT license.
import type { SessionEvent, SessionEventBody } from "@alexkroman1/aai/protocol";
import { describe, expect, test } from "vitest";
import { eventScope } from "./assertions.ts";
import type { EvalCheck, EvalRecorder } from "./runner.ts";

/** A recorder with no runner around it. */
function recorder(): EvalRecorder & { failed(): string[]; held(): string[] } {
  const checks: EvalCheck[] = [];
  return {
    checks,
    check(ok, label, detail) {
      checks.push(ok || detail === undefined ? { label, ok } : { label, ok, detail });
    },
    failed: () => checks.filter((c) => !c.ok).map((c) => c.label),
    held: () => checks.filter((c) => c.ok).map((c) => c.label),
  };
}

let stamped = 0;
/** Stamp an event body the way the session's emitter would. */
function ev(body: SessionEventBody): SessionEvent {
  stamped += 1;
  return { ...body, meta: { id: `evt_${stamped}`, at: stamped } } as SessionEvent;
}

const called = (id: string, toolName: string, args: Record<string, unknown> = {}): SessionEvent =>
  ev({ type: "tool.called", toolCallId: id, toolName, args });
const completed = (id: string, result: string): SessionEvent =>
  ev({ type: "tool.completed", toolCallId: id, result });
const said = (text: string): SessionEvent => ev({ type: "agent-transcript.committed", text });
const heard = (text: string): SessionEvent => ev({ type: "user-transcript.committed", text });
const done = (): SessionEvent => ev({ type: "reply.completed" });

/** One tool turn: the caller spoke, a tool ran, the agent answered. */
const toolTurn = (): SessionEvent[] => [
  heard("where is order W1234"),
  called("c1", "lookup_order", { orderId: "W1234", trace: { by: "voice" } }),
  completed("c1", '{"status":"shipped"}'),
  said("It shipped yesterday."),
  done(),
];

describe("calledTool", () => {
  test("holds on the name and reports what was called instead", () => {
    const rec = recorder();
    const scope = eventScope(rec, toolTurn());
    scope.calledTool("lookup_order");
    scope.calledTool("cancel_order");
    expect(rec.held()).toEqual(["calledTool(lookup_order)"]);
    expect(rec.checks.at(-1)?.detail).toContain("lookup_order");
  });

  test("matches arguments PARTIALLY, so an extra field is not a failure", () => {
    const rec = recorder();
    eventScope(rec, toolTurn()).calledTool("lookup_order", { args: { orderId: "W1234" } });
    expect(rec.failed()).toEqual([]);
  });

  test("fails on a wrong argument and prints the one it saw", () => {
    const rec = recorder();
    eventScope(rec, toolTurn()).calledTool("lookup_order", { args: { orderId: "W9999" } });
    expect(rec.failed()).toHaveLength(1);
    expect(rec.checks.at(-1)?.detail).toContain("W1234");
  });

  test("matches a nested argument", () => {
    const rec = recorder();
    eventScope(rec, toolTurn()).calledTool("lookup_order", { args: { trace: { by: "voice" } } });
    expect(rec.failed()).toEqual([]);
  });

  test("an ARRAY argument matches element-wise and by length", () => {
    const rec = recorder();
    const events = [called("c1", "add_items", { ids: ["a", "b"], note: null }), done()];
    const scope = eventScope(rec, events);
    scope.calledTool("add_items", { args: { ids: ["a", "b"], note: null } });
    scope.calledTool("add_items", { args: { ids: ["a"] } });
    scope.calledTool("add_items", { args: { ids: ["a", "c"] } });
    // A non-object where an object is expected is a mismatch, not a crash.
    scope.calledTool("add_items", { args: { note: { deep: 1 } } });
    expect(rec.failed()).toEqual([
      'calledTool(add_items) args {"ids":["a"]}',
      'calledTool(add_items) args {"ids":["a","c"]}',
      'calledTool(add_items) args {"note":{"deep":1}}',
    ]);
  });

  test("counts calls and reads the result", () => {
    const rec = recorder();
    const scope = eventScope(rec, toolTurn());
    scope.calledTool("lookup_order", { count: 1, result: "shipped" });
    expect(rec.failed()).toEqual([]);
    scope.calledTool("lookup_order", { count: 2 });
    expect(rec.failed()).toEqual(["calledTool(lookup_order) count=2"]);
  });
});

describe("order and count", () => {
  test("toolOrder is a subsequence, not an exact list", () => {
    const rec = recorder();
    const events = [
      ...toolTurn(),
      called("c2", "note"),
      called("c3", "cancel_order"),
      completed("c3", "ok"),
      done(),
    ];
    const scope = eventScope(rec, events);
    scope.toolOrder(["lookup_order", "cancel_order"]);
    scope.toolOrder(["cancel_order", "lookup_order"]);
    expect(rec.held()).toEqual(["toolOrder(lookup_order → cancel_order)"]);
  });

  test("maxToolCalls and usedNoTools", () => {
    const rec = recorder();
    const scope = eventScope(rec, toolTurn());
    scope.maxToolCalls(1);
    scope.usedNoTools();
    expect(rec.failed()).toEqual(["usedNoTools"]);
  });

  test("notCalledTool reports how many times it was called", () => {
    const rec = recorder();
    eventScope(rec, toolTurn()).notCalledTool("lookup_order");
    expect(rec.checks.at(-1)).toEqual({
      label: "notCalledTool(lookup_order)",
      ok: false,
      detail: "called 1x",
    });
  });
});

describe("what the agent said", () => {
  test("reads committed transcripts only, case-insensitively", () => {
    const rec = recorder();
    const events = [
      ev({ type: "agent-transcript.updated", text: "I'm checking" }),
      said("It SHIPPED yesterday."),
      done(),
    ];
    const scope = eventScope(rec, events);
    scope.saidSomething("shipped");
    scope.saidSomething("checking");
    expect(rec.failed()).toEqual(["saidSomething(checking)"]);
  });

  test("accepts a regexp, and saidNothingAbout is the negative", () => {
    const rec = recorder();
    const scope = eventScope(rec, toolTurn());
    scope.saidSomething(/ship+ed/);
    scope.saidNothingAbout("refund");
    scope.saidNothingAbout("shipped");
    expect(rec.failed()).toEqual(["saidNothingAbout(shipped)"]);
  });
});

describe("succeeded and noErrors", () => {
  test("succeeded needs a completed reply", () => {
    const rec = recorder();
    eventScope(rec, [heard("hi")]).succeeded();
    expect(rec.failed()).toEqual(["succeeded"]);
    expect(rec.checks.at(-1)?.detail).toContain("no reply.completed");
  });

  test("a NON-fatal error does not fail succeeded, and a fatal one does", () => {
    const turnLevel = recorder();
    eventScope(turnLevel, [
      ...toolTurn(),
      ev({ type: "error.reported", code: "llm", message: "one bad turn", fatal: false }),
    ]).succeeded();
    expect(turnLevel.failed()).toEqual([]);

    const fatal = recorder();
    eventScope(fatal, [
      ...toolTurn(),
      ev({ type: "error.reported", code: "stt", message: "provider gone" }),
    ]).succeeded();
    expect(fatal.failed()).toEqual(["succeeded"]);
    expect(fatal.checks.at(-1)?.detail).toContain("provider gone");
  });

  test("noErrors reports every error it saw", () => {
    const rec = recorder();
    eventScope(rec, [
      ev({ type: "error.reported", code: "tool", message: "boom", fatal: false }),
    ]).noErrors();
    expect(rec.checks.at(-1)?.detail).toContain("tool: boom");
  });
});

describe("events", () => {
  test("event counts, with bounds", () => {
    const rec = recorder();
    const scope = eventScope(rec, toolTurn());
    scope.event("tool.called");
    scope.event("tool.called", { count: 1 });
    scope.event("tool.called", { min: 2 });
    scope.event("tool.called", { max: 0 });
    scope.notEvent("reply.cancelled");
    expect(rec.failed()).toEqual(["event(tool.called >=2)", "event(tool.called <=0)"]);
  });

  test("eventOrder is a subsequence over types", () => {
    const rec = recorder();
    const scope = eventScope(rec, toolTurn());
    scope.eventOrder(["user-transcript.committed", "tool.called", "reply.completed"]);
    scope.eventOrder(["reply.completed", "tool.called"]);
    expect(rec.failed()).toEqual(["eventOrder(reply.completed → tool.called)"]);
  });

  test("eventsSatisfy runs a predicate, and a throw is a failure not a crash", () => {
    const rec = recorder();
    const scope = eventScope(rec, toolTurn());
    scope.eventsSatisfy("balanced", (events) => {
      const a = events.filter((e) => e.type === "tool.called").length;
      const b = events.filter((e) => e.type === "tool.completed").length;
      return a === b;
    });
    scope.eventsSatisfy("throws", () => {
      throw new Error("nope");
    });
    expect(rec.failed()).toEqual(["throws"]);
    expect(rec.checks.at(-1)?.detail).toContain("predicate threw: nope");
  });
});

describe("turn scoping", () => {
  const twoTurns = (): SessionEvent[] => [
    ...toolTurn(),
    heard("cancel it"),
    called("c9", "cancel_order", { orderId: "W1234" }),
    completed("c9", "ok"),
    said("Cancelled."),
    done(),
  ];

  test("a turn scope sees only its own reply's events, and labels them", () => {
    const rec = recorder();
    const scope = eventScope(rec, twoTurns());
    expect(scope.turns()).toBe(2);
    scope.turn(0).notCalledTool("cancel_order");
    scope.turn(1).calledTool("cancel_order", { args: { orderId: "W1234" } });
    expect(rec.failed()).toEqual([]);
    expect(rec.held()).toEqual([
      "turn 0: notCalledTool(cancel_order)",
      "turn 1: calledTool(cancel_order)",
      'turn 1: calledTool(cancel_order) args {"orderId":"W1234"}',
    ]);
  });

  test("an out-of-range turn FAILS rather than silently asserting nothing", () => {
    const rec = recorder();
    const scope = eventScope(rec, toolTurn());
    scope.turn(3).calledTool("lookup_order");
    expect(rec.failed()).toEqual(["turn(3)", "turn 3: calledTool(lookup_order)"]);
    expect(rec.checks[0]?.detail).toContain("only 1 completed turn");
  });

  test("a reply still in flight is not a turn", () => {
    const rec = recorder();
    expect(eventScope(rec, [heard("hello"), called("c1", "x")]).turns()).toBe(0);
  });
});
