// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import {
  AgentTranscriptRecoverySchema,
  EVENT_ID_PREFIX,
  RestoredToolCallSchema,
  SESSION_EVENT_TYPES,
  SessionErrorCodeSchema,
  SessionEventSchema,
} from "./protocol-events.ts";

const ERROR_CODES = [
  "stt",
  "llm",
  "tts",
  "tool",
  "protocol",
  "connection",
  "audio",
  "internal",
] as const;

describe("SessionErrorCodeSchema", () => {
  test.each(ERROR_CODES)("accepts valid code: %s", (code) => {
    expect(SessionErrorCodeSchema.safeParse(code).success).toBe(true);
  });

  test("rejects invalid code", () => {
    expect(SessionErrorCodeSchema.safeParse("not_a_real_code").success).toBe(false);
  });
});

describe("SessionEventSchema", () => {
  /**
   * Parse an event BODY — the shape emitting code writes — under the envelope
   * the wire schema requires, so each case need not hand-write a `meta`.
   */
  const parseBody = (body: Record<string, unknown>) =>
    SessionEventSchema.safeParse({ ...body, meta: { id: `${EVENT_ID_PREFIX}TEST`, at: 0 } });

  test.each([
    { type: "speech.started" },
    { type: "userTranscript.committed", text: "hello world" },
    { type: "error.reported", code: "internal", message: "something went wrong", fatal: true },
  ])("accepts $type", (body) => {
    // The issues, not a bare `false`, are what a failure prints.
    expect(parseBody(body).error?.issues ?? []).toEqual([]);
  });

  test("rejects unknown type", () => {
    expect(parseBody({ type: "unknown_event_type" }).success).toBe(false);
  });
});

describe("RestoredToolCallSchema", () => {
  const call = {
    callId: "c1",
    name: "lookup",
    args: { id: 1 },
    status: "done",
    result: "ok",
    afterMessageIndex: -1,
  };

  test("accepts a settled call, -1 meaning before any message", () => {
    expect(RestoredToolCallSchema.safeParse(call).success).toBe(true);
  });

  test("refuses an index below -1 and an unknown status", () => {
    expect(RestoredToolCallSchema.safeParse({ ...call, afterMessageIndex: -2 }).success).toBe(
      false,
    );
    expect(RestoredToolCallSchema.safeParse({ ...call, status: "failed" }).success).toBe(false);
  });
});

describe("AgentTranscriptRecoverySchema", () => {
  test("is the two recoveries a transcript can report", () => {
    expect(AgentTranscriptRecoverySchema.options).toEqual(["turn-failed", "session-failed"]);
  });
});

describe("SESSION_EVENT_TYPES", () => {
  test("names every member of the event union, and nothing else", () => {
    expect(SESSION_EVENT_TYPES.size).toBe(SessionEventSchema.options.length);
    expect(SESSION_EVENT_TYPES.has("speech.started")).toBe(true);
    expect(SESSION_EVENT_TYPES.has("unknown_event_type")).toBe(false);
  });
});
