// Copyright 2025 the AAI authors. MIT license.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import type { ErrorCodeName } from "./wire.ts";
import {
  C2S,
  decodeC2S,
  decodeS2C,
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

describe("decoder round-trips every frame type", () => {
  test("client → server", () => {
    const chunk = new Uint8Array([1, 2, 3]);
    expect(decodeC2S(encAudioChunkC2S(chunk))).toEqual({
      ok: true,
      data: { type: "audio_chunk", pcm: new Uint8Array([1, 2, 3]) },
    });
    expect(decodeC2S(encAudioReady())).toEqual({ ok: true, data: { type: "audio_ready" } });
    expect(decodeC2S(encCancel())).toEqual({ ok: true, data: { type: "cancel" } });
    expect(decodeC2S(encResetC2S())).toEqual({ ok: true, data: { type: "reset" } });
    const history = [
      { role: "user" as const, content: "hi" },
      { role: "assistant" as const, content: "hello" },
    ];
    expect(decodeC2S(encHistory(history))).toEqual({
      ok: true,
      data: { type: "history", messages: history },
    });
  });

  test("server → client", () => {
    expect(decodeS2C(encAudioChunkS2C(new Uint8Array([9, 8])))).toEqual({
      ok: true,
      data: { type: "audio_chunk", pcm: new Uint8Array([9, 8]) },
    });
    expect(decodeS2C(encAudioDone())).toEqual({ ok: true, data: { type: "audio_done" } });
    expect(decodeS2C(encConfig({ sampleRate: 16_000, ttsSampleRate: 24_000, sid: "abc" }))).toEqual(
      {
        ok: true,
        data: { type: "config", sampleRate: 16_000, ttsSampleRate: 24_000, sid: "abc" },
      },
    );
    expect(decodeS2C(encSpeechStarted())).toEqual({ ok: true, data: { type: "speech_started" } });
    expect(decodeS2C(encSpeechStopped())).toEqual({ ok: true, data: { type: "speech_stopped" } });
    expect(decodeS2C(encUserTranscript("hello"))).toEqual({
      ok: true,
      data: { type: "user_transcript", text: "hello" },
    });
    expect(decodeS2C(encAgentTranscript("world"))).toEqual({
      ok: true,
      data: { type: "agent_transcript", text: "world" },
    });
    const tc = encToolCall("cid", "get_weather", { location: "SF" });
    expect(tc).not.toBeNull();
    if (tc)
      expect(decodeS2C(tc)).toEqual({
        ok: true,
        data: { type: "tool_call", callId: "cid", name: "get_weather", args: { location: "SF" } },
      });
    expect(decodeS2C(encToolCallDone("cid", "72F sunny"))).toEqual({
      ok: true,
      data: { type: "tool_call_done", callId: "cid", result: "72F sunny" },
    });
    expect(decodeS2C(encReplyDone())).toEqual({ ok: true, data: { type: "reply_done" } });
    expect(decodeS2C(encCancelled())).toEqual({ ok: true, data: { type: "cancelled" } });
    expect(decodeS2C(encResetS2C())).toEqual({ ok: true, data: { type: "reset" } });
    expect(decodeS2C(encIdleTimeout())).toEqual({ ok: true, data: { type: "idle_timeout" } });
    expect(decodeS2C(encError("connection", "boom"))).toEqual({
      ok: true,
      data: { type: "error", code: "connection", message: "boom" },
    });
    const ce = encCustomEvent("ping", { x: 1 });
    expect(ce).not.toBeNull();
    if (ce)
      expect(decodeS2C(ce)).toEqual({
        ok: true,
        data: { type: "custom_event", name: "ping", data: { x: 1 } },
      });
  });
});

describe("decoder handles malformed frames without throwing", () => {
  test("empty frame", () => {
    expect(decodeC2S(new Uint8Array([])).ok).toBe(false);
    expect(decodeS2C(new Uint8Array([])).ok).toBe(false);
  });
  test("unknown type byte", () => {
    const r = decodeC2S(new Uint8Array([0x7f, 1, 2]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/unknown/);
  });
  test("truncated config", () => {
    expect(decodeS2C(new Uint8Array([S2C.CONFIG, 1, 2, 3])).ok).toBe(false);
  });
  test("config sid overflow", () => {
    // Claims 100 bytes of sid but only provides 2
    const f = new Uint8Array([S2C.CONFIG, 0, 0, 0, 0, 0, 0, 0, 0, 100, 0, 0x61, 0x62]);
    expect(decodeS2C(f).ok).toBe(false);
  });
  test("invalid utf8 in transcript", () => {
    const f = new Uint8Array([S2C.USER_TRANSCRIPT, 2, 0, 0, 0, 0xff, 0xfe]);
    const r = decodeS2C(f);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/utf8/);
  });
  test("tool_call with invalid args json", () => {
    const id = new TextEncoder().encode("cid");
    const name = new TextEncoder().encode("tool");
    const badJson = new TextEncoder().encode("{not-json");
    const out = new Uint8Array(
      1 + 2 + id.byteLength + 2 + name.byteLength + 4 + badJson.byteLength,
    );
    out[0] = S2C.TOOL_CALL;
    const dv = new DataView(out.buffer);
    let off = 1;
    dv.setUint16(off, id.byteLength, true);
    off += 2;
    out.set(id, off);
    off += id.byteLength;
    dv.setUint16(off, name.byteLength, true);
    off += 2;
    out.set(name, off);
    off += name.byteLength;
    dv.setUint32(off, badJson.byteLength, true);
    off += 4;
    out.set(badJson, off);
    const r = decodeS2C(out);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/args json/);
  });
});

type Fixtures = {
  c2s: Record<string, Record<string, unknown>>;
  s2c: Record<string, Record<string, unknown>>;
};

const fixtures = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "compat-fixtures/wire-v1.json"), "utf-8"),
) as Fixtures;

describe("wire-v1 canonical fixtures (round-trip lock)", () => {
  test("audio_chunk_4bytes", () => {
    const input = fixtures.c2s.audio_chunk_4bytes as { pcm: number[] };
    const f = encAudioChunkC2S(new Uint8Array(input.pcm));
    const r = decodeC2S(f);
    expect(r.ok).toBe(true);
    if (r.ok && r.data.type === "audio_chunk") {
      expect(Array.from(r.data.pcm)).toEqual(input.pcm);
    }
  });
  test("audio_ready", () => {
    const f = encAudioReady();
    expect(Array.from(f)).toEqual([C2S.AUDIO_READY]);
  });
  test("cancel", () => {
    const f = encCancel();
    expect(Array.from(f)).toEqual([C2S.CANCEL]);
  });
  test("reset (c2s)", () => {
    const f = encResetC2S();
    expect(Array.from(f)).toEqual([C2S.RESET]);
  });
  test("history_empty", () => {
    const f = encHistory([]);
    expect(Array.from(f)).toEqual([C2S.HISTORY, 0, 0, 0, 0]);
  });
  test("history_two round-trips", () => {
    const input = fixtures.c2s.history_two as {
      messages: { role: "user" | "assistant"; content: string }[];
    };
    const f = encHistory(input.messages);
    const r = decodeC2S(f);
    expect(r.ok).toBe(true);
    if (r.ok && r.data.type === "history") {
      expect(r.data.messages).toEqual(input.messages);
    }
  });
  test("audio_chunk_2bytes", () => {
    const input = fixtures.s2c.audio_chunk_2bytes as { pcm: number[] };
    const f = encAudioChunkS2C(new Uint8Array(input.pcm));
    expect(Array.from(f)).toEqual([S2C.AUDIO_CHUNK, ...input.pcm]);
  });
  test("audio_done", () => {
    expect(Array.from(encAudioDone())).toEqual([S2C.AUDIO_DONE]);
  });
  test("config", () => {
    const input = fixtures.s2c.config as {
      sampleRate: number;
      ttsSampleRate: number;
      sid: string;
    };
    const f = encConfig(input);
    const r = decodeS2C(f);
    expect(r.ok).toBe(true);
    if (r.ok && r.data.type === "config") {
      expect(r.data).toEqual({ type: "config", ...input });
    }
  });
  test("reply_done", () => {
    expect(Array.from(encReplyDone())).toEqual([S2C.REPLY_DONE]);
  });
  test("cancelled", () => {
    expect(Array.from(encCancelled())).toEqual([S2C.CANCELLED]);
  });
  test("error_connection_boom", () => {
    const input = fixtures.s2c.error_connection_boom as {
      code: ErrorCodeName;
      message: string;
    };
    const f = encError(input.code, input.message);
    const r = decodeS2C(f);
    expect(r.ok).toBe(true);
    if (r.ok && r.data.type === "error") {
      expect(r.data).toEqual({ type: "error", code: input.code, message: input.message });
    }
  });
});
