// Copyright 2026 the AAI authors. MIT license.
import { agent, tool } from "@alexkroman1/aai";
import { withTools } from "@alexkroman1/aai/manifest";
import type { SessionEvent, SessionEventBody, SessionEventMeta } from "@alexkroman1/aai/protocol";
import { runTextAgent } from "@alexkroman1/aai-runtime/testing";
import { beforeEach, describe, expect, test } from "vitest";
import { z } from "zod";
import { eventScope } from "./assertions.ts";
import { createRecorder, type EvalRecorder } from "./runner.ts";

/**
 * The RUNNER's recorder, plus two readers for the labels a test asserts on.
 *
 * `createRecorder` rather than a second implementation of it: the copy this
 * replaces repeated the detail-omission rule (`detail` kept only on a failure),
 * which is the very shape the assertions below check — so a change to that rule
 * in `runner.ts` would have left this suite green against a recorder the tier no
 * longer uses.
 */
function recorder(): EvalRecorder & { failed(): string[]; held(): string[] } {
  const rec = createRecorder();
  return {
    ...rec,
    failed: () => rec.checks.filter((c) => !c.ok).map((c) => c.label),
    held: () => rec.checks.filter((c) => c.ok).map((c) => c.label),
  };
}

let stamped = 0;
/**
 * Stamp an event body the way the session's emitter would.
 *
 * GENERIC, so the result is the body's own member intersected with the
 * envelope, and no cast is needed. The `as SessionEvent` this replaces is the
 * shape that stops reporting when the type GROWS — the same failure
 * `createToolContext` exists to prevent for `ToolContext`. Here the constraint
 * does the work: add a required field to `SessionEvent` and every call below
 * fails to type-check, because the argument no longer satisfies
 * `SessionEventBody`.
 */
function ev<B extends SessionEventBody>(body: B): B & { meta: SessionEventMeta } {
  stamped += 1;
  return { ...body, meta: { id: `evt_${stamped}`, at: stamped } };
}

// The counter is module-level so ids are unique within a file, and reset per
// test so a case's event ids do not depend on how many tests ran before it.
beforeEach(() => {
  stamped = 0;
});

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
      ev({ type: "error.reported", code: "stt", message: "provider gone", fatal: true }),
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

  test("an out-of-range turn fails its NEGATIVE assertions too", () => {
    // The half that used to pass vacuously, and the reason the guide's claim
    // above was only true of the first call: every negative assertion holds over
    // an empty event list, so a three-call chain on a turn that never happened
    // recorded one failure and two passes and scored 75%.
    const rec = recorder();
    const scope = eventScope(rec, toolTurn()).turn(3);
    scope.noErrors();
    scope.usedNoTools();
    scope.notCalledTool("cancel_order");
    scope.notEvent("error.reported");
    scope.maxToolCalls(0);
    scope.saidNothingAbout("refund");
    expect(rec.held()).toEqual([]);
    expect(rec.failed()).toHaveLength(7); // the turn(3) record plus all six
    expect(rec.checks.at(-1)?.detail).toContain("only 1 turn");
  });

  test("EVERY arm of a nonexistent turn fails — not just the six above", () => {
    // The arms are the whole surface, so covering a subset reproduces the
    // original defect one method along: an assertion left holding over the
    // empty list still turns a chain on a turn that never happened into a
    // partial pass. This drives all fourteen and both counters, so a newly
    // added arm that forgets to fail shows up here rather than in a score.
    const rec = recorder();
    const scope = eventScope(rec, toolTurn()).turn(9);
    // The three tool arms (`./tool-assertions.ts`) come through the same
    // failing recorder, which is what makes a NEGATIVE one (`noToolResult…`,
    // vacuously true over no calls) fail here as well.
    scope.toolResultMatching(/error TS\d/);
    scope.noToolResultMatching(/error TS\d/);
    scope.eachToolFollowedBy("write_file", "check_types");
    scope.succeeded();
    scope.calledTool("cancel_order");
    scope.notCalledTool("cancel_order");
    scope.toolOrder(["a", "b"]);
    scope.usedNoTools();
    scope.maxToolCalls(0);
    scope.saidSomething("refund");
    scope.saidNothingAbout("refund");
    scope.noErrors();
    scope.event("error.reported");
    scope.notEvent("error.reported");
    scope.eventOrder(["reply.completed", "audio.completed"]);
    // The predicate must never RUN: an absent turn has nothing to satisfy, so
    // reaching it would mean the arm was evaluating rather than failing.
    scope.eventsSatisfy("anything at all", () => {
      throw new Error("the predicate of an absent turn must not be evaluated");
    });
    expect(rec.held()).toEqual([]);
    // The turn(9) record plus one per arm — nothing passed, nothing was skipped.
    expect(rec.failed()).toHaveLength(17);
    // An absent turn has no events and no sub-turns, and says so as data
    // rather than by failing: these are reads, not assertions.
    expect(scope.turns()).toBe(0);
    expect(scope.events).toEqual([]);
    expect(scope.toolCalls).toEqual([]);
    expect(scope.said).toEqual([]);
  });

  test("a turn OF a nonexistent turn is nonexistent too", () => {
    const rec = recorder();
    eventScope(rec, toolTurn()).turn(3).turn(0).usedNoTools();
    expect(rec.held()).toEqual([]);
  });

  test("a reply still in flight is not a turn", () => {
    const rec = recorder();
    expect(eventScope(rec, [heard("hello"), called("c1", "x")]).turns()).toBe(0);
  });
});

/**
 * The claim `text-agent-events.ts` was written for: a TEXT agent emits the same
 * `SessionEvent` union, so this vocabulary reads one with no second
 * implementation.
 *
 * Driven through the real `runTextAgent` over a scripted model — the real
 * `createTextAgent`, the real tool executor, real results — because the
 * interesting half is not that the types line up but that the events a live
 * text turn produces are the ones these assertions partition and count. A
 * hand-built event list would have proved the types and nothing else.
 */
describe("the vocabulary over a TEXT agent's events", () => {
  /** A verification that comes back RED, which is what the tool arms are for. */
  const writeFile = tool({
    description: "Write a file.",
    inputSchema: z.object({ path: z.string() }),
    execute: ({ path }) => `wrote ${path}\nsrc/a.ts(3,1): error TS2345: nope`,
  });
  const checkTypes = tool({
    description: "Type-check the workspace.",
    inputSchema: z.object({}),
    execute: () => "no errors",
  });
  const coder = withTools(agent({ name: "Coder", text: true }), {
    write_file: writeFile,
    check_types: checkTypes,
  });

  async function codingTurn() {
    return await runTextAgent(coder, "add a health route", {
      script: [
        { text: "Writing it.", toolCalls: [{ name: "write_file", input: { path: "src/a.ts" } }] },
        { toolCalls: [{ name: "check_types" }] },
        { text: "Done — types are clean." },
      ],
    });
  }

  test("every existing arm holds over a real text turn, unchanged", async () => {
    const rec = recorder();
    const scope = eventScope(rec, (await codingTurn()).events);
    scope.succeeded();
    scope.noErrors();
    scope.calledTool("write_file", { args: { path: "src/a.ts" }, count: 1 });
    scope.calledTool("check_types", { result: "no errors" });
    scope.notCalledTool("delete_file");
    scope.toolOrder(["write_file", "check_types"]);
    scope.maxToolCalls(2);
    scope.saidSomething(/types are clean/);
    scope.saidNothingAbout("refund");
    scope.event("tool.called", { count: 2 });
    scope.notEvent("reply.cancelled");
    scope.eventOrder(["user-transcript.committed", "tool.called", "reply.completed"]);
    expect(rec.failed()).toEqual([]);
    // One turn, and it is the whole run: a text turn emits exactly one
    // terminator, which is what `turnsOf` partitions on.
    expect(scope.turns()).toBe(1);
    // A text agent commits its reply ONCE, joined across steps — where a voice
    // session commits per utterance. That is the one difference a case ported
    // across meets, and it is a property of the mode rather than of the arm.
    expect(scope.said).toEqual(["Writing it.Done — types are clean."]);
  });

  test("the tool arms grade the verification a coding agent is judged on", async () => {
    const rec = recorder();
    const scope = eventScope(rec, (await codingTurn()).events);
    // The write came back red, the check did not, and every write was followed
    // by a check — the three claims `studio-target.ts` hand-rolls as
    // `redChecks`, `redExcerpts` and a tool-name walk.
    scope.toolResultMatching(/error TS\d/, { tools: ["write_file"] });
    scope.noToolResultMatching(/error TS\d/, { tools: ["check_types"] });
    scope.eachToolFollowedBy("write_file", "check_types");
    // A ceiling with no floor: one repair is allowed, and the same claim holds
    // over an agent that needed none.
    scope.toolResultMatching(/error TS\d/, { tools: ["write_file"], max: 1 });
    expect(rec.failed()).toEqual([]);
  });

  test("an unchecked write fails the sequence claim that toolOrder cannot make", async () => {
    const run = await runTextAgent(coder, "add a health route", {
      script: [
        { toolCalls: [{ name: "write_file", input: { path: "src/a.ts" } }] },
        { toolCalls: [{ name: "check_types" }] },
        { toolCalls: [{ name: "write_file", input: { path: "src/b.ts" } }] },
        { text: "Shipped." },
      ],
    });
    const rec = recorder();
    const scope = eventScope(rec, run.events);
    // A SUBSEQUENCE, so it holds: one write does precede one check.
    scope.toolOrder(["write_file", "check_types"]);
    scope.eachToolFollowedBy("write_file", "check_types");
    expect(rec.held()).toEqual(["toolOrder(write_file → check_types)"]);
    expect(rec.failed()).toEqual(["eachToolFollowedBy(write_file → check_types)"]);
  });
});
