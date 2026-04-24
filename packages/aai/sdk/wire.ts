// Copyright 2025 the AAI authors. MIT license.
// Tagged binary wire format for the client ↔ platform-server WebSocket.
// See docs/superpowers/specs/2026-04-23-websocket-middle-hop-consolidation-design.md.

// ─── Message type codes (client → server: 0x00-0x7F) ───────────────────────
export const C2S = {
  AUDIO_CHUNK: 0x00,
  AUDIO_READY: 0x01,
  CANCEL: 0x02,
  RESET: 0x03,
  HISTORY: 0x04,
} as const;

// ─── Message type codes (server → client: 0x80-0xFF) ───────────────────────
export const S2C = {
  AUDIO_CHUNK: 0x80,
  AUDIO_DONE: 0x81,
  CONFIG: 0x82,
  SPEECH_STARTED: 0x83,
  SPEECH_STOPPED: 0x84,
  USER_TRANSCRIPT: 0x85,
  AGENT_TRANSCRIPT: 0x86,
  TOOL_CALL: 0x87,
  TOOL_CALL_DONE: 0x88,
  REPLY_DONE: 0x89,
  CANCELLED: 0x8a,
  RESET: 0x8b,
  IDLE_TIMEOUT: 0x8c,
  ERROR: 0x8d,
  CUSTOM_EVENT: 0x8e,
} as const;

// ─── Wire error codes (u8, see spec §5.4) ──────────────────────────────────
// MUST match `SessionErrorCodeSchema` in protocol.ts (same names, same order).
// protocol.ts's Zod schema is deleted in Task 20 once all callers route through here.
export const ERROR_CODE = {
  stt: 0x00,
  llm: 0x01,
  tts: 0x02,
  tool: 0x03,
  protocol: 0x04,
  connection: 0x05,
  audio: 0x06,
  internal: 0x07,
} as const;

export type ErrorCodeName = keyof typeof ERROR_CODE;
// Derived from ERROR_CODE at module load so the two cannot drift.
const ERROR_NAMES: ErrorCodeName[] = Object.entries(ERROR_CODE)
  .sort(([, a], [, b]) => a - b)
  .map(([k]) => k) as ErrorCodeName[];

export function errorCodeToByte(name: ErrorCodeName): number {
  return ERROR_CODE[name];
}

export function errorCodeFromByte(byte: number): ErrorCodeName | undefined {
  return ERROR_NAMES[byte];
}

// ─── DecodeResult ──────────────────────────────────────────────────────────
export type DecodeResult<T> = { ok: true; data: T } | { ok: false; reason: string };

// ─── Low-level primitive readers / writers ─────────────────────────────────
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export function encodeUtf8(s: string): Uint8Array {
  return encoder.encode(s);
}

export function decodeUtf8(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

/** Builds a DataView that shares memory with the given Uint8Array. */
export function viewOf(buf: Uint8Array): DataView {
  return new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
}

// ─── Encoders ──────────────────────────────────────────────────────────────
// Every encoder returns a Uint8Array where byte 0 is the type code.

/** 1-byte frame (type only, empty payload). */
function encodeEmpty(type: number): Uint8Array {
  return new Uint8Array([type]);
}

/** [type][raw bytes] — used for AUDIO_CHUNK in both directions. */
function encodeRaw(type: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(1 + payload.byteLength);
  out[0] = type;
  out.set(payload, 1);
  return out;
}

/** [type][u32 len][utf8 bytes] */
function encodeU32String(type: number, s: string): Uint8Array {
  const bytes = encodeUtf8(s);
  const out = new Uint8Array(1 + 4 + bytes.byteLength);
  out[0] = type;
  const view = viewOf(out);
  view.setUint32(1, bytes.byteLength, true);
  out.set(bytes, 5);
  return out;
}

// ─── Client → Server encoders ──────────────────────────────────────────────

export function encAudioChunkC2S(pcm: Uint8Array): Uint8Array {
  return encodeRaw(C2S.AUDIO_CHUNK, pcm);
}
export function encAudioReady(): Uint8Array {
  return encodeEmpty(C2S.AUDIO_READY);
}
export function encCancel(): Uint8Array {
  return encodeEmpty(C2S.CANCEL);
}
export function encResetC2S(): Uint8Array {
  return encodeEmpty(C2S.RESET);
}

export type HistoryMessage = { role: "user" | "assistant"; content: string };

export function encHistory(messages: readonly HistoryMessage[]): Uint8Array {
  const contents = messages.map((m) => encodeUtf8(m.content));
  let size = 1 + 4; // type + count
  for (const c of contents) size += 1 + 4 + c.byteLength;
  const out = new Uint8Array(size);
  out[0] = C2S.HISTORY;
  const view = viewOf(out);
  view.setUint32(1, messages.length, true);
  let off = 5;
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i] as HistoryMessage;
    const content = contents[i] as Uint8Array;
    out[off++] = msg.role === "user" ? 0 : 1;
    view.setUint32(off, content.byteLength, true);
    off += 4;
    out.set(content, off);
    off += content.byteLength;
  }
  return out;
}

// ─── Server → Client encoders ──────────────────────────────────────────────

export function encAudioChunkS2C(pcm: Uint8Array): Uint8Array {
  return encodeRaw(S2C.AUDIO_CHUNK, pcm);
}
export function encAudioDone(): Uint8Array {
  return encodeEmpty(S2C.AUDIO_DONE);
}

export function encConfig(cfg: {
  sampleRate: number;
  ttsSampleRate: number;
  sid: string;
}): Uint8Array {
  const sidBytes = encodeUtf8(cfg.sid);
  const out = new Uint8Array(1 + 4 + 4 + 2 + sidBytes.byteLength);
  out[0] = S2C.CONFIG;
  const view = viewOf(out);
  view.setUint32(1, cfg.sampleRate, true);
  view.setUint32(5, cfg.ttsSampleRate, true);
  view.setUint16(9, sidBytes.byteLength, true);
  out.set(sidBytes, 11);
  return out;
}

export function encSpeechStarted(): Uint8Array {
  return encodeEmpty(S2C.SPEECH_STARTED);
}
export function encSpeechStopped(): Uint8Array {
  return encodeEmpty(S2C.SPEECH_STOPPED);
}
export function encUserTranscript(text: string): Uint8Array {
  return encodeU32String(S2C.USER_TRANSCRIPT, text);
}
export function encAgentTranscript(text: string): Uint8Array {
  return encodeU32String(S2C.AGENT_TRANSCRIPT, text);
}

/**
 * Encodes a TOOL_CALL frame. Returns `null` if `JSON.stringify(args)` throws;
 * caller should log and drop (matches encCustomEvent).
 */
export function encToolCall(callId: string, name: string, args: unknown): Uint8Array | null {
  let argsStr: string;
  try {
    argsStr = JSON.stringify(args);
  } catch {
    return null;
  }
  const idB = encodeUtf8(callId);
  const nameB = encodeUtf8(name);
  const argsB = encodeUtf8(argsStr);
  const out = new Uint8Array(1 + 2 + idB.byteLength + 2 + nameB.byteLength + 4 + argsB.byteLength);
  out[0] = S2C.TOOL_CALL;
  const view = viewOf(out);
  let off = 1;
  view.setUint16(off, idB.byteLength, true);
  off += 2;
  out.set(idB, off);
  off += idB.byteLength;
  view.setUint16(off, nameB.byteLength, true);
  off += 2;
  out.set(nameB, off);
  off += nameB.byteLength;
  view.setUint32(off, argsB.byteLength, true);
  off += 4;
  out.set(argsB, off);
  return out;
}

export function encToolCallDone(callId: string, result: string): Uint8Array {
  const idB = encodeUtf8(callId);
  const resB = encodeUtf8(result);
  const out = new Uint8Array(1 + 2 + idB.byteLength + 4 + resB.byteLength);
  out[0] = S2C.TOOL_CALL_DONE;
  const view = viewOf(out);
  let off = 1;
  view.setUint16(off, idB.byteLength, true);
  off += 2;
  out.set(idB, off);
  off += idB.byteLength;
  view.setUint32(off, resB.byteLength, true);
  off += 4;
  out.set(resB, off);
  return out;
}

export function encReplyDone(): Uint8Array {
  return encodeEmpty(S2C.REPLY_DONE);
}
export function encCancelled(): Uint8Array {
  return encodeEmpty(S2C.CANCELLED);
}
export function encResetS2C(): Uint8Array {
  return encodeEmpty(S2C.RESET);
}
export function encIdleTimeout(): Uint8Array {
  return encodeEmpty(S2C.IDLE_TIMEOUT);
}

export function encError(codeName: ErrorCodeName, message: string): Uint8Array {
  const msgB = encodeUtf8(message);
  const out = new Uint8Array(1 + 1 + 2 + msgB.byteLength);
  out[0] = S2C.ERROR;
  out[1] = errorCodeToByte(codeName);
  const view = viewOf(out);
  view.setUint16(2, msgB.byteLength, true);
  out.set(msgB, 4);
  return out;
}

/**
 * Encodes a CUSTOM_EVENT frame. Returns `null` if `JSON.stringify(data)` throws
 * (BigInt, circular ref, etc.); caller should log and drop.
 */
export function encCustomEvent(name: string, data: unknown): Uint8Array | null {
  let dataStr: string;
  try {
    dataStr = JSON.stringify(data);
  } catch {
    return null;
  }
  const nameB = encodeUtf8(name);
  const dataB = encodeUtf8(dataStr);
  const out = new Uint8Array(1 + 2 + nameB.byteLength + 4 + dataB.byteLength);
  out[0] = S2C.CUSTOM_EVENT;
  const view = viewOf(out);
  let off = 1;
  view.setUint16(off, nameB.byteLength, true);
  off += 2;
  out.set(nameB, off);
  off += nameB.byteLength;
  view.setUint32(off, dataB.byteLength, true);
  off += 4;
  out.set(dataB, off);
  return out;
}

// ─── Decoded frames (discriminated union) ──────────────────────────────────

export type DecodedC2S =
  | { type: "audio_chunk"; pcm: Uint8Array }
  | { type: "audio_ready" }
  | { type: "cancel" }
  | { type: "reset" }
  | { type: "history"; messages: HistoryMessage[] };

export type DecodedS2C =
  | { type: "audio_chunk"; pcm: Uint8Array }
  | { type: "audio_done" }
  | { type: "config"; sampleRate: number; ttsSampleRate: number; sid: string }
  | { type: "speech_started" }
  | { type: "speech_stopped" }
  | { type: "user_transcript"; text: string }
  | { type: "agent_transcript"; text: string }
  | { type: "tool_call"; callId: string; name: string; args: unknown }
  | { type: "tool_call_done"; callId: string; result: string }
  | { type: "reply_done" }
  | { type: "cancelled" }
  | { type: "reset" }
  | { type: "idle_timeout" }
  | { type: "error"; code: ErrorCodeName; message: string }
  | { type: "custom_event"; name: string; data: unknown };

function readU16(view: DataView, off: number): number {
  return view.getUint16(off, true);
}
function readU32(view: DataView, off: number): number {
  return view.getUint32(off, true);
}

/** Safe UTF-8 decode; returns undefined on invalid input. */
function safeDecodeUtf8(bytes: Uint8Array): string | undefined {
  try {
    return decoder.decode(bytes);
  } catch {
    // invalid UTF-8 — falls through to implicit undefined return
  }
}

/** Decodes a client → server frame. Never throws. */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: switch over all C2S frame types; splitting would hurt readability
export function decodeC2S(frame: Uint8Array): DecodeResult<DecodedC2S> {
  if (frame.byteLength === 0) return { ok: false, reason: "empty frame" };
  const view = viewOf(frame);
  const type = view.getUint8(0);

  switch (type) {
    case C2S.AUDIO_CHUNK:
      return { ok: true, data: { type: "audio_chunk", pcm: frame.subarray(1) } };
    case C2S.AUDIO_READY:
      return { ok: true, data: { type: "audio_ready" } };
    case C2S.CANCEL:
      return { ok: true, data: { type: "cancel" } };
    case C2S.RESET:
      return { ok: true, data: { type: "reset" } };
    case C2S.HISTORY: {
      if (frame.byteLength < 5) return { ok: false, reason: "history: truncated header" };
      const count = readU32(view, 1);
      const messages: HistoryMessage[] = [];
      let off = 5;
      for (let i = 0; i < count; i++) {
        if (off + 5 > frame.byteLength) return { ok: false, reason: "history: truncated entry" };
        const role = view.getUint8(off++) === 0 ? "user" : "assistant";
        const len = readU32(view, off);
        off += 4;
        if (off + len > frame.byteLength) return { ok: false, reason: "history: content overflow" };
        const content = safeDecodeUtf8(frame.subarray(off, off + len));
        if (content === undefined) return { ok: false, reason: "history: invalid utf8" };
        off += len;
        messages.push({ role, content });
      }
      return { ok: true, data: { type: "history", messages } };
    }
    default:
      return { ok: false, reason: `unknown c2s type 0x${type.toString(16)}` };
  }
}

/** Decodes a server → client frame. Never throws. */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: switch over all S2C frame types; splitting would hurt readability
export function decodeS2C(frame: Uint8Array): DecodeResult<DecodedS2C> {
  if (frame.byteLength === 0) return { ok: false, reason: "empty frame" };
  const view = viewOf(frame);
  const type = view.getUint8(0);

  switch (type) {
    case S2C.AUDIO_CHUNK:
      return { ok: true, data: { type: "audio_chunk", pcm: frame.subarray(1) } };
    case S2C.AUDIO_DONE:
      return { ok: true, data: { type: "audio_done" } };
    case S2C.CONFIG: {
      if (frame.byteLength < 1 + 4 + 4 + 2)
        return { ok: false, reason: "config: truncated header" };
      const sampleRate = readU32(view, 1);
      const ttsSampleRate = readU32(view, 5);
      const sidLen = readU16(view, 9);
      if (11 + sidLen > frame.byteLength) return { ok: false, reason: "config: sid overflow" };
      const sid = safeDecodeUtf8(frame.subarray(11, 11 + sidLen));
      if (sid === undefined) return { ok: false, reason: "config: invalid sid utf8" };
      return { ok: true, data: { type: "config", sampleRate, ttsSampleRate, sid } };
    }
    case S2C.SPEECH_STARTED:
      return { ok: true, data: { type: "speech_started" } };
    case S2C.SPEECH_STOPPED:
      return { ok: true, data: { type: "speech_stopped" } };
    case S2C.USER_TRANSCRIPT:
    case S2C.AGENT_TRANSCRIPT: {
      if (frame.byteLength < 5) return { ok: false, reason: "transcript: truncated header" };
      const len = readU32(view, 1);
      if (5 + len > frame.byteLength) return { ok: false, reason: "transcript: overflow" };
      const text = safeDecodeUtf8(frame.subarray(5, 5 + len));
      if (text === undefined) return { ok: false, reason: "transcript: invalid utf8" };
      return {
        ok: true,
        data: { type: type === S2C.USER_TRANSCRIPT ? "user_transcript" : "agent_transcript", text },
      };
    }
    case S2C.TOOL_CALL: {
      let off = 1;
      if (off + 2 > frame.byteLength) return { ok: false, reason: "tool_call: truncated idLen" };
      const idLen = readU16(view, off);
      off += 2;
      if (off + idLen > frame.byteLength) return { ok: false, reason: "tool_call: id overflow" };
      const callId = safeDecodeUtf8(frame.subarray(off, off + idLen));
      if (callId === undefined) return { ok: false, reason: "tool_call: invalid id utf8" };
      off += idLen;
      if (off + 2 > frame.byteLength) return { ok: false, reason: "tool_call: truncated nameLen" };
      const nameLen = readU16(view, off);
      off += 2;
      if (off + nameLen > frame.byteLength)
        return { ok: false, reason: "tool_call: name overflow" };
      const name = safeDecodeUtf8(frame.subarray(off, off + nameLen));
      if (name === undefined) return { ok: false, reason: "tool_call: invalid name utf8" };
      off += nameLen;
      if (off + 4 > frame.byteLength) return { ok: false, reason: "tool_call: truncated argsLen" };
      const argsLen = readU32(view, off);
      off += 4;
      if (off + argsLen > frame.byteLength)
        return { ok: false, reason: "tool_call: args overflow" };
      const argsJson = safeDecodeUtf8(frame.subarray(off, off + argsLen));
      if (argsJson === undefined) return { ok: false, reason: "tool_call: invalid args utf8" };
      let args: unknown;
      try {
        args = JSON.parse(argsJson);
      } catch {
        return { ok: false, reason: "tool_call: invalid args json" };
      }
      return { ok: true, data: { type: "tool_call", callId, name, args } };
    }
    case S2C.TOOL_CALL_DONE: {
      let off = 1;
      if (off + 2 > frame.byteLength)
        return { ok: false, reason: "tool_call_done: truncated idLen" };
      const idLen = readU16(view, off);
      off += 2;
      if (off + idLen > frame.byteLength)
        return { ok: false, reason: "tool_call_done: id overflow" };
      const callId = safeDecodeUtf8(frame.subarray(off, off + idLen));
      if (callId === undefined) return { ok: false, reason: "tool_call_done: invalid id utf8" };
      off += idLen;
      if (off + 4 > frame.byteLength)
        return { ok: false, reason: "tool_call_done: truncated resLen" };
      const resLen = readU32(view, off);
      off += 4;
      if (off + resLen > frame.byteLength)
        return { ok: false, reason: "tool_call_done: result overflow" };
      const result = safeDecodeUtf8(frame.subarray(off, off + resLen));
      if (result === undefined) return { ok: false, reason: "tool_call_done: invalid result utf8" };
      return { ok: true, data: { type: "tool_call_done", callId, result } };
    }
    case S2C.REPLY_DONE:
      return { ok: true, data: { type: "reply_done" } };
    case S2C.CANCELLED:
      return { ok: true, data: { type: "cancelled" } };
    case S2C.RESET:
      return { ok: true, data: { type: "reset" } };
    case S2C.IDLE_TIMEOUT:
      return { ok: true, data: { type: "idle_timeout" } };
    case S2C.ERROR: {
      if (frame.byteLength < 4) return { ok: false, reason: "error: truncated header" };
      const codeByte = view.getUint8(1);
      const code = errorCodeFromByte(codeByte);
      if (code === undefined)
        return { ok: false, reason: `error: unknown code 0x${codeByte.toString(16)}` };
      const msgLen = readU16(view, 2);
      if (4 + msgLen > frame.byteLength) return { ok: false, reason: "error: message overflow" };
      const message = safeDecodeUtf8(frame.subarray(4, 4 + msgLen));
      if (message === undefined) return { ok: false, reason: "error: invalid utf8" };
      return { ok: true, data: { type: "error", code, message } };
    }
    case S2C.CUSTOM_EVENT: {
      let off = 1;
      if (off + 2 > frame.byteLength)
        return { ok: false, reason: "custom_event: truncated nameLen" };
      const nameLen = readU16(view, off);
      off += 2;
      if (off + nameLen > frame.byteLength)
        return { ok: false, reason: "custom_event: name overflow" };
      const name = safeDecodeUtf8(frame.subarray(off, off + nameLen));
      if (name === undefined) return { ok: false, reason: "custom_event: invalid name utf8" };
      off += nameLen;
      if (off + 4 > frame.byteLength)
        return { ok: false, reason: "custom_event: truncated dataLen" };
      const dataLen = readU32(view, off);
      off += 4;
      if (off + dataLen > frame.byteLength)
        return { ok: false, reason: "custom_event: data overflow" };
      const dataJson = safeDecodeUtf8(frame.subarray(off, off + dataLen));
      if (dataJson === undefined) return { ok: false, reason: "custom_event: invalid data utf8" };
      let data: unknown;
      try {
        data = JSON.parse(dataJson);
      } catch {
        return { ok: false, reason: "custom_event: invalid data json" };
      }
      return { ok: true, data: { type: "custom_event", name, data } };
    }
    default:
      return { ok: false, reason: `unknown s2c type 0x${type.toString(16)}` };
  }
}
