// Copyright 2026 the AAI authors. MIT license.
/**
 * Shared PCM16 audio byte conversion.
 *
 * The wire format is PCM16 **little-endian** in both directions — every
 * provider socket, every carrier and the browser client all speak it — so the
 * conversion has to name a byte order rather than inherit one.
 *
 * `new Int16Array(buffer, …)` inherits: typed-array element access uses the
 * HOST's byte order, so on a big-endian Node (s390x is the supported one) the
 * zero-copy view reads every sample byte-swapped. That is silent — the samples
 * are in range and the length is right, so it surfaces as unintelligible audio
 * in both directions rather than as an error. The browser twin
 * (`aai-ui/worklets/playback-processor.ts`) has probed for this from the start
 * and this module did not, so the two halves of one wire format disagreed
 * about whether the byte order was assumed or checked.
 *
 * It is checked now, in the same shape as the twin: the zero-copy path is
 * guarded by {@link HOST_IS_LITTLE_ENDIAN} and the explicit
 * {@link copyPcm16Le} / {@link copyPcm16LeBytes} are the fallback. On a
 * little-endian host — every machine this ships to today — the guard is the
 * only cost and the fast paths are unchanged.
 */

/**
 * Whether this host stores multi-byte integers in the wire's order.
 *
 * A module-level constant, so the fast paths below pay one boolean read rather
 * than a probe per audio frame.
 */
const HOST_IS_LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

/**
 * View audio bytes as PCM16 LE samples. Zero-copy when the view is 2-byte
 * aligned (even byte offset AND even byte length) on a little-endian host;
 * otherwise copies, dropping a trailing odd byte.
 */
export function bytesToPcm16(bytes: Uint8Array): Int16Array {
  const { byteOffset: offset, byteLength: length } = bytes;
  if (HOST_IS_LITTLE_ENDIAN && offset % 2 === 0 && length % 2 === 0) {
    return new Int16Array(bytes.buffer, offset, length / 2);
  }
  return copyPcm16Le(bytes);
}

/**
 * Copy audio bytes into PCM16 samples, reading each one explicitly
 * little-endian. A trailing odd byte is dropped.
 *
 * The path an unaligned view takes on ANY host, and the path EVERY view takes
 * on a big-endian one — which is why it reads through a `DataView` rather than
 * copying the bytes and viewing the copy as an `Int16Array`, as it used to: a
 * copy is byte-identical, so viewing it inherits the host's order exactly like
 * the fast path does.
 */
export function copyPcm16Le(bytes: Uint8Array): Int16Array {
  const samples = new Int16Array(bytes.byteLength >> 1);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true);
  return samples;
}

/**
 * View PCM16 samples as audio bytes. Zero-copy on a little-endian host — the
 * returned array aliases the samples' backing buffer, so callers must not
 * retain it past the point where the samples may be reused. On a big-endian
 * host it is {@link copyPcm16LeBytes}, i.e. a copy, which is strictly safer
 * than what it replaces and satisfies the same contract.
 */
export function pcm16ToBytes(pcm: Int16Array): Uint8Array {
  if (HOST_IS_LITTLE_ENDIAN) return new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  return copyPcm16LeBytes(pcm);
}

/** Copy PCM16 samples out as explicitly little-endian audio bytes. */
export function copyPcm16LeBytes(pcm: Int16Array): Uint8Array {
  const bytes = new Uint8Array(pcm.byteLength);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < pcm.length; i++) view.setInt16(i * 2, pcm[i] as number, true);
  return bytes;
}
