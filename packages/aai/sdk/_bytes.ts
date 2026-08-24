// Copyright 2026 the AAI authors. MIT license.
/**
 * Byte-buffer joins, in one place.
 *
 * Three modules had written the same allocate-once-then-`set`-at-an-offset
 * loop — `step-fetch.ts`'s `multipartBody`, and the two fakes that drain a
 * streaming request body (`_testing-step-fetch.ts`, `testing-uploads.ts`).
 * The loop is short enough to look finished each time it is retyped, and its
 * two halves (sum the lengths, then walk the same array again) are exactly the
 * shape a copy gets subtly wrong — `length` where the sum used `byteLength`,
 * on a view into a larger buffer.
 *
 * Zero dependencies and no `node:` import, so this is reachable from anywhere
 * in `sdk/`.
 *
 * @module _bytes
 */

/** One buffer from several. */
export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}

/**
 * Drain an async iterable of chunks into one buffer.
 *
 * The stream is consumed ONCE, which is why a recorder that stored the iterable
 * would hand its caller something the request had already eaten.
 */
export async function collectBytes(chunks: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (const chunk of chunks) parts.push(chunk);
  return concatBytes(parts);
}
