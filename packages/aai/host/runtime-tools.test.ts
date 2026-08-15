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

import { describe, expect, test } from "vitest";
import { createOwnedMap } from "../sdk/owned-map.ts";
import type { ClientEvent, ClientSink } from "../sdk/protocol.ts";
import { sessionSlot } from "../sdk/session-slot.ts";
import type { AgentDef } from "../sdk/types.ts";
import { makeAgent } from "./_test-utils.ts";
import { consoleLogger } from "./runtime-config.ts";
import { setupTools } from "./runtime-tools.ts";
import { createMemoryStateBackend, createSessionStateStore } from "./session-state-store.ts";

/** The counter these cases bump — declared once, so both sinks project the same slot. */
const countSlot = sessionSlot("count", () => ({ count: 0 }));

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
  const agent = makeAgent({ ...agentOverrides } as Partial<AgentDef>);
  const { executeTool } = setupTools({
    agent,
    opts: { agent, env: {} },
    env: {},
    providerEnv: {},
    resolvedDb: undefined,
    logger: consoleLogger,
    sinkMap,
    stateStore: createSessionStateStore({ backend: createMemoryStateBackend() }),
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
      syncState: countSlot.projection((s) => ({ count: s.count })),
      tools: {
        bump: {
          description: "bump the counter",
          execute: async (_args: unknown, ctx: never) => {
            await parked;
            countSlot.update(ctx, (state) => ++state.count);
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
      syncState: countSlot.projection((s) => ({ count: s.count })),
      tools: {
        bump: {
          description: "bump the counter",
          execute: (_args: unknown, ctx: never) => {
            countSlot.update(ctx, (state) => ++state.count);
            (ctx as { send: (e: string, d: unknown) => void }).send("progress", 1);
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
