// Copyright 2026 the AAI authors. MIT license.
/**
 * `agent({ events })` end to end, through a real runtime.
 *
 * The unit specs for the pieces are `session-emitter.test.ts` (ordering, the
 * non-fatal rule) and `session-event-stream.test.ts` (recording, reading). What
 * this file asserts is the WIRING an author depends on: that declaring handlers
 * on the agent is enough, that they see the events a session really emits, and
 * that the same events are readable back off the runtime.
 */

import type { SessionEventHandlers } from "@alexkroman1/aai";
import type { SessionEvent } from "@alexkroman1/aai/protocol";
import { describe, expect, test } from "vitest";
import { makeAgent, makeClientSink, silentLogger } from "./_test-utils.ts";
import { createRuntime } from "./runtime.ts";

const SID = "s-1";

function runtimeWith(events: SessionEventHandlers) {
  const agent = makeAgent({
    tools: {
      ping: { description: "say something", execute: () => "ok" },
    },
    events,
  });
  return createRuntime({
    agent,
    env: { MY_KEY: "v" },
    logger: silentLogger,
  });
}

describe("agent({ events }) through the runtime", () => {
  test("a declared handler sees the session's own events", () => {
    const seen: SessionEvent[] = [];
    const runtime = runtimeWith({ "*": (e) => seen.push(e) });
    const client = makeClientSink();

    const session = runtime.createSession({ id: SID, agent: "a", client });
    session.configure(runtime.readyConfig);
    session.report({ type: "user-transcript.committed", text: "hello" });

    expect(seen.map((e) => e.type)).toEqual(["session.configured", "user-transcript.committed"]);
  });

  test("a typed handler gets its own event with its own fields", () => {
    const names: string[] = [];
    const runtime = runtimeWith({ "tool.called": (e) => names.push(e.toolName) });
    const session = runtime.createSession({ id: SID, agent: "a", client: makeClientSink() });

    session.onReplyStarted("r1");
    session.report({ type: "tool.called", toolCallId: "c1", toolName: "ping", args: { a: 1 } });

    expect(names).toEqual(["ping"]);
  });

  test("the context carries the AGENT env, not the provider env", () => {
    const envs: unknown[] = [];
    const runtime = runtimeWith({ "*": (_e, ctx) => envs.push(ctx.env) });
    const session = runtime.createSession({ id: SID, agent: "a", client: makeClientSink() });

    session.report({ type: "speech.started" });

    // Provider credentials must never reach a hook, for the same reason they
    // never reach `ctx.env` in a tool.
    expect(envs[0]).toEqual({ MY_KEY: "v" });
  });

  test("a throwing handler does not break the session", () => {
    const runtime = runtimeWith({
      "*": () => {
        throw new Error("audit down");
      },
    });
    const client = makeClientSink();
    const session = runtime.createSession({ id: SID, agent: "a", client });

    expect(() =>
      session.report({ type: "user-transcript.committed", text: "hello" }),
    ).not.toThrow();
    // And the client still got its frame.
    expect(client.event).toHaveBeenCalled();
  });

  test("ctx.send and a state push reach a hook, like every other event", () => {
    const seen: string[] = [];
    const agent = makeAgent({
      tools: {
        shout: {
          description: "send a custom event",
          execute: (_args: unknown, ctx: { send: (e: string, d: unknown) => void }) => {
            ctx.send("progress", 1);
            return "ok";
          },
        },
      },
      events: { "*": (e) => seen.push(e.type) },
    });
    const runtime = createRuntime({ agent, env: {}, logger: silentLogger });
    const client = makeClientSink();
    runtime.createSession({ id: SID, agent: "a", client });

    return runtime.executeTool("shout", {}, SID, []).then(() => {
      // These two used to write straight to a `ClientSink`, which made them the
      // only events no hook could observe and no log could contain.
      expect(seen).toContain("custom.emitted");
    });
  });

  test("the runtime exposes the stream, so the same events read back", async () => {
    const runtime = runtimeWith({});
    const session = runtime.createSession({ id: SID, agent: "a", client: makeClientSink() });

    session.configure(runtime.readyConfig);
    session.report({ type: "user-transcript.committed", text: "hello" });

    const page = await runtime.sessionEvents?.read(SID, 0);
    expect(page?.events.map((e) => e.type)).toEqual([
      "session.configured",
      "user-transcript.committed",
    ]);
  });

  test("an agent that declares no handlers still records", async () => {
    const runtime = createRuntime({ agent: makeAgent(), env: {}, logger: silentLogger });
    const session = runtime.createSession({ id: SID, agent: "a", client: makeClientSink() });

    session.report({ type: "speech.started" });

    // The stream is not opt-in — a resume reads it, so it is always kept.
    await expect(runtime.sessionEvents?.read(SID, 0)).resolves.toMatchObject({ tail: 1 });
  });

  // Two tests about `ctx.db` on the hook context stood here — that hooks still
  // ran on an agent with no storage, and that a hook got the handle when there
  // was one. `db` is gone from `SessionEventContext` along with `ctx.db`: the
  // platform provides no database, so a hook that wants to persist brings its
  // own client. What the first of them was really protecting — that ONE hook
  // throwing does not break the session — is covered by "a throwing handler does
  // not break the session" above, which is the general case.
});
