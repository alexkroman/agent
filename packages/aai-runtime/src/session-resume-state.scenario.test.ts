// Copyright 2026 the AAI authors. MIT license.
/**
 * A `sessionSlot`'s value survives a severed connection — the REAL runtime, over
 * a real socket that is really cut.
 *
 * This exists because the two halves of the resume contract were each covered
 * and never together. `ws-handler-resume.test.ts` drives the real machinery
 * (id reuse, a delayed stop not evicting a resumed session, the superseded-session
 * eviction) against a MOCKED socket; `session-resume.scenario.test.ts` drives a
 * really-severed socket against a FAKE runtime. A defect needing both to be real
 * would slip through both, so this is the configuration neither covers: a real
 * `createRuntime`, a real `createRuntimeServer`, a real WebSocket, and
 * `_fault-socket.ts` destroying it.
 *
 * What it pins is `pushStateSnapshot(sessionId, emitter)` — wired in by
 * `runtime.ts`'s `createSession` and called by `attachSessionState`
 * (`runtime-session-state.ts`) once the session's slots have hydrated: the
 * surviving state pushed to a socket that has never seen it.
 * Without that line a resumed client renders EMPTY until some later tool call
 * happens to change something, which it may never do — verified by disabling it,
 * which fails three of these four specs and correctly leaves the negative one
 * green.
 *
 * It does NOT pin the other two things `createSession` does for a resume, and the
 * distinction is worth keeping straight:
 *
 * - `sessionState.sweeps.cancel(id)` is unreachable from here. The sweep fires
 *   `SESSION_RESUME_GRACE_MS` (120s) after the old session stops, so a test that
 *   reconnects in 50ms passes whether or not the cancel happens. Its coverage is
 *   `runtime-lifecycle.test.ts`'s two grace-window specs, on fake timers.
 * - `sinkMap.claim(id, client)` is exercised incidentally — the snapshot arrives
 *   on the new socket, so the claim worked — but the ownership hazard it exists
 *   for (an old session's late `stop()` evicting the resumed session's entry) is
 *   `ws-handler-resume.test.ts`'s, which can schedule that race deterministically.
 *
 * The transport is the one thing faked, through the seam `createFixtureSession`
 * uses (`_internals.connectS2s`): a real S2S session would mean credentials and a
 * live provider socket, and the tool call only has to HAPPEN — what is under test
 * is what becomes of its state when the connection dies.
 *
 * Still out of scope: surviving a PROCESS restart — out of scope for this file,
 * not out of reach. The runtime here is built with no `db`, so its session-state
 * store runs the MEMORY backend (`session-state-store.ts`), and every connection
 * above is served by one process, so there is no restart for these four specs to
 * be run against. The store's Postgres backend is the durable tier and it really
 * does carry a slot's value across processes:
 * `aai-server/session-state.scenario.test.ts` proves it against a real database,
 * starting with the case named "a slot's value survives a new process". This
 * file is silent on that half rather than evidence against it.
 */

import { sessionSlot, tool } from "@alexkroman1/aai";
import { sleep } from "@alexkroman1/aai/internal";
import { assemblyAIS2s } from "@alexkroman1/aai/s2s";
import { afterEach, describe, expect, test, vi } from "vitest";
import { WebSocket } from "ws";
import { z } from "zod";
import { createSeveringProxy, type SeveringProxy } from "./_fault-socket.ts";
import { makeMockHandle, silentLogger } from "./_test-utils.ts";
import { createRuntime } from "./runtime.ts";
import type { S2sCallbacks } from "./s2s.ts";
import { createRuntimeServer } from "./server.ts";
import { _internals as s2sTransportInternals } from "./transports/s2s-transport.ts";

/** The agent's state, and what its `syncState` projection puts on the wire. */
type ProbeState = { items: string[] };

/** The slot the probe agent keeps its list in — the thing a resume has to find. */
const probeSlot = sessionSlot("probe", (): ProbeState => ({ items: [] }));

type Frame = { type: string; sessionId?: string; state?: ProbeState };

type Harness = {
  proxy: SeveringProxy;
  /** The captured S2S callbacks of the most recent session start. */
  callbacks: () => S2sCallbacks;
  close: () => Promise<void>;
};

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

async function serve(): Promise<Harness> {
  const handle = makeMockHandle();
  let captured: S2sCallbacks | undefined;
  // The same seam `createFixtureSession` uses. `restoreMocks` puts it back.
  vi.spyOn(s2sTransportInternals, "connectS2s").mockImplementation(async (opts) => {
    captured = opts.callbacks;
    return handle;
  });

  const runtime = createRuntime({
    agent: {
      name: "resume-probe",
      greeting: "Hello there.",
      systemPrompt: "You are a probe.",
      s2s: assemblyAIS2s(),
      maxSteps: 4,
      toolChoice: "auto",
      // The projection carries the slot's own default, so there is nothing to
      // declare for `pushStateSnapshot` to have something to project on a resume.
      syncState: probeSlot.projection((state) => ({ items: state.items })),
      tools: {
        add_item: tool({
          description: "Add an item to the list.",
          // The schema is load-bearing, not decoration: without one the executor
          // handed `execute` no arguments at all, so the first version of this
          // test pushed the string "undefined" and still passed every assertion
          // about state SURVIVING — the shape of a test that measures the right
          // thing about the wrong value.
          inputSchema: z.object({ item: z.string() }),
          execute: (args, ctx) =>
            probeSlot.update(ctx, (state) => {
              state.items.push(args.item);
              return `added ${args.item}`;
            }),
        }),
      },
    },
    // Never dialled: the transport is the spy above.
    env: { ASSEMBLYAI_API_KEY: "not-dialled" },
    logger: silentLogger,
  });

  const server = createRuntimeServer({ runtime, logger: silentLogger });
  await server.listen(0, "127.0.0.1");
  const target = server.port;
  if (target === undefined) throw new Error("server did not report a port");
  const proxy = await createSeveringProxy({ target });

  return {
    proxy,
    callbacks: () => {
      if (!captured) throw new Error("connectS2s never fired — no session started");
      return captured;
    },
    close: async () => {
      await proxy.close();
      await runtime.shutdown();
      await server.close();
    },
  };
}

/** A client that records every frame, so an assertion can look for one. */
type Client = {
  ws: WebSocket;
  frames: Frame[];
  /**
   * Wait until `count` frames of `type` have arrived, resolving with the last
   * one; reject on timeout.
   *
   * `count` exists because the recorder is CUMULATIVE — every frame this socket
   * ever received stays in `frames`. A bare "first frame of this type" scan
   * therefore returns a frame the test already consumed, so a second call after
   * an action asserts nothing about that action. That is exactly what happened
   * in "state ACCUMULATES across the drop": the second wait returned the resume
   * SNAPSHOT, and the only thing making the post-drop update arrive in time was
   * a hard-coded `sleep(100)` inside `addItem`.
   */
  waitFor: (type: string, opts?: { count?: number; ms?: number }) => Promise<Frame>;
  /** Resolve once the socket closes, with its code. */
  closed: () => Promise<number>;
};

async function connect(proxy: SeveringProxy, query = ""): Promise<Client> {
  const ws = new WebSocket(`ws://127.0.0.1:${proxy.port}/websocket${query}`);
  const frames: Frame[] = [];
  ws.on("message", (data: Buffer) => {
    try {
      frames.push(JSON.parse(data.toString("utf8")) as Frame);
    } catch {
      // Binary audio: not what any assertion here reads.
    }
  });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  return {
    ws,
    frames,
    waitFor: async (type, { count = 1, ms = 5000 } = {}) => {
      const deadline = Date.now() + ms;
      for (;;) {
        const seen = frames.filter((frame) => frame.type === type);
        const nth = seen[count - 1];
        if (nth) return nth;
        if (Date.now() > deadline) {
          throw new Error(
            `fewer than ${count} "${type}" frame(s) in ${ms}ms; saw [${frames
              .map((f) => f.type)
              .join(", ")}]`,
          );
        }
        await sleep(20);
      }
    },
    closed: () =>
      new Promise((resolve) => {
        if (ws.readyState === WebSocket.CLOSED) resolve(1006);
        else ws.once("close", (code: number) => resolve(code));
      }),
  };
}

/**
 * Drive one tool call through the captured transport callbacks.
 *
 * The reply framing is REQUIRED, not ceremony: the transport refuses a tool call
 * that arrives outside an open reply (`tool_call with no active reply`), so a
 * bare `onToolCall` announces the call to the client and executes nothing — which
 * presents exactly as this test's first failure did, a `tool_call` frame with no
 * `tool_result` and no state ever syncing.
 */
async function addItem(h: Harness, item: string, callId: string): Promise<void> {
  const callbacks = h.callbacks();
  callbacks.onReplyStarted(`reply-${callId}`);
  callbacks.onToolCall(callId, "add_item", { item });
  // The executor is async and syncs state in its own tail; give it the turn.
  await sleep(100);
  callbacks.onReplyDone();
}

describe("a sessionSlot's value across a severed connection (real runtime)", () => {
  test("state written before the drop is PUSHED to the resumed socket", async () => {
    harness = await serve();
    const first = await connect(harness.proxy);
    const config = await first.waitFor("session.configured");
    const sessionId = config.sessionId;
    expect(sessionId).toBeTruthy();

    await addItem(harness, "widget", "call-1");
    const beforeDrop = await first.waitFor("state.updated");
    expect(beforeDrop.state).toEqual({ items: ["widget"] });

    const closed = first.closed();
    harness.proxy.severAll();
    await expect(closed).resolves.toBe(1006);

    // The reconnect. `pushStateSnapshot` is what has to fire here: the new socket
    // has never seen this state, and no further tool call is made.
    const second = await connect(harness.proxy, `?sessionId=${sessionId}`);
    const resumed = await second.waitFor("state.updated");
    expect(resumed.state).toEqual({ items: ["widget"] });
    const resumedConfig = await second.waitFor("session.configured");
    expect(resumedConfig.sessionId).toBe(sessionId);
    second.ws.close();
  });

  test("state ACCUMULATES across the drop rather than restarting", async () => {
    // The stronger claim: the resumed session mutates the SAME object, so a tool
    // call after the drop appends to what was there. A resume that pushed a
    // snapshot but then handed the tools a fresh state would pass the test above
    // and fail this one.
    harness = await serve();
    const first = await connect(harness.proxy);
    const { sessionId } = await first.waitFor("session.configured");
    await addItem(harness, "first", "call-1");
    await first.waitFor("state.updated");

    const closed = first.closed();
    harness.proxy.severAll();
    await closed;

    const second = await connect(harness.proxy, `?sessionId=${sessionId}`);
    // The resume snapshot is the FIRST `state.updated` on this socket; the
    // append is the second. Waiting for the second is what makes the assertion
    // about the post-drop tool call rather than about the snapshot.
    await second.waitFor("state.updated");
    await addItem(harness, "second", "call-2");

    const after = await second.waitFor("state.updated", { count: 2 });
    expect(after.state).toEqual({ items: ["first", "second"] });
    second.ws.close();
  });

  test("a fresh connection gets NO state snapshot", async () => {
    // The negative half, and what makes the first test mean anything: a runtime
    // that pushed a snapshot unconditionally would pass it while leaking one
    // caller's state to the next.
    harness = await serve();
    const first = await connect(harness.proxy);
    await first.waitFor("session.configured");
    await addItem(harness, "widget", "call-1");
    await first.waitFor("state.updated");

    const closed = first.closed();
    harness.proxy.severAll();
    await closed;

    const second = await connect(harness.proxy);
    await second.waitFor("session.configured");
    // Long enough that a snapshot would have arrived if one were coming.
    await sleep(200);
    expect(second.frames.filter((frame) => frame.type === "state.updated")).toHaveLength(0);
    second.ws.close();
  });

  test("surviving three severs keeps one accumulating state", async () => {
    harness = await serve();
    let client = await connect(harness.proxy);
    const { sessionId } = await client.waitFor("session.configured");

    for (const [index, item] of ["one", "two", "three"].entries()) {
      await addItem(harness, item, `call-${index}`);
      await client.waitFor("state.updated");
      const closed = client.closed();
      harness.proxy.severAll();
      await closed;
      client = await connect(harness.proxy, `?sessionId=${sessionId}`);
    }

    const snapshot = await client.waitFor("state.updated");
    expect(snapshot.state).toEqual({ items: ["one", "two", "three"] });
    expect(harness.proxy.severed()).toBe(3);
    client.ws.close();
  });
});
