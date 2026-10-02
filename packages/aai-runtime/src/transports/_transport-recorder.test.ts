// Copyright 2026 the AAI authors. MIT license.
/**
 * The recording `TransportCallbacks` the transport specs assert against: every
 * report lands in one ordered log AND in a stable per-type spy.
 */

import { describe, expect, test } from "vitest";
import { makeCallbacks, partialTranscripts } from "./_transport-recorder.ts";

describe("makeCallbacks", () => {
  test("records every report in order, and per type on a stable spy", () => {
    const callbacks = makeCallbacks();
    callbacks.report({ type: "speech.started" });
    callbacks.report({ type: "agentTranscript.updated", text: "Hel" });
    callbacks.report({ type: "speech.started" });
    expect(callbacks.events.map((e) => e.type)).toEqual([
      "speech.started",
      "agentTranscript.updated",
      "speech.started",
    ]);
    expect(callbacks.reported("speech.started")).toBe(callbacks.reported("speech.started"));
    expect(callbacks.reported("speech.started")).toHaveBeenCalledTimes(2);
    expect(callbacks.reported("reply.completed")).not.toHaveBeenCalled();
  });

  test("a spy cleared by a spec stays the one later reports reach", () => {
    const callbacks = makeCallbacks();
    callbacks.report({ type: "reply.completed" });
    callbacks.reported("reply.completed").mockClear();
    callbacks.report({ type: "reply.completed" });
    expect(callbacks.reported("reply.completed")).toHaveBeenCalledTimes(1);
  });
});

describe("partialTranscripts", () => {
  test("reads the agent's partial transcript texts, in order", () => {
    const callbacks = makeCallbacks();
    callbacks.report({ type: "agentTranscript.updated", text: "Hel" });
    callbacks.report({ type: "userTranscript.updated", text: "user" });
    callbacks.report({ type: "agentTranscript.updated", text: "Hello" });
    expect(partialTranscripts(callbacks)).toEqual(["Hel", "Hello"]);
  });
});
