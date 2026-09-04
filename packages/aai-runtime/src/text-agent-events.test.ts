// Copyright 2026 the AAI authors. MIT license.
/**
 * Specs for a text agent's typed event stream.
 *
 * Two things are asserted that no other suite here can: that every event a text
 * agent emits satisfies the WIRE schema (the module's whole claim is that this
 * is the same `SessionEvent` union, so a member it could not honestly fill would
 * show up as a parse failure rather than as a comment), and that a turn ends in
 * exactly ONE terminator on every path — completed, aborted and failed alike,
 * which is what a harness waits on instead of a timer.
 */

import { type AgentDef, agent, tool } from "@alexkroman1/aai";
import { type ToolRegistry, withTools } from "@alexkroman1/aai/manifest";
import { type SessionEvent, SessionEventSchema } from "@alexkroman1/aai/protocol";
import type { TextStreamPart, ToolSet } from "ai";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { createFakeLanguageModel } from "./_fake-llm.ts";
import { makeLogger, silentLogger } from "./_test-utils.ts";
import { saidIn, TURN_ENDS, toolCallsInEvents, toolNames } from "./eval/events.ts";
import { createTextAgent } from "./text-agent.ts";
import { createTextAgentEvents } from "./text-agent-events.ts";

/** A text agent WITH its tools — the def a build produces, in one call. */
function textAgent(def: Parameters<typeof agent>[0], tools: ToolRegistry = {}): AgentDef {
  return withTools(agent(def), tools);
}

/** The one terminator a turn is allowed. */
function terminators(events: readonly SessionEvent[]): readonly string[] {
  return events.flatMap((event) => (TURN_ENDS.has(event.type) ? [event.type] : []));
}

/**
 * A `finish` part, in full.
 *
 * Its `totalUsage` is the vendor's own shape and nothing here asserts on it —
 * spelled out rather than cast, so a field the SDK adds fails the TYPE check
 * instead of being laundered past it.
 */
function finishChunk(): Extract<TextStreamPart<ToolSet>, { type: "finish" }> {
  return {
    type: "finish",
    finishReason: "stop",
    rawFinishReason: "stop",
    totalUsage: {
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
      inputTokenDetails: { noCacheTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      outputTokenDetails: { textTokens: 1, reasoningTokens: 0 },
    },
  };
}

/** Every event's `type`, in order — the shape most of these specs assert on. */
function types(events: readonly SessionEvent[]): readonly string[] {
  return events.map((event) => event.type);
}

describe("createTextAgent event stream", () => {
  test("a plain reply is a user turn, a committed reply, and one terminator", async () => {
    const events: SessionEvent[] = [];
    const chat = createTextAgent({
      agent: textAgent({ name: "Helper", text: true }),
      model: createFakeLanguageModel({ script: [{ type: "text", text: "hello there" }] }),
      logger: silentLogger,
      onEvent: (event) => events.push(event),
    });

    await chat.stream({ messages: [{ role: "user", content: "hi" }] }).consumeStream();

    expect(types(events)).toEqual([
      "user-transcript.committed",
      "agent-transcript.committed",
      "reply.completed",
    ]);
    expect(saidIn(events)).toEqual(["hello there"]);
  });

  test("every emitted event satisfies the wire schema and carries a stamped id", async () => {
    const events: SessionEvent[] = [];
    const chat = createTextAgent({
      agent: textAgent(
        { name: "Desk", text: true },
        { look_up: tool({ description: "Look up", execute: () => "shipped" }) },
      ),
      model: createFakeLanguageModel({
        steps: [
          [
            { type: "text", text: "Let me check. " },
            { type: "tool-call", toolCallId: "c1", toolName: "look_up", input: '{"id":"7"}' },
          ],
          [{ type: "text", text: "It shipped." }],
        ],
      }),
      logger: silentLogger,
      onEvent: (event) => events.push(event),
    });

    await chat
      .stream({ messages: [{ role: "user", content: "where is order 7?" }] })
      .consumeStream();

    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      // The whole claim of the module: these are wire events, not a shape that
      // merely resembles one. A member a text agent could not honestly fill
      // fails HERE rather than in whatever reads the stream later.
      expect(SessionEventSchema.safeParse(event).success, JSON.stringify(event)).toBe(true);
      expect(event.meta.id).toMatch(/^evt_/);
      expect(event.meta.at).toBeGreaterThan(0);
    }
    // Ids are per event, which is what makes the stream idempotent to ingest.
    expect(new Set(events.map((event) => event.meta.id)).size).toBe(events.length);
  });

  test("a tool-calling turn is readable by the eval readers, unchanged", async () => {
    const events: SessionEvent[] = [];
    const chat = createTextAgent({
      agent: textAgent(
        { name: "Desk", text: true },
        {
          look_up: tool({
            description: "Look up an order",
            inputSchema: z.object({ id: z.string() }),
            execute: ({ id }) => ({ order: id, status: "shipped" }),
          }),
        },
      ),
      model: createFakeLanguageModel({
        steps: [
          [
            { type: "text", text: "Let me check. " },
            { type: "tool-call", toolCallId: "c1", toolName: "look_up", input: '{"id":"7"}' },
          ],
          [{ type: "text", text: "It shipped." }],
        ],
      }),
      logger: silentLogger,
      onEvent: (event) => events.push(event),
    });

    await chat
      .stream({ messages: [{ role: "user", content: "where is order 7?" }] })
      .consumeStream();

    const calls = toolCallsInEvents(events);
    expect(toolNames(calls)).toEqual(["look_up"]);
    expect(calls[0]?.args).toEqual({ id: "7" });
    expect(calls[0]?.result).toBe('{"order":"7","status":"shipped"}');
    // The committed reply is the whole turn's text, across steps — the same
    // value `runTextAgent`'s `text` reports.
    expect(saidIn(events)).toEqual(["Let me check. It shipped."]);
    expect(terminators(events)).toEqual(["reply.completed"]);
  });

  test("a tool that THREW answers as a completion and reports a tool error", async () => {
    const events: SessionEvent[] = [];
    const chat = createTextAgent({
      agent: textAgent(
        { name: "Desk", text: true },
        {
          boom: tool({
            description: "Throws",
            execute: () => {
              throw new Error("kaboom");
            },
          }),
        },
      ),
      model: createFakeLanguageModel({
        steps: [
          [{ type: "tool-call", toolCallId: "c1", toolName: "boom", input: "{}" }],
          [{ type: "text", text: "sorry" }],
        ],
      }),
      logger: silentLogger,
      onEvent: (event) => events.push(event),
    });

    await chat.stream({ messages: [{ role: "user", content: "go" }] }).consumeStream();

    // A throw is a BUG, so it is reported — and the model still gets a result,
    // so the call is not left reading as one that never returned.
    const reported = events.filter((event) => event.type === "error.reported");
    expect(reported).toHaveLength(1);
    expect(reported[0]).toMatchObject({ code: "tool", fatal: false });
    expect(reported[0]).toHaveProperty("message", expect.stringContaining("kaboom"));
    const calls = toolCallsInEvents(events);
    expect(calls[0]?.result).toContain("kaboom");
    expect(terminators(events)).toEqual(["reply.completed"]);
  });

  test("an aborted turn cancels, commits no transcript, and terminates once", async () => {
    const events: SessionEvent[] = [];
    const abort = new AbortController();
    const chat = createTextAgent({
      agent: textAgent({ name: "Stoppable", text: true }),
      model: createFakeLanguageModel({
        script: [
          { type: "text", text: "start" },
          { type: "text", text: "never" },
        ],
        delayMs: 20,
      }),
      logger: silentLogger,
      onEvent: (event) => events.push(event),
    });

    const result = chat.stream({
      messages: [{ role: "user", content: "go" }],
      signal: abort.signal,
    });
    for await (const _delta of result.textStream) abort.abort();

    expect(terminators(events)).toEqual(["reply.cancelled"]);
    // The voice rule: an interrupted reply records nothing. The partial text is
    // in `textStream` and in `steps`, where a caller that wants it can read it.
    expect(saidIn(events)).toEqual([]);
  });

  test("a failed model stream reports an llm error and cancels once", async () => {
    const events: SessionEvent[] = [];
    const chat = createTextAgent({
      agent: textAgent({ name: "Flaky", text: true }),
      model: createFakeLanguageModel({
        script: [{ type: "error", error: new Error("provider exploded") }],
      }),
      logger: silentLogger,
      onEvent: (event) => events.push(event),
    });

    await chat.stream({ messages: [{ role: "user", content: "go" }] }).consumeStream();

    const reported = events.filter((event) => event.type === "error.reported");
    expect(reported).toHaveLength(1);
    expect(reported[0]).toMatchObject({ code: "llm", fatal: false });
    expect(reported[0]).toHaveProperty("message", expect.stringContaining("provider exploded"));
    expect(terminators(events)).toEqual(["reply.cancelled"]);
    expect(saidIn(events)).toEqual([]);
  });

  test("ctx.send becomes custom.emitted", async () => {
    const events: SessionEvent[] = [];
    const chat = createTextAgent({
      agent: textAgent(
        { name: "Notifier", text: true },
        {
          nudge: tool({
            description: "Send an event",
            execute: (_args, ctx) => {
              ctx.send("wind_down", { at: 3 });
              return "sent";
            },
          }),
        },
      ),
      model: createFakeLanguageModel({
        steps: [
          [{ type: "tool-call", toolCallId: "c1", toolName: "nudge", input: "{}" }],
          [{ type: "text", text: "done" }],
        ],
      }),
      logger: silentLogger,
      onEvent: (event) => events.push(event),
    });

    await chat.stream({ messages: [{ role: "user", content: "go" }] }).consumeStream();

    const custom = events.filter((event) => event.type === "custom.emitted");
    expect(custom).toEqual([
      expect.objectContaining({ type: "custom.emitted", event: "wind_down", data: { at: 3 } }),
    ]);
    // Between the call and its completion, which is when the tool ran.
    const order = types(events);
    expect(order.indexOf("custom.emitted")).toBeGreaterThan(order.indexOf("tool.called"));
    expect(order.indexOf("custom.emitted")).toBeLessThan(order.indexOf("tool.completed"));
  });

  test("a ctx.send the wire caps would drop is logged and not emitted", async () => {
    const events: SessionEvent[] = [];
    const logger = makeLogger();
    const chat = createTextAgent({
      agent: textAgent(
        { name: "Notifier", text: true },
        {
          nudge: tool({
            description: "Send an unserializable event",
            execute: (_args, ctx) => {
              ctx.send("bad", { big: 1n });
              return "sent";
            },
          }),
        },
      ),
      model: createFakeLanguageModel({
        steps: [
          [{ type: "tool-call", toolCallId: "c1", toolName: "nudge", input: "{}" }],
          [{ type: "text", text: "done" }],
        ],
      }),
      logger,
      onEvent: (event) => events.push(event),
    });

    await chat.stream({ messages: [{ role: "user", content: "go" }] }).consumeStream();

    expect(types(events)).not.toContain("custom.emitted");
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('ctx.send("bad")'));
  });

  test("no speech, audio or session-configured event is ever emitted", async () => {
    const events: SessionEvent[] = [];
    const chat = createTextAgent({
      agent: textAgent(
        { name: "Desk", text: true },
        { look_up: tool({ description: "Look up", execute: () => "shipped" }) },
      ),
      model: createFakeLanguageModel({
        steps: [
          [{ type: "tool-call", toolCallId: "c1", toolName: "look_up", input: "{}" }],
          [{ type: "text", text: "It shipped." }],
        ],
      }),
      logger: silentLogger,
      onEvent: (event) => events.push(event),
    });

    await chat.stream({ messages: [{ role: "user", content: "hi" }] }).consumeStream();

    // The narrowing, asserted from the other side: a member added to the emitted
    // set has to be argued for in the module doc first.
    expect(new Set(types(events))).toEqual(
      new Set([
        "user-transcript.committed",
        "tool.called",
        "tool.completed",
        "agent-transcript.committed",
        "reply.completed",
      ]),
    );
  });

  test("a conversation that does not end in a user message commits no user turn", async () => {
    const events: SessionEvent[] = [];
    const chat = createTextAgent({
      agent: textAgent({ name: "Continuer", text: true }),
      model: createFakeLanguageModel({ script: [{ type: "text", text: "carrying on" }] }),
      logger: silentLogger,
      onEvent: (event) => events.push(event),
    });

    await chat
      .stream({
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "hello" },
        ],
      })
      .consumeStream();

    expect(types(events)).toEqual(["agent-transcript.committed", "reply.completed"]);
  });

  test("an image-only user message commits no user turn", async () => {
    const events: SessionEvent[] = [];
    const chat = createTextAgent({
      agent: textAgent({ name: "Looker", text: true }),
      model: createFakeLanguageModel({ script: [{ type: "text", text: "a cat" }] }),
      logger: silentLogger,
      onEvent: (event) => events.push(event),
    });

    await chat
      .stream({
        messages: [
          { role: "user", content: [{ type: "image", image: "https://example.com/cat.png" }] },
        ],
      })
      .consumeStream();

    expect(types(events)).not.toContain("user-transcript.committed");
  });

  test("an unobserved turn installs no chunk callback at all", () => {
    const events = createTextAgentEvents(undefined, silentLogger);
    expect(events.openTurn([{ role: "user", content: "hi" }])).toBeUndefined();
    // And the two tool-side reports are inert rather than absent, so the agent
    // wiring has no branch of its own.
    expect(() => {
      events.custom("nope", {});
      events.toolFault("nope");
    }).not.toThrow();
  });
});

describe("createTextAgentEvents", () => {
  test("the backstop onEnd cannot produce a second terminator", () => {
    const events: SessionEvent[] = [];
    const turn = createTextAgentEvents((event) => events.push(event), silentLogger).openTurn([
      { role: "user", content: "hi" },
    ]);
    expect(turn).toBeDefined();

    turn?.onChunk({ chunk: { type: "text-delta", id: "t1", text: "hi back" } });
    turn?.onChunk({ chunk: finishChunk() });
    // Both of the paths that could double it: the backstop the SDK's own flush
    // fires, and a terminal part arriving behind one.
    turn?.onEnd();
    turn?.onChunk({ chunk: { type: "abort" } });

    expect(types(events)).toEqual([
      "user-transcript.committed",
      "agent-transcript.committed",
      "reply.completed",
    ]);
  });

  test("the backstop terminates a turn whose stream carried no terminal part", () => {
    const events: SessionEvent[] = [];
    const turn = createTextAgentEvents((event) => events.push(event), silentLogger).openTurn([]);
    turn?.onChunk({ chunk: { type: "text-delta", id: "t1", text: "said something" } });
    turn?.onEnd();

    expect(types(events)).toEqual(["agent-transcript.committed", "reply.completed"]);
    expect(saidIn(events)).toEqual(["said something"]);
  });

  test("an error part cancels, and a finish behind it changes nothing", () => {
    const events: SessionEvent[] = [];
    const turn = createTextAgentEvents((event) => events.push(event), silentLogger).openTurn([]);
    turn?.onChunk({ chunk: { type: "error", error: new Error("gone") } });
    turn?.onChunk({ chunk: finishChunk() });
    turn?.onEnd();

    expect(types(events)).toEqual(["error.reported", "reply.cancelled"]);
  });

  test("a call the SDK failed before the executor answers as a completion", () => {
    const events: SessionEvent[] = [];
    const turn = createTextAgentEvents((event) => events.push(event), silentLogger).openTurn([]);
    // `tool-error` rather than `tool-result`: the executor shapes a THROW as a
    // result, so this part is a call that never reached it — an unrepairable
    // input, or a name the model invented. Reporting it as a call that never
    // returned would be a finding the readers state, and a false one.
    turn?.onChunk({
      chunk: {
        type: "tool-error",
        toolCallId: "c1",
        toolName: "look_up",
        input: {},
        error: new Error("no such tool"),
      },
    });
    expect(events[0]).toMatchObject({
      type: "tool.completed",
      toolCallId: "c1",
      result: "no such tool",
    });
    expect(toolCallsInEvents(events)).toEqual([]);
  });

  test("a tool result that is not a string is serialized for the wire", () => {
    const events: SessionEvent[] = [];
    const turn = createTextAgentEvents((event) => events.push(event), silentLogger).openTurn([]);
    turn?.onChunk({
      chunk: {
        type: "tool-result",
        toolCallId: "c1",
        toolName: "look_up",
        input: {},
        output: { ok: true },
      },
    });
    expect(events[0]).toMatchObject({ type: "tool.completed", result: '{"ok":true}' });
  });
});
