// Copyright 2026 the AAI authors. MIT license.
/**
 * A SELF-HOSTED agent's conversation survives a PROCESS RESTART, over a real
 * Postgres.
 *
 * This is the gap `session-resume-state.scenario.test.ts` names and declines:
 * "surviving a PROCESS restart — out of scope for this file, not out of reach.
 * The runtime here is built with no `db`, so its session-state store runs the
 * MEMORY backend, and every connection above is served by one process, so there
 * is no restart for these four specs to be run against." This file is that
 * restart, and it is the configuration nothing else covers.
 *
 * ## What each neighbouring suite proves, and why none of them is this
 *
 * - `aai-server/session-state.scenario.test.ts` — "a session's EVENT log
 *   survives a new process, at its own indices". That is the STORE and the
 *   STREAM: append, flush, a second stream, hydrate, read. It stops at the
 *   events, and says nothing about them becoming a CONVERSATION.
 * - `session-core-history.test.ts` — `restoreHistory` appends to the model's
 *   copy. That is the far end, against an in-memory core, with nothing durable
 *   under it.
 * - `session-resume.scenario.test.ts` / `-state` — a really-severed socket
 *   landing on the same session, in ONE process, on the memory backend.
 *
 * So the link with no coverage was the middle of the chain, end to end and
 * through the door a self-hoster actually uses: a completed turn's events
 * FLUSHED to Postgres, the process that wrote them GONE, and a reconnect on a
 * new process turning those rows back into the history the agent's own tools
 * see. `historyFromEvents` → `core.restoreHistory` is what runs there
 * (`runtime-session-stream.ts`), and until now nothing exercised it over a real
 * database at all.
 *
 * ## Why `createAgentServer` specifically
 *
 * Every other session suite in this package builds `createServer` directly. This
 * one goes through `createAgentServer`, which is the SELF-HOSTED front door — the
 * one the scaffold's `server.mjs` calls and the only one that reads
 * `DATABASE_URL` out of an agent's own env into `providerEnv`. That mattered
 * more than it looks: the sibling door was found to configure no workflow world
 * at all, so `aai dev` and the guest ran durable workflows and a self-hosted
 * server silently did not. Asserting durability through the door rather than
 * under it is what makes this a claim about self-hosting.
 *
 * ## What is faked, and what that costs
 *
 * The S2S transport, through the same `_internals.connectS2s` seam
 * `session-resume-state.scenario.test.ts` uses: a real provider socket would mean
 * credentials, and the audio path is not what a restart threatens. Everything
 * below the transport is real — a real `createAgentServer`, a real WebSocket
 * upgrade, a real Postgres, a real second process's worth of fresh in-memory
 * state, and the real flush that `reply.completed` triggers.
 *
 * The one thing genuinely out of reach is an ABRUPT death. `server.close()`
 * unwinds, and session stop is itself a flush point — so an orderly restart here
 * loses nothing, including a turn that never completed, which the last case pins.
 * The "a crash loses at most the events since the last flush" bound in
 * `session-event-stream.ts` is about a process that dies WITHOUT unwinding, and
 * producing one needs a real subprocess to kill (`aai-cli`'s e2e tier). Do not
 * read the last case as evidence about a crash.
 */

import { tool } from "@alexkroman1/aai";
import { sleep } from "@alexkroman1/aai/host-internal";
import { assemblyAIS2s } from "@alexkroman1/aai/s2s";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { WebSocket } from "ws";
import { describeWithPg, pgUrl } from "./_pg-test-utils.ts";
import { makeMockHandle, silentLogger } from "./_test-utils.ts";
import { createAgentServer } from "./agent-server.ts";
import type { S2sCallbacks } from "./s2s.ts";
import { ensureSessionStateSchema } from "./session-state-postgres.ts";
import { _internals as s2sTransportInternals } from "./transports/s2s-transport.ts";

type Frame = { type: string; sessionId?: string; result?: string };

/** One "process": a self-hosted server, its port, and its captured transport. */
type Process = {
  port: number;
  /**
   * The captured transport callbacks, AWAITED.
   *
   * Not a plain getter, and the difference is a real race rather than caution.
   * `session.configured` reaches the client BEFORE the transport has connected,
   * and on this suite's Postgres backend the session-state hydrate sits between
   * the two — so a synchronous read right after that frame finds nothing, which
   * is exactly how this file first failed. `session-resume-state.scenario.test.ts`
   * gets away with a getter only because its memory backend puts no round trip in
   * that gap; a durable one does, which makes this the honest spelling.
   */
  callbacks: () => Promise<S2sCallbacks>;
  close: () => Promise<void>;
};

const running: Process[] = [];

afterEach(async () => {
  // In reverse, so a test that left two up closes the newer one first.
  for (const proc of running.splice(0).reverse()) await proc.close();
});

describeWithPg("a self-hosted agent's conversation across a process restart", () => {
  // The tables come with whoever OWNS the database, and a self-hosted agent has no
  // migration step to hang them off — so `server.mjs` calls this before the
  // runtime opens a pool, and so does this suite. In a HOOK rather than at the top
  // of this body: vitest executes a skipped `describe` callback to enumerate it,
  // and `pgUrl()` there would fail the file instead of skipping it.
  beforeAll(async () => {
    await ensureSessionStateSchema({ url: pgUrl(), logger: silentLogger });
  });

  /**
   * Boot one self-hosted server against the shared database.
   *
   * Called TWICE per test, and the second call is the whole mechanism: a new
   * `createAgentServer` means a new runtime, a new session-state store, a new
   * event stream and a new empty `Map` of live sessions — everything the first
   * process held in memory is gone, and only the Postgres rows are shared. That
   * is as close to a restart as one test process can get, and it is the same
   * standin `aai-server/session-state.scenario.test.ts` calls "a new process".
   */
  async function boot(): Promise<Process> {
    let captured: S2sCallbacks | undefined;
    const handle = makeMockHandle();
    // `restoreMocks` puts this back between tests, so process 2 installs its own.
    vi.spyOn(s2sTransportInternals, "connectS2s").mockImplementation(async (opts) => {
      captured = opts.callbacks;
      return handle;
    });

    // Exactly what the scaffold's `server.mjs` assembles: `DATABASE_URL` in the
    // agent's OWN env, and `providerEnv` derived from it — which is what puts the
    // session-state store on the Postgres backend rather than the memory one.
    const env = { ASSEMBLYAI_API_KEY: "not-dialled", DATABASE_URL: pgUrl() };
    const server = createAgentServer({
      agent: {
        name: "restart-probe",
        greeting: "Hello there.",
        systemPrompt: "You are a probe.",
        s2s: assemblyAIS2s(),
        maxSteps: 4,
        toolChoice: "auto",
        tools: {
          // The observation seam, and it is the AGENT'S OWN view rather than a
          // side channel: `ctx.messages` is the snapshot handed to every tool,
          // which is the same copy the model reasons over. A restored history
          // that reached some store but not here would be durable and useless.
          read_history: tool({
            description: "Report the conversation so far.",
            execute: (_args, ctx) => ({
              said: ctx.messages.map((m) => `${m.role}: ${String(m.content)}`),
            }),
          }),
        },
      },
      env,
      providerEnv: env,
      logger: silentLogger,
    });
    await server.listen(0, "127.0.0.1");
    const port = server.port;
    if (port === undefined) throw new Error("server did not report a port");
    const proc: Process = {
      port,
      callbacks: async () => {
        const deadline = Date.now() + 5000;
        while (!captured) {
          if (Date.now() > deadline) {
            throw new Error("connectS2s never fired in 5000ms — no session started");
          }
          await sleep(20);
        }
        return captured;
      },
      close: () => server.close(),
    };
    running.push(proc);
    return proc;
  }

  type Client = {
    ws: WebSocket;
    waitFor: (type: string, opts?: { count?: number; ms?: number }) => Promise<Frame>;
  };

  async function connect(port: number, query = ""): Promise<Client> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/websocket${query}`);
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
      // Cumulative recorder, so `count` is what makes a second wait assert about
      // the action that preceded it — see the same helper's doc in
      // `session-resume-state.scenario.test.ts`.
      waitFor: async (type, { count = 1, ms = 5000 } = {}) => {
        const deadline = Date.now() + ms;
        for (;;) {
          const nth = frames.filter((f) => f.type === type)[count - 1];
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
    };
  }

  /**
   * Drive one COMPLETE turn: the caller speaks, the agent answers, the reply ends.
   *
   * `onReplyDone` is the load-bearing call rather than ceremony — `reply.completed`
   * is in `FLUSH_AFTER`, so it is what writes the batch to Postgres. A turn left
   * open is exactly the case the last test covers.
   */
  async function turn(proc: Process, said: string, answered: string): Promise<void> {
    const cb = await proc.callbacks();
    cb.onUserTranscript(said);
    cb.onReplyStarted(`reply-${said.slice(0, 8)}`);
    cb.onAgentTranscript(answered, false);
    cb.onReplyDone();
    // The flush is fire-and-forget by design (`void flush(sessionId)`), so give it
    // the turn. Without this the assertion could read a batch still in memory —
    // which would pass in one process and prove nothing about the next.
    await sleep(250);
  }

  /**
   * The tool's own report of `ctx.messages`, driven through a reply.
   *
   * `tool.completed` carries its `result` as a serialized STRING (capped at
   * `MAX_TOOL_RESULT_CHARS`) — it is the wire's shape, not a convenience, since
   * what the model receives is text.
   */
  async function readHistory(proc: Process, client: Client, callId: string): Promise<string[]> {
    const cb = await proc.callbacks();
    cb.onReplyStarted(`reply-${callId}`);
    // A tool call outside an open reply is refused by the transport, which is why
    // the framing is here.
    cb.onToolCall(callId, "read_history", {});
    const frame = await client.waitFor("tool.completed");
    cb.onReplyDone();
    const parsed = JSON.parse(frame.result ?? "{}") as { said?: string[] };
    return parsed.said ?? [];
  }

  test("a completed turn's history survives the process that recorded it", async () => {
    const first = await boot();
    const before = await connect(first.port);
    const { sessionId } = await before.waitFor("session.configured");
    expect(sessionId).toBeTruthy();

    await turn(first, "my order is 4471", "Found it.");
    // Sanity, IN process 1: the tool sees the turn it just had. Without this the
    // test could pass by the history being empty at both ends.
    expect(await readHistory(first, before, "call-live")).toEqual(
      expect.arrayContaining([expect.stringContaining("4471")]),
    );

    // The restart. `close()` shuts the runtime down too, so the store, the stream
    // and every live session go with it.
    before.ws.close();
    await first.close();

    const second = await boot();
    const after = await connect(second.port, `?sessionId=${sessionId}`);
    expect((await after.waitFor("session.configured")).sessionId).toBe(sessionId);
    // The resume's own announcement — `findings.record()` fires only when there
    // was something to restore, so this frame IS "the log was not empty". The
    // negative case below asserts its absence.
    await after.waitFor("history.restored");

    // The claim: a process that never saw this conversation hands the agent's own
    // tool the turn the previous process recorded.
    const restored = await readHistory(second, after, "call-restored");
    expect(restored).toEqual(
      expect.arrayContaining([
        expect.stringContaining("my order is 4471"),
        expect.stringContaining("Found it."),
      ]),
    );
    after.ws.close();
  });

  test("a DIFFERENT session id on the new process restores nothing", async () => {
    // The negative that makes the positive mean something: a resume reads the log
    // of the session it NAMES. Without this, a bug that restored every row in the
    // table for any id would pass the test above.
    const first = await boot();
    const before = await connect(first.port);
    const { sessionId } = await before.waitFor("session.configured");
    await turn(first, "my order is 4471", "Found it.");
    before.ws.close();
    await first.close();

    const second = await boot();
    const stranger = await connect(second.port, `?sessionId=${sessionId}-not-mine`);
    await stranger.waitFor("session.configured");
    const restored = await readHistory(second, stranger, "call-stranger");
    expect(restored.join(" ")).not.toContain("4471");
    stranger.ws.close();
  });

  test("a GRACEFUL shutdown flushes even an unfinished turn", async () => {
    // The turn boundary is not the only flush point — session STOP is one too
    // (`FLUSH_AFTER` plus the `finally` in `attachSessionStream`, which exists so
    // "a session that stopped by failing still writes out what it recorded"). So
    // an orderly restart loses nothing at all, including a reply that never
    // completed.
    //
    // This case was written the other way round first, asserting that the
    // unfinished turn was LOST, and it failed — correctly. That is worth recording
    // rather than quietly inverting: the "a crash loses at most the events since
    // the last flush" bound in `session-event-stream.ts` is about an ABRUPT death,
    // and `server.close()` is the opposite of one. Nothing in this tier can
    // produce the abrupt case — killing a process without unwinding it needs a
    // real subprocess, which is `aai-cli`'s e2e tier — so the honest thing to pin
    // here is the guarantee a graceful restart actually gives.
    const first = await boot();
    const before = await connect(first.port);
    const { sessionId } = await before.waitFor("session.configured");

    // A completed turn, then one left open: spoken, replied to, never done.
    await turn(first, "first question", "First answer.");
    const cb = await first.callbacks();
    cb.onUserTranscript("second question about 4471");
    cb.onReplyStarted("reply-open");
    cb.onAgentTranscript("Second answer.", false);
    await sleep(250);

    before.ws.close();
    await first.close();

    const second = await boot();
    const after = await connect(second.port, `?sessionId=${sessionId}`);
    await after.waitFor("session.configured");
    await after.waitFor("history.restored");
    const restored = (await readHistory(second, after, "call-partial")).join(" ");

    expect(restored).toContain("first question");
    // The unfinished turn too — what the stop flushed.
    expect(restored).toContain("4471");
    after.ws.close();
  });
});
