// Copyright 2026 the AAI authors. MIT license.
/**
 * Buffer a body stream while counting bytes; returns null the moment the
 * running total exceeds `maxBytes` (the stream is cancelled, not drained).
 * Never trusts a declared length — a chunked body has none, and a sender
 * writes the header anyway.
 *
 * Two readers: the deploy body (`gzip-request.ts`, the compressed bytes) and
 * every guest response the platform buffers rather than streams
 * (`readGuestBody` in `guest/forward.ts`).
 *
 * **Preallocating from `Content-Length` was tried and is NOT here**, because the
 * copy it removes is the wrong one. A chunk list plus `Buffer.concat` does hold
 * the compressed bytes twice — but `DEPLOY_BODY_CONCURRENCY`'s own measurement
 * says a max-size deploy is **28 KB on the wire**, since the worker gzips
 * ~1000:1, so that second copy is tens of kilobytes and the ~164 MB it reports
 * is all downstream: the inflated buffer, the re-wrapped `Request`, and
 * `JSON.parse`'s UTF-16 string plus object graph. Allocating `Content-Length`
 * bytes up front would trade a 28 KB saving for a 120 MB allocation an
 * authenticated caller could trigger with a declared length and an empty body,
 * plus a lying-sender branch to get wrong. The single-chunk case below is the
 * part that is free.
 */
export async function readStreamCapped(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<Buffer | null> {
  if (!body) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  // `Buffer.concat` copies even for one chunk, and one chunk is the ordinary
  // case for a small body — the CLI's gzipped deploy arrives well inside a
  // single read. `Buffer.from` over the existing memory rather than a copy of it.
  const only = chunks.length === 1 ? chunks[0] : undefined;
  if (only) return Buffer.from(only.buffer, only.byteOffset, only.byteLength);
  return Buffer.concat(chunks);
}
