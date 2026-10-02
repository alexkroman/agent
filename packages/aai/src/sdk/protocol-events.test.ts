// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import {
  AgentTranscriptRecoverySchema,
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
  test("accepts speech.started", () => {
    expect({ type: "speech.started" }).toBeValidSessionEvent();
  });

  test("accepts userTranscript.committed", () => {
    expect({ type: "userTranscript.committed", text: "hello world" }).toBeValidSessionEvent();
  });

  test("accepts error event", () => {
    expect({
      type: "error.reported",
      code: "internal",
      message: "something went wrong",
      fatal: true,
    }).toBeValidSessionEvent();
  });

  test("rejects unknown type", () => {
    expect({ type: "unknown_event_type" }).not.toBeValidSessionEvent();
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
