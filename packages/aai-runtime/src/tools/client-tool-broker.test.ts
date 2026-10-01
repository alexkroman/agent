// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { createClientToolBroker } from "./client-tool-broker.ts";

const SID = "session-1";

describe("createClientToolBroker", () => {
  test("a wait resolves with the page's answer, JSON-decoded", async () => {
    const broker = createClientToolBroker();
    const pending = broker.wait(SID, "tc-1", new AbortController().signal);
    broker.answer(SID, { toolCallId: "tc-1", result: JSON.stringify({ lat: 1, lon: 2 }) });
    await expect(pending).resolves.toEqual({ lat: 1, lon: 2 });
  });

  test("a non-JSON result is passed through as the string the page sent", async () => {
    const broker = createClientToolBroker();
    const pending = broker.wait(SID, "tc-1", new AbortController().signal);
    broker.answer(SID, { toolCallId: "tc-1", result: "plain text" });
    await expect(pending).resolves.toBe("plain text");
  });

  test("an `error` answer rejects with the page's message", async () => {
    const broker = createClientToolBroker();
    const pending = broker.wait(SID, "tc-1", new AbortController().signal);
    broker.answer(SID, { toolCallId: "tc-1", result: "", error: "permission denied" });
    await expect(pending).rejects.toThrow("permission denied");
  });

  test("an answer that arrives before its wait is held and claimed once", async () => {
    const broker = createClientToolBroker();
    broker.answer(SID, { toolCallId: "tc-1", result: "1" });
    await expect(broker.wait(SID, "tc-1", new AbortController().signal)).resolves.toBe(1);
    // Claimed: a second wait on the same id is a fresh wait, not a replay.
    const controller = new AbortController();
    const second = broker.wait(SID, "tc-1", controller.signal);
    controller.abort(new Error("gone"));
    await expect(second).rejects.toThrow("gone");
  });

  test("answers are keyed by session: another session's id settles nothing", async () => {
    const broker = createClientToolBroker();
    const controller = new AbortController();
    const pending = broker.wait(SID, "tc-1", controller.signal);
    broker.answer("other-session", { toolCallId: "tc-1", result: "1" });
    controller.abort(new Error("timed out"));
    await expect(pending).rejects.toThrow("timed out");
  });

  test("an abort rejects the wait and a late answer is dropped without effect", async () => {
    const broker = createClientToolBroker();
    const controller = new AbortController();
    const pending = broker.wait(SID, "tc-1", controller.signal);
    controller.abort(new Error("cancelled"));
    await expect(pending).rejects.toThrow("cancelled");
    expect(() => broker.answer(SID, { toolCallId: "tc-1", result: "1" })).not.toThrow();
  });

  test("an already-aborted signal refuses to wait", async () => {
    const broker = createClientToolBroker();
    const controller = new AbortController();
    controller.abort(new Error("already over"));
    await expect(broker.wait(SID, "tc-1", controller.signal)).rejects.toThrow("already over");
  });

  test("held answers are bounded, oldest first, so a client cannot grow them", async () => {
    const broker = createClientToolBroker();
    for (let i = 0; i < 100; i++) broker.answer(SID, { toolCallId: `tc-${i}`, result: `${i}` });
    // The newest are still held…
    await expect(broker.wait(SID, "tc-99", new AbortController().signal)).resolves.toBe(99);
    // …the oldest were evicted, so this is a real wait.
    const controller = new AbortController();
    const evicted = broker.wait(SID, "tc-0", controller.signal);
    controller.abort(new Error("evicted"));
    await expect(evicted).rejects.toThrow("evicted");
  });
});
