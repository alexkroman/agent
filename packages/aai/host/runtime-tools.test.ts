// Copyright 2026 the AAI authors. MIT license.
/**
 * Tool-surface wiring that depends on WHICH client socket is live.
 *
 * A tool call can outlive the connection that issued it — it runs for up to
 * TOOL_EXECUTION_TIMEOUT_MS, and a session survives a disconnect through the
 * resume grace window — so everything the runtime sends on a tool's behalf
 * (`ctx.send`, the `syncState` push) has to reach whichever sink holds the
 * session id when the send happens, not the one that held it at dispatch.
 */

import { describe, expect, test, vi } from "vitest";
import { createOwnedMap } from "../sdk/owned-map.ts";
import type { ClientEvent, ClientSink } from "../sdk/protocol.ts";
import type { AgentDef } from "../sdk/types.ts";
import { makeAgent } from "./_test-utils.ts";
import { consoleLogger } from "./runtime-config.ts";
import { setupTools } from "./runtime-tools.ts";

const SID = "session-1";

function recordingSink(events: ClientEvent[]): ClientSink {
  return {
    open: true,
    event: (e: ClientEvent) => events.push(e),
    playAudioChunk: () => undefined,
    playAudioDone: () => undefined,
  } as unknown as ClientSink;
}

/**
 * A self-hosted tool surface whose single tool parks until released, so a
 * reconnect can land mid-call.
 */
function parkedToolRuntime(agentOverrides: Partial<AgentDef>) {
  const { promise: parked, resolve: release } = Promise.withResolvers<void>();
  const sinkMap = createOwnedMap<string, ClientSink>();
  const agent = makeAgent({
    state: () => ({ count: 0 }),
    ...agentOverrides,
  } as Partial<AgentDef>);
  const { executeTool } = setupTools({
    agent,
    opts: { agent, env: {} },
    env: {},
    providerEnv: {},
    resolvedDb: undefined,
    logger: consoleLogger,
    sinkMap,
    stateMap: new Map<string, Record<string, unknown>>(),
  } as never);
  return { executeTool, sinkMap, release, parked };
}

const stateEvents = (events: ClientEvent[]): ClientEvent[] =>
  events.filter((e) => e.type === "agent_state");

describe("self-hosted tool surface: sends follow the live sink", () => {
  test("the syncState push after a mid-call reconnect reaches the new socket", async () => {
    const supersededEvents: ClientEvent[] = [];
    const resumedEvents: ClientEvent[] = [];
    const { executeTool, sinkMap, release, parked } = parkedToolRuntime({
      syncState: (s: { count: number }) => ({ count: s.count }),
      tools: {
        bump: {
          description: "bump the counter",
          execute: async (_args: unknown, ctx: { state: { count: number } }) => {
            await parked;
            ctx.state.count += 1;
            return "ok";
          },
        },
      },
    } as never);

    sinkMap.claim(SID, recordingSink(supersededEvents));
    const call = executeTool("bump", {}, SID, []);

    // The client reconnects with ?sessionId=<id> while the tool is still
    // running: runtime.createSession claims the same key for the new socket.
    sinkMap.claim(SID, recordingSink(resumedEvents));

    release();
    await call;

    expect(stateEvents(resumedEvents)).toEqual([{ type: "agent_state", state: { count: 1 } }]);
    // The superseded socket is gone; a push to it is silently lost AND marks
    // the projection as delivered, so the resumed client would never see it.
    expect(stateEvents(supersededEvents)).toEqual([]);
  });

  test("ctx.send after a mid-call reconnect reaches the new socket", async () => {
    const supersededEvents: ClientEvent[] = [];
    const resumedEvents: ClientEvent[] = [];
    const { executeTool, sinkMap, release, parked } = parkedToolRuntime({
      tools: {
        ping: {
          description: "emit a custom event",
          execute: async (_args: unknown, ctx: { send: (e: string, d: unknown) => void }) => {
            await parked;
            ctx.send("progress", { done: true });
            return "ok";
          },
        },
      },
    } as never);

    sinkMap.claim(SID, recordingSink(supersededEvents));
    const call = executeTool("ping", {}, SID, []);
    sinkMap.claim(SID, recordingSink(resumedEvents));

    release();
    await call;

    expect(resumedEvents).toEqual([
      { type: "custom_event", event: "progress", data: { done: true } },
    ]);
    expect(supersededEvents).toEqual([]);
  });

  test("without a reconnect the session's own sink still receives both", async () => {
    const events: ClientEvent[] = [];
    const { executeTool, sinkMap, release } = parkedToolRuntime({
      syncState: (s: { count: number }) => ({ count: s.count }),
      tools: {
        bump: {
          description: "bump the counter",
          execute: (_args: unknown, ctx: { state: { count: number }; send: unknown }) => {
            ctx.state.count += 1;
            (ctx.send as (e: string, d: unknown) => void)("progress", 1);
            return "ok";
          },
        },
      },
    } as never);
    release();

    sinkMap.claim(SID, recordingSink(events));
    await executeTool("bump", {}, SID, []);

    expect(events).toEqual([
      { type: "custom_event", event: "progress", data: 1 },
      { type: "agent_state", state: { count: 1 } },
    ]);
  });
});

/**
 * `onToolCall` is what session analytics reads, and it exists because `ok`
 * cannot be recovered above this layer: `ExecuteTool` returns a string, so an
 * observer wrapped around it has to re-parse `toolError`'s wire format — a
 * second copy of that format, in a place nothing exercises on the day it
 * changes, whose failure mode is scoring every failed tool call as a success.
 */
describe("self-hosted tool surface: settled tool calls are reported", () => {
  function toolRuntime(tools: Record<string, unknown>) {
    const onToolCall = vi.fn();
    const agent = makeAgent({ tools } as Partial<AgentDef>);
    const { executeTool } = setupTools({
      agent,
      opts: { agent, env: {} },
      env: {},
      providerEnv: {},
      resolvedDb: undefined,
      logger: consoleLogger,
      sinkMap: createOwnedMap<string, ClientSink>(),
      stateMap: new Map<string, Record<string, unknown>>(),
      onToolCall,
    } as never);
    return { executeTool, onToolCall };
  }

  test("carries the session, the name and a true outcome for a plain result", async () => {
    const { executeTool, onToolCall } = toolRuntime({
      lookup: { description: "look something up", execute: () => "found it" },
    });
    await executeTool("lookup", {}, SID, []);
    expect(onToolCall).toHaveBeenCalledTimes(1);
    expect(onToolCall.mock.calls[0]?.[0]).toMatchObject({
      sessionId: SID,
      name: "lookup",
      ok: true,
      result: "found it",
    });
  });

  test("a tool that RETURNS a failure is reported as one, not as a result", async () => {
    const { executeTool, onToolCall } = toolRuntime({
      lookup: { description: "look something up", execute: () => ({ error: "no such order" }) },
    });
    await executeTool("lookup", {}, SID, []);
    expect(onToolCall.mock.calls[0]?.[0]).toMatchObject({ name: "lookup", ok: false });
  });

  // A hallucinated tool name never reaches the executor, and is invisible
  // everywhere else — it is exactly what this table gets read for.
  test("an unknown tool is reported rather than answered silently", async () => {
    const { executeTool, onToolCall } = toolRuntime({});
    await executeTool("no_such_tool", {}, SID, []);
    expect(onToolCall.mock.calls[0]?.[0]).toMatchObject({ name: "no_such_tool", ok: false });
  });
});
