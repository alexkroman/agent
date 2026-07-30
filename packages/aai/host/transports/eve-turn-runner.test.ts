// Copyright 2026 the AAI authors. MIT license.

import { describe, expect, test, vi } from "vitest";
import type { Logger } from "../runtime-config.ts";
import {
  createEveTurnRunner,
  type EveAgentHandle,
  type EveStreamEvent,
} from "./eve-turn-runner.ts";
import type { PipelineTurnArgs } from "./pipeline-turn-runner.ts";

const noop = (): void => undefined;
const silentLogger: Logger = { debug: noop, info: noop, warn: noop, error: noop };

const ev = (type: string, data?: Record<string, unknown>): EveStreamEvent => ({ type, data });

/** A complete one-reply turn: started → deltas → completed → waiting. */
function replyEvents(turnId: string, text: string, token: string): EveStreamEvent[] {
  return [
    ev("turn.started", { turnId }),
    ...[...text].map((ch) => ev("message.appended", { messageDelta: ch, turnId })),
    ev("message.completed", { message: text, turnId }),
    ev("turn.completed", { turnId }),
    ev("session.waiting", { continuationToken: token, wait: "next-user-message" }),
  ];
}

/** Closed stream delivering `events` in order. */
function streamOf(events: readonly EveStreamEvent[]): ReadableStream<EveStreamEvent> {
  return new ReadableStream({
    start(controller) {
      for (const e of events) controller.enqueue(e);
      controller.close();
    },
  });
}

/** Stream that emits `events` then stays open until cancelled. */
function hangingStreamOf(events: readonly EveStreamEvent[]): ReadableStream<EveStreamEvent> {
  return new ReadableStream({
    start(controller) {
      for (const e of events) controller.enqueue(e);
    },
  });
}

type FakeAgent = EveAgentHandle & {
  run: ReturnType<typeof vi.fn>;
  deliver: ReturnType<typeof vi.fn>;
  cancelTurn: ReturnType<typeof vi.fn>;
  getEventStream: ReturnType<typeof vi.fn>;
};

/** Fake agent whose event stream is scripted per getEventStream call. */
function fakeAgent(streams: ReadableStream<EveStreamEvent>[]): FakeAgent {
  let call = 0;
  return {
    run: vi.fn(async () => ({ sessionId: "es-1" })),
    deliver: vi.fn(async () => ({ sessionId: "es-1" })),
    cancelTurn: vi.fn(async () => ({ status: "accepted" })),
    getEventStream: vi.fn(async () => {
      const s = streams[call];
      call += 1;
      if (!s) throw new Error("no scripted stream left");
      return s;
    }),
  };
}

type Sinks = {
  args: PipelineTurnArgs;
  transcript: () => string;
  spoken: () => string;
  toolCalls: ReturnType<typeof vi.fn>;
  toolDone: ReturnType<typeof vi.fn>;
  errors: ReturnType<typeof vi.fn>;
};

function makeArgs(userText: string, overrides: Partial<PipelineTurnArgs> = {}): Sinks {
  let transcript = "";
  let spoken = "";
  const toolCalls = vi.fn();
  const toolDone = vi.fn();
  const errors = vi.fn();
  const args: PipelineTurnArgs = {
    userText,
    systemPrompt: "prompt",
    messages: [],
    ctl: new AbortController(),
    onDelta: (d) => {
      transcript += d;
    },
    sendTtsText: (t) => {
      spoken += t;
    },
    holdPhrase: "One moment.",
    callbacks: { onToolCall: toolCalls, onToolCallDone: toolDone },
    emitError: errors,
    log: silentLogger,
    sid: "sid-1",
    ...overrides,
  };
  return { args, transcript: () => transcript, spoken: () => spoken, toolCalls, toolDone, errors };
}

describe("createEveTurnRunner — happy path", () => {
  test("first turn runs the eve agent and streams deltas to transcript and TTS", async () => {
    const agent = fakeAgent([streamOf(replyEvents("t1", "Hi there.", "tok-2"))]);
    const runner = createEveTurnRunner({ agent });
    const s = makeArgs("hello");

    const result = await runner(s.args);

    expect(result).toEqual({ messages: [], failed: false });
    expect(s.transcript()).toBe("Hi there.");
    expect(s.spoken()).toBe("Hi there.");
    expect(agent.run).toHaveBeenCalledTimes(1);
    expect(agent.deliver).not.toHaveBeenCalled();
    const runInput = agent.run.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(runInput.mode).toBe("conversation");
    expect(runInput.continuationToken).toBe("voice:sid-1");
    expect(runInput.input).toEqual({ message: "hello" });
  });

  test("extra runInput fields are merged, runner-owned fields win", async () => {
    const agent = fakeAgent([streamOf(replyEvents("t1", "ok", "tok"))]);
    const runner = createEveTurnRunner({
      agent,
      runInput: { adapter: "ADAPTER", auth: null, input: { message: "SHOULD LOSE" } },
    });
    await runner(makeArgs("real text").args);
    const runInput = agent.run.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(runInput.adapter).toBe("ADAPTER");
    expect(runInput.input).toEqual({ message: "real text" });
  });

  test("second turn delivers with the token from session.waiting and resumes the cursor", async () => {
    const first = replyEvents("t1", "one", "tok-2");
    const agent = fakeAgent([streamOf(first), streamOf(replyEvents("t2", "two", "tok-3"))]);
    const runner = createEveTurnRunner({ agent });

    await runner(makeArgs("first").args);
    const s2 = makeArgs("second");
    const result = await runner(s2.args);

    expect(result.failed).toBe(false);
    expect(s2.transcript()).toBe("two");
    expect(agent.run).toHaveBeenCalledTimes(1);
    expect(agent.deliver).toHaveBeenCalledTimes(1);
    expect(agent.deliver.mock.calls[0]?.[0]).toEqual({
      continuationToken: "tok-2",
      payload: { message: "second" },
    });
    // Second read starts after every event the first turn consumed.
    expect(agent.getEventStream.mock.calls[1]?.[1]).toEqual({ startIndex: first.length });
  });

  test("a failed deliver falls back to a fresh run()", async () => {
    const agent = fakeAgent([
      streamOf(replyEvents("t1", "one", "tok-2")),
      streamOf(replyEvents("t1b", "recovered", "tok-x")),
    ]);
    agent.deliver.mockRejectedValueOnce(new Error("no parked session"));
    const runner = createEveTurnRunner({ agent });

    await runner(makeArgs("first").args);
    const s2 = makeArgs("second");
    const result = await runner(s2.args);

    expect(result.failed).toBe(false);
    expect(s2.transcript()).toBe("recovered");
    expect(agent.run).toHaveBeenCalledTimes(2);
    // The fallback session's stream is read from the beginning.
    expect(agent.getEventStream.mock.calls[1]?.[1]).toEqual({ startIndex: 0 });
  });
});

describe("createEveTurnRunner — tools", () => {
  test("actions.requested and action.result surface as tool observability", async () => {
    const agent = fakeAgent([
      streamOf([
        ev("turn.started", { turnId: "t1" }),
        ev("actions.requested", {
          turnId: "t1",
          actions: [{ callId: "c1", kind: "tool-call", toolName: "lookup", input: { q: "x" } }],
        }),
        ev("action.result", { turnId: "t1", result: { callId: "c1", output: "found" } }),
        ev("message.appended", { messageDelta: "Done.", turnId: "t1" }),
        ev("session.waiting", { continuationToken: "tok" }),
      ]),
    ]);
    const runner = createEveTurnRunner({ agent });
    const s = makeArgs("go");

    await runner(s.args);

    expect(s.toolCalls).toHaveBeenCalledWith("c1", "lookup", { q: "x" });
    expect(s.toolDone).toHaveBeenCalledWith("c1", "found");
    // Tool-first turn: the hold phrase reaches TTS before the reply text.
    expect(s.spoken().startsWith("One moment.")).toBe(true);
    expect(s.transcript()).toContain("Done.");
  });
});

describe("createEveTurnRunner — failure and cancellation", () => {
  test("turn.failed marks the turn failed and reports the error", async () => {
    const agent = fakeAgent([
      streamOf([
        ev("turn.started", { turnId: "t1" }),
        ev("turn.failed", { turnId: "t1", code: "model", message: "boom" }),
        ev("session.waiting", { continuationToken: "tok" }),
      ]),
    ]);
    const runner = createEveTurnRunner({ agent });
    const s = makeArgs("go");

    const result = await runner(s.args);

    expect(result.failed).toBe(true);
    expect(s.errors).toHaveBeenCalledWith("llm", "boom");
  });

  test("session.failed ends the turn as failed", async () => {
    const agent = fakeAgent([
      streamOf([ev("session.failed", { sessionId: "es-1", code: "x", message: "dead" })]),
    ]);
    const runner = createEveTurnRunner({ agent });
    const s = makeArgs("go");

    const result = await runner(s.args);

    expect(result.failed).toBe(true);
    expect(s.errors).toHaveBeenCalledWith("llm", "dead");
  });

  test("a run() rejection reports the failure", async () => {
    const agent = fakeAgent([]);
    agent.run.mockRejectedValueOnce(new Error("eve down"));
    const runner = createEveTurnRunner({ agent });
    const s = makeArgs("go");

    const result = await runner(s.args);

    expect(result.failed).toBe(true);
    expect(s.errors).toHaveBeenCalledWith("llm", "eve down");
  });

  test("barge-in cancels the eve turn and is not a failure", async () => {
    const agent = fakeAgent([
      hangingStreamOf([
        ev("turn.started", { turnId: "t1" }),
        ev("message.appended", { messageDelta: "Long reply", turnId: "t1" }),
      ]),
    ]);
    const runner = createEveTurnRunner({ agent });
    const s = makeArgs("go");

    const pending = runner(s.args);
    await vi.waitFor(() => expect(s.transcript()).toBe("Long reply"));
    s.args.ctl.abort();
    const result = await pending;

    expect(result).toEqual({ messages: [], failed: false });
    expect(agent.cancelTurn).toHaveBeenCalledWith({ sessionId: "es-1", turnId: "t1" });
  });

  test("an abort before the turn starts cancels without a turnId", async () => {
    const agent = fakeAgent([hangingStreamOf([])]);
    const runner = createEveTurnRunner({ agent });
    const s = makeArgs("go");

    const pending = runner(s.args);
    await vi.waitFor(() => expect(agent.getEventStream).toHaveBeenCalled());
    s.args.ctl.abort();
    const result = await pending;

    expect(result.failed).toBe(false);
    expect(agent.cancelTurn).toHaveBeenCalledWith({ sessionId: "es-1" });
  });

  test("a turn aborted before it runs does nothing", async () => {
    const agent = fakeAgent([]);
    const runner = createEveTurnRunner({ agent });
    const s = makeArgs("go");
    s.args.ctl.abort();

    const result = await runner(s.args);

    expect(result).toEqual({ messages: [], failed: false });
    expect(agent.run).not.toHaveBeenCalled();
  });
});

describe("createEveTurnRunner — stale-event gate", () => {
  test("leftover events of a cancelled turn are skipped until turn.started", async () => {
    // Turn 1 is aborted mid-reply; its tail (deltas + turn.cancelled +
    // session.waiting) is still unread. Turn 2's read must skip that tail's
    // content, adopt the parked token, then speak only its own reply.
    const agent = fakeAgent([
      hangingStreamOf([
        ev("turn.started", { turnId: "t1" }),
        ev("message.appended", { messageDelta: "First", turnId: "t1" }),
      ]),
      streamOf([
        ev("message.appended", { messageDelta: " STALE", turnId: "t1" }),
        ev("turn.cancelled", { turnId: "t1" }),
        ev("session.waiting", { continuationToken: "tok-2" }),
        ...replyEvents("t2", "Fresh reply", "tok-3"),
      ]),
    ]);
    const runner = createEveTurnRunner({ agent });

    const s1 = makeArgs("first");
    const pending = runner(s1.args);
    await vi.waitFor(() => expect(s1.transcript()).toBe("First"));
    s1.args.ctl.abort();
    await pending;

    const s2 = makeArgs("second");
    const result = await runner(s2.args);

    expect(result.failed).toBe(false);
    expect(s2.transcript()).toBe("Fresh reply");
    expect(s2.spoken()).toBe("Fresh reply");
  });
});
