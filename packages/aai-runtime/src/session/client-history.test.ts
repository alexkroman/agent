// Copyright 2026 the AAI authors. MIT license.

import type { SessionEventBody } from "@alexkroman1/aai";
import { stepClientTranscript } from "@alexkroman1/aai/step";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { makeLogger } from "../_logger-test-utils.ts";
import { createMemoryStateBackend, type SessionStateBackend } from "../session-state/store.ts";
import {
  bindClientSession,
  type ClientHistoryDeps,
  loadClientHistory,
  publishClientTranscripts,
  readClientTranscript,
} from "./client-history.ts";
import { historyFromEvents } from "./event-history.ts";
import { createSessionEventStream } from "./event-stream.ts";

const CLIENT = "kitchen";
const T0 = Date.UTC(2026, 0, 1);

let deps: ClientHistoryDeps;

beforeEach(() => {
  // Only the clock: both the bind and the event stamps read `Date.now()`, and
  // the ordering these cases assert is the ordering of those stamps.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  const backend = createMemoryStateBackend();
  deps = { backend, stream: createSessionEventStream({ backend }), logger: makeLogger() };
});
afterEach(() => vi.useRealTimers());

/** A session of `CLIENT`'s, bound at `at` and holding `bodies`, one ms apart. */
async function session(sessionId: string, at: number, bodies: SessionEventBody[]): Promise<void> {
  vi.setSystemTime(at);
  await bindClientSession(deps, sessionId, CLIENT);
  for (const [i, body] of bodies.entries()) {
    vi.setSystemTime(at + i + 1);
    deps.stream.append(sessionId, body);
  }
  await deps.stream.flush(sessionId);
}

const said = (text: string): SessionEventBody => ({ type: "userTranscript.committed", text });
const replied = (text: string): SessionEventBody => ({ type: "agentTranscript.committed", text });

describe("loadClientHistory", () => {
  test("the client's prior sessions, OLDEST first, never the session being started", async () => {
    await session("s1", T0, [said("set a timer"), replied("Done.")]);
    await session("s2", T0 + 1000, [said("and the weather?"), replied("Sunny.")]);
    await session("now", T0 + 2000, [said("this one is resuming")]);

    const events = await loadClientHistory(deps, { clientId: CLIENT, excludeSessionId: "now" });

    expect(historyFromEvents(events).messages.map((m) => m.content)).toEqual([
      "set a timer",
      "Done.",
      "and the weather?",
      "Sunny.",
    ]);
  });

  test("the budget is spent NEWEST first, and the session it runs out in keeps its END", async () => {
    await session("old", T0, [said("x".repeat(50))]);
    await session("mid", T0 + 1000, [said("aaaa"), said("bbbb"), said("cccc")]);
    await session("new", T0 + 2000, [said("dddd")]);

    const events = await loadClientHistory(deps, {
      clientId: CLIENT,
      excludeSessionId: "none",
      budgetChars: 12,
    });

    // 4 for "dddd", then 8 of `mid`'s 12 — its last two lines — and `old` never read.
    expect(historyFromEvents(events).messages.map((m) => m.content)).toEqual([
      "bbbb",
      "cccc",
      "dddd",
    ]);
  });

  test("`since` drops whole sessions whose last event is older, and older events of one straddling it", async () => {
    await session("stale", T0, [said("long ago")]);
    await session("straddle", T0 + 1000, [said("before"), said("after")]);

    const events = await loadClientHistory(deps, {
      clientId: CLIENT,
      excludeSessionId: "none",
      since: T0 + 1002,
    });

    expect(historyFromEvents(events).messages.map((m) => m.content)).toEqual(["after"]);
  });

  test("a backend with no client log answers nothing, which is the platform's case", async () => {
    const { bindClient: _b, clientSessions: _c, ...bare } = createMemoryStateBackend();
    const plain: SessionStateBackend = bare;
    const none = { ...deps, backend: plain };
    await bindClientSession(none, "s1", CLIENT);
    expect(await loadClientHistory(none, { clientId: CLIENT, excludeSessionId: "x" })).toEqual([]);
    expect(await readClientTranscript(none, CLIENT)).toEqual({ sessions: [] });
  });

  test("a failing read is a warning and answers what it had", async () => {
    const failing: SessionStateBackend = {
      ...createMemoryStateBackend(),
      clientSessions: () => Promise.reject(new Error("db down")),
    };
    const logger = makeLogger();
    const events = await loadClientHistory(
      { ...deps, backend: failing, logger },
      { clientId: CLIENT, excludeSessionId: "x" },
    );
    expect(events).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      "Client history not loaded",
      expect.objectContaining({ error: "db down" }),
    );
  });
});

describe("bindClientSession", () => {
  test("a failed bind is a warning, never a failed start", async () => {
    const logger = makeLogger();
    const failing: SessionStateBackend = {
      ...createMemoryStateBackend(),
      bindClient: () => Promise.reject(new Error("no table")),
    };
    await bindClientSession({ ...deps, backend: failing, logger }, "session-1", CLIENT);
    expect(logger.warn).toHaveBeenCalledWith(
      "Session not bound to its client",
      expect.objectContaining({ error: "no table" }),
    );
  });
});

describe("readClientTranscript", () => {
  beforeEach(async () => {
    await session("s1", T0, [
      said("what's the weather in Portland"),
      { type: "tool.called", toolCallId: "c1", toolName: "weather", args: { city: "Portland" } },
      { type: "tool.completed", toolCallId: "c1", result: '{"temp":12}' },
      replied("Twelve degrees."),
    ]);
    await session("s2", T0 + 1000, [said("thanks"), replied("Any time.")]);
  });

  test("sessions oldest first, as lines and settled tool calls with their arguments", async () => {
    const { sessions } = await readClientTranscript(deps, CLIENT);

    expect(sessions.map((s) => s.sessionId)).toEqual(["s1", "s2"]);
    expect(sessions[0]).toEqual({
      sessionId: "s1",
      startedAt: T0,
      lastEventIndex: 3,
      messages: [
        { role: "user", text: "what's the weather in Portland", at: T0 + 1 },
        { role: "assistant", text: "Twelve degrees.", at: T0 + 4 },
      ],
      tools: [{ name: "weather", args: { city: "Portland" }, result: '{"temp":12}', at: T0 + 3 }],
    });
  });

  test("a cursor reads only what came after it — the rest of its session, and every later one", async () => {
    const { sessions } = await readClientTranscript(deps, CLIENT, {
      afterEventIndex: { sessionId: "s1", index: 2 },
    });
    expect(sessions.map((s) => [s.sessionId, s.messages.map((m) => m.text)])).toEqual([
      ["s1", ["Twelve degrees."]],
      ["s2", ["thanks", "Any time."]],
    ]);
  });

  test("a cursor at a session's end leaves that session out, and an unknown cursor reads it all", async () => {
    const atEnd = await readClientTranscript(deps, CLIENT, {
      afterEventIndex: { sessionId: "s1", index: 3 },
    });
    expect(atEnd.sessions.map((s) => s.sessionId)).toEqual(["s2"]);
    const unknown = await readClientTranscript(deps, CLIENT, {
      afterEventIndex: { sessionId: "gone", index: 99 },
    });
    expect(unknown.sessions.map((s) => s.sessionId)).toEqual(["s1", "s2"]);
  });

  test("`since` filters events by when they were recorded", async () => {
    const { sessions } = await readClientTranscript(deps, CLIENT, { since: T0 + 1002 });
    expect(sessions.map((s) => [s.sessionId, s.messages.map((m) => m.text)])).toEqual([
      ["s2", ["Any time."]],
    ]);
  });
});

describe("publishClientTranscripts", () => {
  test("is what `stepClientTranscript` reads through, and only unpublishes its own", async () => {
    await session("s1", T0, [said("hello")]);
    const unpublishFirst = publishClientTranscripts(deps);
    const { sessions } = await stepClientTranscript(CLIENT);
    expect(sessions.map((s) => s.sessionId)).toEqual(["s1"]);

    // A second runtime publishes over it; disposing the first leaves the second.
    const other = createMemoryStateBackend();
    const unpublishSecond = publishClientTranscripts({
      backend: other,
      stream: createSessionEventStream({ backend: other }),
    });
    unpublishFirst();
    await expect(stepClientTranscript(CLIENT)).resolves.toEqual({ sessions: [] });
    unpublishSecond();
    await expect(stepClientTranscript(CLIENT)).rejects.toThrow(/no session log/);
  });
});
