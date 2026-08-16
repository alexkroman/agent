// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test, vi } from "vitest";
import { SESSION_EVENT_READ_LIMIT } from "../sdk/session-event-constants.ts";
import { makeMockCore } from "./_test-utils.ts";
import { attachSessionStream, readAllEvents } from "./runtime-session-stream.ts";
import { createSessionEventStream } from "./session-event-stream.ts";
import { createMemoryStateBackend } from "./session-state-store.ts";

const SID = "s-1";

describe("attachSessionStream", () => {
  test("a RESUME restores the conversation from the server's own log", async () => {
    const backend = createMemoryStateBackend();
    // A previous connection's session, on a process that is now gone.
    const before = createSessionEventStream({ backend });
    before.append(SID, { type: "user-transcript.committed", text: "my order is 4471" });
    before.append(SID, { type: "agent-transcript.committed", text: "Found it." });
    await before.flush(SID);

    const stream = createSessionEventStream({ backend });
    const core = makeMockCore();
    attachSessionStream(core, { stream, sessionId: SID, resumed: true });

    await core.start();

    expect(core.restoreHistory).toHaveBeenCalledWith([
      { role: "user", content: "my order is 4471" },
      { role: "assistant", content: "Found it." },
    ]);
  });

  test("the log CONTINUES after a resume rather than overwriting itself", async () => {
    const backend = createMemoryStateBackend();
    const before = createSessionEventStream({ backend });
    before.append(SID, { type: "user-transcript.committed", text: "first" });
    await before.flush(SID);

    const stream = createSessionEventStream({ backend });
    // `start` is what hydrates; a resumed session that appended before it would
    // otherwise restart at index 0. (An orphan `attachSessionStream` over a core
    // nobody started stood here, discarded on the next line — it read as setup
    // that mattered and affected nothing.)
    const core = makeMockCore();
    attachSessionStream(core, { stream, sessionId: SID, resumed: true });
    await core.start();

    stream.append(SID, { type: "user-transcript.committed", text: "second" });
    await stream.flush(SID);

    const page = await stream.read(SID, 0);
    expect(page.tail).toBe(2);
  });

  test("a FRESH session restores nothing and pays no read", async () => {
    const backend = createMemoryStateBackend();
    const stream = createSessionEventStream({ backend });
    const read = vi.spyOn(stream, "read");
    const core = makeMockCore();
    attachSessionStream(core, { stream, sessionId: SID, resumed: false });

    await core.start();

    expect(core.restoreHistory).not.toHaveBeenCalled();
    // A fresh session's log is empty, so the read could only answer nothing.
    expect(read).not.toHaveBeenCalled();
  });

  test("a resume with an empty log does not restore an empty conversation", async () => {
    const stream = createSessionEventStream({ backend: createMemoryStateBackend() });
    const core = makeMockCore();
    attachSessionStream(core, { stream, sessionId: SID, resumed: true });

    await core.start();

    expect(core.restoreHistory).not.toHaveBeenCalled();
  });

  test("the underlying start still runs, and after the restore", async () => {
    const order: string[] = [];
    const backend = createMemoryStateBackend();
    const before = createSessionEventStream({ backend });
    before.append(SID, { type: "user-transcript.committed", text: "hi" });
    await before.flush(SID);

    const core = makeMockCore({
      restoreHistory: vi.fn(() => order.push("restore")),
      start: vi.fn(() => {
        order.push("start");
        return Promise.resolve();
      }),
    });
    attachSessionStream(core, {
      stream: createSessionEventStream({ backend }),
      sessionId: SID,
      resumed: true,
    });

    await core.start();

    // Inside the `session.start()` window and before the session is ready, so no
    // tool can observe a session that has not got its conversation back.
    expect(order).toEqual(["restore", "start"]);
  });

  test("stop FLUSHES the pending batch", async () => {
    const backend = createMemoryStateBackend();
    const stream = createSessionEventStream({ backend });
    const core = makeMockCore();
    attachSessionStream(core, { stream, sessionId: SID, resumed: false });
    // Below the flush threshold and not a boundary, so nothing is written yet.
    stream.append(SID, { type: "speech.started" });

    await core.stop();

    await expect(backend.countEvents(SID)).resolves.toBe(1);
  });

  test("stop flushes even when the session stopped by FAILING", async () => {
    const backend = createMemoryStateBackend();
    const stream = createSessionEventStream({ backend });
    const core = makeMockCore({ stop: vi.fn(() => Promise.reject(new Error("provider died"))) });
    attachSessionStream(core, { stream, sessionId: SID, resumed: false });
    stream.append(SID, { type: "error.reported", code: "stt", message: "gone" });

    await expect(core.stop()).rejects.toThrow("provider died");

    // The events leading up to a failure are the ones most worth having.
    await expect(backend.countEvents(SID)).resolves.toBe(1);
  });
});

describe("readAllEvents", () => {
  test("pages through a log longer than one read", async () => {
    const stream = createSessionEventStream({ backend: createMemoryStateBackend() });
    const total = SESSION_EVENT_READ_LIMIT + 7;
    for (let i = 0; i < total; i++) {
      stream.append(SID, { type: "user-transcript.committed", text: `m${i}` });
    }

    const events = await readAllEvents(stream, SID);

    expect(events).toHaveLength(total);
    expect(events.at(-1)).toMatchObject({ text: `m${total - 1}` });
  });

  test("a session emitting while the read runs cannot keep the loop going", async () => {
    const stream = createSessionEventStream({ backend: createMemoryStateBackend() });
    for (let i = 0; i < 3; i++) stream.append(SID, { type: "speech.started" });

    const events = await readAllEvents(stream, SID);

    // Bounded by the first read's tail: anything appended after is by definition
    // not part of the conversation being restored.
    expect(events).toHaveLength(3);
  });
});
