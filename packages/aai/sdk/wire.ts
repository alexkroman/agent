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

export function encToolCall(callId: string, name: string, args: unknown): Uint8Array {
  const idB = encodeUtf8(callId);
  const nameB = encodeUtf8(name);
  const argsB = encodeUtf8(JSON.stringify(args));
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
