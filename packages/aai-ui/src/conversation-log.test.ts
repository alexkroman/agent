// Copyright 2026 the AAI authors. MIT license.
/**
 * The persisted transcript's pure half: how a live, resumable session is
 * written into the log without logging a replay twice, how a mirrored inbox
 * frame becomes a row, and how a stored log is read back. Ported from the
 * device page that worked these rules out (`aai-device/agent/ui/history.ts`),
 * plus a property: however the live list grows, replays and pauses, the chain
 * holds exactly the latest conversation.
 */

import fc from "fast-check";
import { describe, expect, test } from "vitest";
import {
  appendEntry,
  type ConversationLogEntry,
  inboxEventToItem,
  logItem,
  parseLog,
  recordSession,
} from "./conversation-log.ts";
import type { ConversationItem } from "./use-conversation.ts";

const MAX = 300;
let nextId = 0;
const user = (content: string): ConversationItem => ({
  kind: "message",
  message: { id: nextId++, role: "user", content },
});
const agent = (content: string): ConversationItem => ({
  kind: "message",
  message: { id: nextId++, role: "assistant", content },
});
const tool = (name: string, status: "pending" | "done" = "pending"): ConversationItem => ({
  kind: "tool",
  toolCall: { callId: `c-${name}`, name, args: {}, status, seq: 0, afterMessageId: -1 },
});

const record = (log: readonly ConversationLogEntry[], items: ConversationItem[], at: number) =>
  recordSession(log, "s1", items, at, MAX);
const note = (log: readonly ConversationLogEntry[], text: string, at: number) =>
  appendEntry(log, { kind: "note", at, text }, MAX);

/** Each entry as text: a session's rows, or a note's line. */
const texts = (log: readonly ConversationLogEntry[]) =>
  log.map((e) =>
    e.kind === "session"
      ? e.items.map((it) => (it.kind === "message" ? it.message.content : it.toolCall.name))
      : e.text,
  );

describe("recordSession", () => {
  test("a session's conversation grows in its one entry", () => {
    let log = record([], [user("hi")], 1);
    log = record(log, [user("hi"), agent("hello")], 2);
    expect(texts(log)).toEqual([["hi", "hello"]]);
    expect(log[0]).toMatchObject({ kind: "session", sessionId: "s1", run: 0, at: 1 });
  });

  test("a resume replaying the history does not log it twice, and keeps the order", () => {
    let log = record([], [user("hi"), agent("hello")], 1);
    log = note(log, "Reminder: call the plumber", 2);
    // Reconnected with ?sessionId=s1: history.restored (fresh ids), then a new turn.
    log = record(log, [user("hi"), agent("hello")], 3);
    log = record(log, [user("hi"), agent("hello"), user("and now?")], 4);
    log = record(log, [user("hi"), agent("hello"), user("and now?"), agent("now this")], 5);
    expect(texts(log)).toEqual([
      ["hi", "hello"],
      "Reminder: call the plumber",
      ["and now?", "now this"],
    ]);
  });

  test("a tool call finishing early in a chain updates it where it is", () => {
    let log = record([], [tool("remind_me")], 1);
    log = note(log, "note", 2);
    log = record(log, [tool("remind_me", "done"), agent("Set.")], 3);
    expect(log[0]).toMatchObject({ items: [{ toolCall: { status: "done" } }] });
    expect(texts(log)).toEqual([["remind_me"], "note", ["Set."]]);
  });

  test("a session the server lost comes back greeting: a new run, not a swallowed replay", () => {
    const hi = agent("Hi, what can I do for you?");
    let log = record([], [hi, user("remind me at five"), agent("Done.")], 1);
    log = record(log, [hi, user("pancakes?")], 2);
    expect(texts(log)).toEqual([
      ["Hi, what can I do for you?", "remind me at five", "Done."],
      ["Hi, what can I do for you?", "pancakes?"],
    ]);
    expect(log.map((e) => (e.kind === "session" ? e.run : -1))).toEqual([0, 1]);
  });

  test("a partial replay mid-reconnect, or the same list again, returns the log itself", () => {
    const log = record([], [user("hi"), agent("hello")], 1);
    expect(record(log, [user("hi")], 2)).toBe(log);
    expect(record(log, [user("hi"), agent("hello")], 3)).toBe(log);
    expect(record(log, [], 4)).toBe(log);
  });

  test("tool results are not stored", () => {
    const withResult: ConversationItem = {
      kind: "tool",
      toolCall: {
        callId: "c",
        name: "search",
        args: {},
        status: "done",
        seq: 0,
        afterMessageId: -1,
        result: "x".repeat(10_000),
      },
    };
    const log = record([], [withResult], 1);
    expect(log[0]).toMatchObject({ items: [{ toolCall: { name: "search" } }] });
    expect(JSON.stringify(log)).not.toContain("xxxx");
    expect(logItem(user("a")).kind).toBe("message");
  });

  test("the client id is recorded, and the oldest entries go first past max", () => {
    const log = recordSession([], "s1", [user("hi")], 1, MAX, "browser-abc");
    expect(log[0]).toMatchObject({ clientId: "browser-abc" });
    let many: readonly ConversationLogEntry[] = [];
    for (let i = 0; i <= 5; i++)
      many = appendEntry(many, { kind: "note", at: i, text: `n${i}` }, 5);
    expect(texts(many)).toEqual(["n1", "n2", "n3", "n4", "n5"]);
  });

  type Op = { type: "turn"; text: string } | { type: "replay"; cut: number } | { type: "note" };
  type World = { log: readonly ConversationLogEntry[]; live: ConversationItem[] };
  /** One op applied: the live list as the session holds it, and the log it writes. */
  function step({ log, live }: World, o: Op, at: number): World {
    if (o.type === "note") return { log: note(log, "n", at), live };
    if (o.type === "turn") {
      const next = [...live, at % 2 ? user(`${o.text}#${at}`) : agent(`${o.text}#${at}`)];
      return { log: record(log, next, at), live: next };
    }
    const fresh = live.map((it) =>
      it.kind === "message" ? { ...it, message: { ...it.message, id: nextId++ } } : it,
    );
    const partial = record(log, fresh.slice(0, o.cut % (fresh.length + 1)), at);
    return { log: record(partial, fresh, at), live };
  }

  test("property: the chain always holds exactly the newest live list, in order", () => {
    // Ops over one session: a new turn, a replay (a reconnect that restores a
    // PREFIX of what was said, then all of it), or a note in between. Legal by
    // construction — a replay never invents turns.
    const op = fc.oneof(
      fc.record({ type: fc.constant("turn" as const), text: fc.string({ maxLength: 4 }) }),
      fc.record({ type: fc.constant("replay" as const), cut: fc.nat() }),
      fc.record({ type: fc.constant("note" as const) }),
    );
    fc.assert(
      fc.property(fc.array(op, { maxLength: 30 }), (ops) => {
        let world: World = { log: [], live: [] };
        ops.forEach((o, i) => {
          world = step(world, o, i + 1);
        });
        const { log, live } = world;
        const chain = log.flatMap((e) => (e.kind === "session" ? e.items : []));
        expect(chain.map((it) => (it.kind === "message" ? it.message.content : ""))).toEqual(
          live.map((it) => (it.kind === "message" ? it.message.content : "")),
        );
      }),
    );
  });
});

describe("inboxEventToItem", () => {
  const frame = (event: { type: string } & Record<string, unknown>) =>
    ({ type: "session_event", sessionId: "other", event }) as const;

  test("committed turns and tool calls are rows; the rest is not shown", () => {
    expect(inboxEventToItem(frame({ type: "user-transcript.committed", text: " hi " }), 3)).toEqual(
      {
        kind: "message",
        message: { id: 3, role: "user", content: "hi" },
      },
    );
    expect(
      inboxEventToItem(
        frame({ type: "tool.called", toolCallId: "t1", toolName: "web_search", args: { q: "x" } }),
      ),
    ).toMatchObject({
      kind: "tool",
      toolCall: { callId: "t1", name: "web_search", args: { q: "x" }, status: "pending" },
    });
    expect(
      inboxEventToItem(
        frame({ type: "agent-transcript.committed", text: "Sorry?", recovery: true }),
      ),
    ).toBeUndefined();
    expect(
      inboxEventToItem(frame({ type: "agent-transcript.committed", text: "  " })),
    ).toBeUndefined();
    expect(
      inboxEventToItem(frame({ type: "user-transcript.updated", text: "hal" })),
    ).toBeUndefined();
    expect(inboxEventToItem({ type: "session_ended", sessionId: "other" })).toBeUndefined();
  });
});

describe("parseLog", () => {
  test("round-trips a log, and drops what is malformed rather than throwing", () => {
    const log = note(record([], [user("hi"), tool("x", "done")], 1), "n", 2);
    expect(parseLog(JSON.stringify(log), MAX)).toEqual(log);
    expect(parseLog("{nope", MAX)).toEqual([]);
    expect(parseLog(undefined, MAX)).toEqual([]);
    expect(parseLog(JSON.stringify({ not: "an array" }), MAX)).toEqual([]);
    const junk = [
      { kind: "note", at: 1, text: "kept" },
      { kind: "note", text: "no time" },
      {
        kind: "session",
        sessionId: "s",
        at: 1,
        items: [{ kind: "message", role: "user", text: "old shape" }],
      },
      { kind: "spoken", at: 2, text: "kept too" },
    ];
    expect(texts(parseLog(JSON.stringify(junk), MAX))).toEqual(["kept", "kept too"]);
  });
});
