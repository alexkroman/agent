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
import { createOwnedMap, type OwnedMap } from "../sdk/owned-map.ts";
import type { ClientSink, SessionEvent } from "../sdk/protocol.ts";
import { sessionSlot } from "../sdk/session-slot.ts";
import type { AgentDef } from "../sdk/types.ts";
import { makeAgent } from "./_test-utils.ts";
import { consoleLogger } from "./runtime-config.ts";
import { setupTools } from "./runtime-tools.ts";
import { createSessionEmitter, type SessionEmitter } from "./session-emitter.ts";
import { createSessionEventStream } from "./session-event-stream.ts";
import { createMemoryStateBackend, createSessionStateStore } from "./session-state-store.ts";

/** The counter these cases bump — declared once, so both sinks project the same slot. */
const countSlot = sessionSlot("count", () => ({ count: 0 }));

const SID = "session-1";

function recordingSink(events: SessionEvent[]): ClientSink {
  return {
    open: true,
    event: (e: SessionEvent) => events.push(e),
    playAudioChunk: () => undefined,
  } as unknown as ClientSink;
}

/**
 * Claim one connection's emitter under `SID`, recording what its client sees.
 *
 * The map holds EMITTERS rather than sinks now, because `ctx.send` and a
 * `syncState` push are recorded in the session's event stream and seen by its
 * hooks like any other event. The resume race these cases are about is unchanged:
 * a claim replaces the previous one under the same id.
 */
function claimConnection(emitters: OwnedMap<string, SessionEmitter>, events: SessionEvent[]): void {
  const client = recordingSink(events);
  emitters.claim(
    SID,
    createSessionEmitter({
      sessionId: SID,
      client,
      stream: createSessionEventStream({ backend: createMemoryStateBackend() }),
    }),
  );
}

/**
 * A self-hosted tool surface whose single tool parks until released, so a
 * reconnect can land mid-call.
 */
function parkedToolRuntime(agentOverrides: Partial<AgentDef>) {
  const { promise: parked, resolve: release } = Promise.withResolvers<void>();
  const emitters = createOwnedMap<string, SessionEmitter>();
  const agent = makeAgent({ ...agentOverrides } as Partial<AgentDef>);
  const { executeTool } = setupTools({
    agent,
    opts: { agent, env: {} },
    env: {},
    providerEnv: {},
    resolvedDb: undefined,
    logger: consoleLogger,
    emitters,
    stateStore: createSessionStateStore({ backend: createMemoryStateBackend() }),
  } as never);
  return { executeTool, emitters, release, parked };
}

/**
 * The state pushes among `events`, with the envelope dropped.
 *
 * Every event carries a `meta` now, and these cases are about WHICH SOCKET saw
 * a push — so the id and timestamp are noise here. Read `meta` where it is the
 * subject (`session-event-stream.test.ts`), not here.
 */
const stateEvents = (events: SessionEvent[]): unknown[] =>
  events.filter((e) => e.type === "state.updated").map(({ meta: _meta, ...body }) => body);

/** The same, for `ctx.send`'s custom events. */
const customEvents = (events: SessionEvent[]): unknown[] =>
  events.filter((e) => e.type === "custom.emitted").map(({ meta: _meta, ...body }) => body);

describe("self-hosted tool surface: sends follow the live sink", () => {
  test("the syncState push after a mid-call reconnect reaches the new socket", async () => {
    const supersededEvents: SessionEvent[] = [];
    const resumedEvents: SessionEvent[] = [];
    const { executeTool, emitters, release, parked } = parkedToolRuntime({
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

    claimConnection(emitters, supersededEvents);
    const call = executeTool("bump", {}, SID, []);

    // The client reconnects with ?sessionId=<id> while the tool is still
    // running: runtime.createSession claims the same key for the new socket.
    claimConnection(emitters, resumedEvents);

    release();
    await call;

    expect(stateEvents(resumedEvents)).toEqual([{ type: "state.updated", state: { count: 1 } }]);
    // The superseded socket is gone; a push to it is silently lost AND marks
    // the projection as delivered, so the resumed client would never see it.
    expect(stateEvents(supersededEvents)).toEqual([]);
  });

  test("ctx.send after a mid-call reconnect reaches the new socket", async () => {
    const supersededEvents: SessionEvent[] = [];
    const resumedEvents: SessionEvent[] = [];
    const { executeTool, emitters, release, parked } = parkedToolRuntime({
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

    claimConnection(emitters, supersededEvents);
    const call = executeTool("ping", {}, SID, []);
    claimConnection(emitters, resumedEvents);

    release();
    await call;

    expect(customEvents(resumedEvents)).toEqual([
      { type: "custom.emitted", event: "progress", data: { done: true } },
    ]);
    expect(supersededEvents).toEqual([]);
  });

  test("without a reconnect the session's own sink still receives both", async () => {
    const events: SessionEvent[] = [];
    const { executeTool, emitters, release } = parkedToolRuntime({
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

    claimConnection(emitters, events);
    await executeTool("bump", {}, SID, []);

    // BOTH, in order: `ctx.send` fires inside the tool, the state push after it.
    expect(events.map(({ meta: _meta, ...body }) => body)).toEqual([
      { type: "custom.emitted", event: "progress", data: 1 },
      { type: "state.updated", state: { count: 1 } },
    ]);
  });
});
