// Copyright 2026 the AAI authors. MIT license.
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
const ERROR_NAMES: ErrorCodeName[] = [
  "stt",
  "llm",
  "tts",
  "tool",
  "protocol",
  "connection",
  "audio",
  "internal",
];

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
