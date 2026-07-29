// Copyright 2026 the AAI authors. MIT license.
/** Shared PCM16 audio byte conversion. */

/**
 * View audio bytes as PCM16 LE samples. Zero-copy when the view is
 * 2-byte aligned; otherwise copies, dropping a trailing odd byte.
 */
export function bytesToPcm16(bytes: Uint8Array): Int16Array {
  const { byteOffset: offset, byteLength: length } = bytes;
  if (offset % 2 === 0 && length % 2 === 0) {
    return new Int16Array(bytes.buffer, offset, length / 2);
  }
  const copy = new Uint8Array(length - (length % 2));
  copy.set(bytes.subarray(0, copy.byteLength));
  return new Int16Array(copy.buffer);
}

/**
 * View PCM16 samples as audio bytes. Always zero-copy — the returned array
 * aliases the samples' backing buffer, so callers must not retain it past the
 * point where the samples may be reused.
 */
export function pcm16ToBytes(pcm: Int16Array): Uint8Array {
  return new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
}

/**
 * Append trailing silence to a PCM16 byte buffer — used when an uploaded
 * clip is replayed through a realtime STT session, whose endpointing needs
 * silence after the speech to commit the final turn.
 */
export function withTrailingSilence(
  bytes: Uint8Array,
  sampleRate: number,
  seconds = 1,
): Uint8Array {
  const padded = new Uint8Array(bytes.byteLength + sampleRate * 2 * seconds);
  padded.set(bytes);
  return padded;
}
