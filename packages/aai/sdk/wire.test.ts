// Copyright 2025 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import {
  C2S,
  ERROR_CODE,
  encAgentTranscript,
  encAudioChunkC2S,
  encAudioChunkS2C,
  encAudioDone,
  encAudioReady,
  encCancel,
  encCancelled,
  encConfig,
  encCustomEvent,
  encError,
  encHistory,
  encIdleTimeout,
  encReplyDone,
  encResetC2S,
  encResetS2C,
  encSpeechStarted,
  encSpeechStopped,
  encToolCall,
  encToolCallDone,
  encUserTranscript,
  errorCodeFromByte,
  errorCodeToByte,
  S2C,
} from "./wire.ts";

describe("wire type codes", () => {
  test("client→server codes are in 0x00-0x7F", () => {
    for (const v of Object.values(C2S)) expect(v).toBeLessThanOrEqual(0x7f);
  });
  test("server→client codes are in 0x80-0xFF", () => {
    for (const v of Object.values(S2C)) expect(v).toBeGreaterThanOrEqual(0x80);
  });
  test("type codes are unique per direction", () => {
    expect(new Set(Object.values(C2S)).size).toBe(Object.values(C2S).length);
    expect(new Set(Object.values(S2C)).size).toBe(Object.values(S2C).length);
  });
});

describe("error code mapping", () => {
  test("round-trips through name/byte", () => {
    for (const [name, byte] of Object.entries(ERROR_CODE)) {
      expect(errorCodeToByte(name as keyof typeof ERROR_CODE)).toBe(byte);
      expect(errorCodeFromByte(byte)).toBe(name);
    }
  });
  test("unknown byte returns undefined", () => {
    expect(errorCodeFromByte(0xff)).toBeUndefined();
  });
});

describe("encoders produce single-byte frames for empty payloads", () => {
  test.each([
    ["AUDIO_READY", encAudioReady(), C2S.AUDIO_READY],
    ["CANCEL", encCancel(), C2S.CANCEL],
    ["RESET (c2s)", encResetC2S(), C2S.RESET],
    ["AUDIO_DONE", encAudioDone(), S2C.AUDIO_DONE],
    ["SPEECH_STARTED", encSpeechStarted(), S2C.SPEECH_STARTED],
    ["SPEECH_STOPPED", encSpeechStopped(), S2C.SPEECH_STOPPED],
    ["REPLY_DONE", encReplyDone(), S2C.REPLY_DONE],
    ["CANCELLED", encCancelled(), S2C.CANCELLED],
    ["RESET (s2c)", encResetS2C(), S2C.RESET],
    ["IDLE_TIMEOUT", encIdleTimeout(), S2C.IDLE_TIMEOUT],
  ])("%s = [%s]", (_name, frame, code) => {
    expect(frame).toEqual(new Uint8Array([code]));
  });
});

describe("audio chunk encoders prefix the type byte then copy PCM", () => {
  test("client → server", () => {
    const pcm = new Uint8Array([1, 2, 3, 4]);
    const f = encAudioChunkC2S(pcm);
    expect(f.length).toBe(5);
    expect(f[0]).toBe(C2S.AUDIO_CHUNK);
    expect(Array.from(f.subarray(1))).toEqual([1, 2, 3, 4]);
  });
  test("server → client", () => {
    const pcm = new Uint8Array([5, 6]);
    const f = encAudioChunkS2C(pcm);
    expect(f[0]).toBe(S2C.AUDIO_CHUNK);
    expect(Array.from(f.subarray(1))).toEqual([5, 6]);
  });
});

describe("text encoders use u32 length prefix", () => {
  test("USER_TRANSCRIPT", () => {
    const f = encUserTranscript("hello");
    expect(f[0]).toBe(S2C.USER_TRANSCRIPT);
    const len = new DataView(f.buffer, f.byteOffset + 1, 4).getUint32(0, true);
    expect(len).toBe(5);
    expect(new TextDecoder().decode(f.subarray(5))).toBe("hello");
  });
  test("AGENT_TRANSCRIPT handles multi-byte utf-8", () => {
    const f = encAgentTranscript("café");
    const utf8 = new TextEncoder().encode("café");
    expect(f.length).toBe(1 + 4 + utf8.byteLength);
  });
});

describe("config encoder", () => {
  test("packs rates + sid", () => {
    const f = encConfig({ sampleRate: 16_000, ttsSampleRate: 24_000, sid: "abc" });
    const dv = new DataView(f.buffer, f.byteOffset, f.byteLength);
    expect(f[0]).toBe(S2C.CONFIG);
    expect(dv.getUint32(1, true)).toBe(16_000);
    expect(dv.getUint32(5, true)).toBe(24_000);
    expect(dv.getUint16(9, true)).toBe(3);
    expect(new TextDecoder().decode(f.subarray(11))).toBe("abc");
  });
});

describe("error encoder", () => {
  test("encodes code byte + message", () => {
    const f = encError("connection", "boom");
    expect(f[0]).toBe(S2C.ERROR);
    expect(f[1]).toBe(0x05);
    const len = new DataView(f.buffer, f.byteOffset + 2, 2).getUint16(0, true);
    expect(len).toBe(4);
    expect(new TextDecoder().decode(f.subarray(4))).toBe("boom");
  });
});

describe("tool_call and tool_call_done", () => {
  test("tool_call encodes id + name + args-json", () => {
    const f = encToolCall("cid-1", "get_weather", { location: "SF" });
    expect(f).not.toBeNull();
    if (f === null) return;
    expect(f[0]).toBe(S2C.TOOL_CALL);
    const dv = new DataView(f.buffer, f.byteOffset, f.byteLength);
    const idLen = dv.getUint16(1, true);
    expect(new TextDecoder().decode(f.subarray(3, 3 + idLen))).toBe("cid-1");
  });
  test("tool_call returns null when args is not JSON-serializable", () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(encToolCall("cid", "tool", cycle)).toBeNull();
  });
  test("tool_call_done encodes id + result", () => {
    const f = encToolCallDone("cid-1", "72F sunny");
    expect(f[0]).toBe(S2C.TOOL_CALL_DONE);
    const dv = new DataView(f.buffer, f.byteOffset, f.byteLength);
    const idLen = dv.getUint16(1, true);
    expect(idLen).toBe(5);
    expect(new TextDecoder().decode(f.subarray(3, 3 + idLen))).toBe("cid-1");
    const resLen = dv.getUint32(3 + idLen, true);
    expect(resLen).toBe(9);
    expect(new TextDecoder().decode(f.subarray(3 + idLen + 4, 3 + idLen + 4 + resLen))).toBe(
      "72F sunny",
    );
  });
});

describe("history encoder", () => {
  test("empty history is type + count=0", () => {
    const f = encHistory([]);
    expect(f).toEqual(new Uint8Array([C2S.HISTORY, 0, 0, 0, 0]));
  });
  test("two messages", () => {
    const f = encHistory([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);
    const dv = new DataView(f.buffer, f.byteOffset, f.byteLength);
    expect(dv.getUint32(1, true)).toBe(2);
  });
});

describe("custom_event", () => {
  test("encodes name + data-json", () => {
    const f = encCustomEvent("ping", { x: 1 });
    expect(f).not.toBeNull();
    if (f === null) throw new Error("expected non-null");
    expect(f[0]).toBe(S2C.CUSTOM_EVENT);
  });
  test("returns null if data is not JSON-serializable", () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(encCustomEvent("bad", cycle)).toBeNull();
  });
});
