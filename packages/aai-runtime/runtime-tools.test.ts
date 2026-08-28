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

import type { AgentDef, ToolContext } from "@alexkroman1/aai";
import { sessionSlot } from "@alexkroman1/aai";
import { createOwnedMap, type OwnedMap } from "@alexkroman1/aai/host-internal";
import { MAX_CLIENT_EVENT_PAYLOAD_BYTES } from "@alexkroman1/aai/internal";
import type { ClientSink, SessionEvent } from "@alexkroman1/aai/protocol";
import { describe, expect, test } from "vitest";
import { makeAgent } from "./_test-utils.ts";
import { consoleLogger, type Logger } from "./runtime-config.ts";
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
function parkedToolRuntime(agentOverrides: Partial<AgentDef>, logger: Logger = consoleLogger) {
  const { promise: parked, resolve: release } = Promise.withResolvers<void>();
  const emitters = createOwnedMap<string, SessionEmitter>();
  const agent = makeAgent(agentOverrides);
  // No `as never` on the deps: the two keys that were missing (`llm`,
  // `workflows`) are spelled here instead. A cast over the whole object is the
  // dropped-field class — it keeps compiling when `ToolSetupDeps` grows a
  // required member, and the tool surface then quietly loses it.
  const { executeTool } = setupTools({
    agent,
    opts: { agent, env: {} },
    llm: undefined,
    env: {},
    providerEnv: {},
    workflows: undefined,
    logger,
    emitters,
    stateStore: createSessionStateStore({ backend: createMemoryStateBackend() }),
  });
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
          execute: async (_args: unknown, ctx: ToolContext) => {
            await parked;
            countSlot.update(ctx, (state) => ++state.count);
            return "ok";
          },
        },
      },
    });

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
          execute: async (_args: unknown, ctx: ToolContext) => {
            await parked;
            ctx.send("progress", { done: true });
            return "ok";
          },
        },
      },
    });

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
          execute: (_args: unknown, ctx: ToolContext) => {
            countSlot.update(ctx, (state) => ++state.count);
            ctx.send("progress", 1);
            return "ok";
          },
        },
      },
    });
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

describe("ctx.send drops", () => {
  /** A logger that only remembers what it was warned about. */
  function capturingLogger(): { logger: Logger; warnings: string[] } {
    const warnings: string[] = [];
    return {
      warnings,
      logger: {
        ...consoleLogger,
        warn: (message: string) => warnings.push(message),
      },
    };
  }

  async function sendOne(event: string, data: unknown) {
    const events: SessionEvent[] = [];
    const { logger, warnings } = capturingLogger();
    const { executeTool, emitters, release } = parkedToolRuntime(
      {
        tools: {
          ping: {
            description: "emit a custom event",
            execute: (_args: unknown, ctx: ToolContext) => {
              // Never throws, whatever the payload: this runs on the tool's own
              // stack, and a throw would fail the call over a notification.
              ctx.send(event, data);
              return "ok";
            },
          },
        },
      },
      logger,
    );
    release();
    claimConnection(emitters, events);
    await executeTool("ping", {}, SID, []);
    return { emitted: customEvents(events), warnings };
  }

  test("an over-cap payload is dropped AND logged", async () => {
    // `ToolContext.send` has always documented "dropped (with a warning log)",
    // and this was the one drop with no log: nothing on the wire, nothing in
    // the log, so an author whose payload grew past the cap had no signal at
    // all — the failure this whole seam exists to make visible.
    const { emitted, warnings } = await sendOne("progress", {
      blob: "x".repeat(MAX_CLIENT_EVENT_PAYLOAD_BYTES),
    });
    expect(emitted).toEqual([]);
    expect(warnings).toEqual([expect.stringContaining("too-large")]);
    expect(warnings[0]).toContain('ctx.send("progress")');
  });

  test("an over-long event name is dropped AND logged", async () => {
    const { emitted, warnings } = await sendOne("e".repeat(500), 1);
    expect(emitted).toEqual([]);
    expect(warnings).toEqual([expect.stringContaining("name-too-long")]);
  });

  test("a payload with no JSON form is dropped AND logged", async () => {
    const { emitted, warnings } = await sendOne("progress", () => 1);
    expect(emitted).toEqual([]);
    expect(warnings).toEqual([expect.stringContaining("no-json-form")]);
  });

  test("a send inside the caps still lands, with no warning", async () => {
    const { emitted, warnings } = await sendOne("progress", { done: true });
    expect(emitted).toEqual([{ type: "custom.emitted", event: "progress", data: { done: true } }]);
    expect(warnings).toEqual([]);
  });
});

describe("a builtin shadowed by a tools/ file", () => {
  test("is announced, since the author declared it", async () => {
    // The file wins — that is the policy and it does not change. What was
    // missing is that nothing said so: `builtinTools: ["web_search"]` beside
    // `tools/web_search.ts` was simply inert, whether the author meant to
    // replace the builtin or collided with it by accident.
    const lines: string[] = [];
    const logger: Logger = { ...consoleLogger, info: (message: string) => lines.push(message) };
    const { executeTool, emitters, release } = parkedToolRuntime(
      {
        builtinTools: ["web_search"],
        tools: {
          web_search: {
            description: "my own search",
            execute: () => "mine",
          },
        },
      },
      logger,
    );
    release();
    const events: SessionEvent[] = [];
    claimConnection(emitters, events);
    // The agent's own tool is what runs.
    expect(await executeTool("web_search", {}, SID, [])).toContain("mine");
    expect(lines).toEqual([expect.stringContaining('builtinTools "web_search" is inert')]);
  });

  test("says nothing when no builtin is shadowed", async () => {
    const lines: string[] = [];
    const logger: Logger = { ...consoleLogger, info: (message: string) => lines.push(message) };
    const { release } = parkedToolRuntime({ builtinTools: ["web_search"] }, logger);
    release();
    expect(lines).toEqual([]);
  });
});
