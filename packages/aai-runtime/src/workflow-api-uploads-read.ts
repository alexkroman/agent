// Copyright 2026 the AAI authors. MIT license.
/**
 * The two upload READS: the record, and the bytes.
 *
 * ```text
 * GET /workflows/uploads/:id/info  → { id, name, type, size, complete }
 * GET /workflows/uploads/:id       → the bytes, `Range` honoured
 * ```
 *
 * Split from `workflow-api-uploads.ts`, which is the WRITE half, on the file-length
 * cap — and the seam is a real one rather than a place the knife fell. The writes
 * are about admitting bytes: an id grammar, an offset grid, a cap, and the five
 * refusals that come with them. The reads are about answering with them: range
 * arithmetic, a `Content-Disposition`, and the pacing below. The only thing they
 * share is how a store failure becomes a status, which is `_upload-route-failures.ts`
 * and is imported by both.
 *
 * **`…/info` must be matched BEFORE `/uploads/:id`**, which is a prefix rule that
 * would otherwise read `"<id>/info"` as an id and 404 an upload that exists. Same
 * trap as `/runs/:id/events`; the router's own doc carries the general rule.
 *
 * ## `Range` is honoured because the reader is a fan-out
 *
 * A page downloading its own upload is the rare case; the common one is sixty steps
 * each reading their own window. Steps read through `stepReadUpload`, which is
 * in-process and never touches HTTP — but the route has to agree with it, because
 * the same window is what a browser, a `curl -r`, and the platform proxy ask for. So
 * the range arithmetic is HTTP's (inclusive bounds, 206, a `Content-Range` naming
 * the total) and the store's is JavaScript's, converted once, here.
 *
 * ## The chunks are read AHEAD of the socket
 *
 * A window of this file is one object in a bucket, so every chunk this route writes
 * is a round trip — and read one at a time, strictly after the previous chunk was
 * written, a 200 MB download is a couple of hundred round trips laid end to end with
 * the client's socket idle through every one of them. That is latency, not
 * bandwidth: nothing about the link says the next read has to wait for the last
 * write.
 *
 * So {@link UPLOAD_READ_AHEAD} chunks are in flight while the answer is being
 * written. Two properties keep that honest:
 *
 * - **Order is preserved.** `mapStream` yields in source order, so the body is the
 *   file however the reads settle — a chunk that overtook its predecessor would be
 *   a corrupted download, silently.
 * - **Backpressure still comes from the socket.** The loop below stops pulling while
 *   it waits on `drained`, so a slow reader parks the whole pipeline after at most
 *   one window of read-ahead. Peak memory is `UPLOAD_READ_AHEAD * UPLOAD_CHUNK_BYTES`
 *   — 8 MiB — rather than the file.
 *
 * A client that hangs up mid-download leaves those reads in flight; `mapStream`
 * settles them on the way out rather than abandoning them, so nothing rejects into
 * an empty room.
 */

import type http from "node:http";
import {
  mapStream,
  type OpenUpload,
  UPLOAD_CHUNK_BYTES,
  UPLOAD_CLAIM_BATCH,
} from "@alexkroman1/aai/host-internal";
import { sendUploadFailure } from "./_upload-route-failures.ts";
import { sendJson } from "./workflow-api-http.ts";
import type { UploadStore } from "./workflow-uploads.ts";

/**
 * Chunks read ahead of what has been written to the socket.
 *
 * Eight, which is `UPLOAD_CHUNK_BYTES` apiece and so 8 MiB in flight — the same
 * width the browser's own upload fan-out uses, and for the same reason: the wait
 * being covered is a round trip to a bucket, and one request cannot fill a link
 * across one. It is a READ-AHEAD rather than a buffer: nothing is pulled while the
 * socket is backed up, so a client that stops reading stops the reads.
 */
export const UPLOAD_READ_AHEAD = 8;

/**
 * A store read, with a named failure ANSWERED rather than thrown.
 *
 * Three states, and the reads need all three kept apart: the value, "no such
 * upload" (`null` → the caller's 404), and "this route already answered"
 * (`undefined` → return). Collapsing the last two is what would put a
 * misconfigured deployment back under a 404, which reads as "your id is wrong" —
 * the same confusion `createUnavailableUploadStore` refuses to create by making
 * its methods throw instead of answering empty.
 */
async function orFail<T>(
  res: http.ServerResponse,
  read: () => Promise<T | undefined>,
): Promise<T | null | undefined> {
  try {
    return (await read()) ?? null;
  } catch (err: unknown) {
    if (sendUploadFailure(res, err)) return undefined;
    throw err;
  }
}

/**
 * `GET /workflows/uploads/:id/info` — the record, including how much has arrived.
 *
 * The read a CLIENT polls while its own `PUT` is still in flight, and the one a
 * page shows progress from. A step reads the same record in-process (`stepUploadInfo`),
 * so this exists for everything that is not one: a script, a dashboard, or a person
 * with `curl` asking why a run is still waiting.
 */
export async function readUploadInfoRoute(
  res: http.ServerResponse,
  store: UploadStore,
  id: string,
  directParts = false,
): Promise<void> {
  const info = await orFail(res, async () => await store.info(id));
  if (info === undefined) return;
  if (!info) {
    sendJson(res, 404, { error: `No upload with id ${id}` });
    return;
  }
  // The same two capability fields the CLAIM answers with, and for the case the
  // claim cannot serve: a RESUME re-declares an id it already owns, the store
  // answers 409, and a 409 carries no body to read them from. Without them here a
  // resumed upload silently abandoned the direct path — it still worked, sending
  // every window's bytes to the agent instead of to the platform, which is the
  // topology this whole path exists to avoid and the one the forward reads as a
  // stalled guest. They are a property of the DEPLOYMENT, so they are the same
  // answer whichever route is asked.
  // `undefined` rather than a conditional spread, and `sendJson`'s `JSON.stringify`
  // drops it — the same spelling `beginUploadParts` uses, for the same reason: a
  // client reads the field's PRESENCE, and absent is what an older agent answers.
  sendJson(res, 200, {
    ...info,
    directParts: directParts ? true : undefined,
    claimBatch: directParts ? UPLOAD_CLAIM_BATCH : undefined,
  });
}

/** `GET /workflows/uploads/:id` — the bytes, whole or by range. */
export async function readUploadRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  store: UploadStore,
  id: string,
): Promise<void> {
  // OPENED once, not read per chunk. Every chunk below used to call
  // `store.read(id, …)`, each of which resolves the record for itself — so a range
  // download of an N-window upload cost N+1 look-ups of one row, and on a deployed
  // guest a look-up is a `POST /:slug/upload-records` across the platform. It also
  // PINS the window map for the whole response, which the `Content-Length` written
  // below was already assuming. See {@link OpenUpload}.
  const held = id ? await orFail(res, async () => await store.open(id)) : null;
  if (held === undefined) return;
  if (!held) {
    sendJson(res, 404, { error: `No upload with id ${id}` });
    return;
  }
  await sendUploadBytes(req, res, held);
}

/**
 * The answer itself, once the record is in hand.
 *
 * Split from the route on the complexity cap, and the seam is where the route stops
 * DECIDING and starts writing: everything above resolves which of the three answers
 * this request gets (a refusal, a 404, or the file), everything here is the file.
 */
async function sendUploadBytes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  held: OpenUpload,
): Promise<void> {
  const { info } = held;
  const header = req.headers.range;
  const range = typeof header === "string" ? parseRange(header, info.size) : undefined;
  if (range === "unsatisfiable") {
    res.writeHead(416, { "Content-Range": `bytes */${info.size}`, "Accept-Ranges": "bytes" });
    res.end();
    return;
  }

  const start = range?.start ?? 0;
  const end = range?.end ?? info.size;
  const headers: Record<string, string> = {
    "Content-Type": info.type || "application/octet-stream",
    "Content-Length": String(end - start),
    "Accept-Ranges": "bytes",
  };
  // Assigned rather than spread through a ternary: in both cases the guard is not
  // the value — one derives a different header from `range`, the other calls a
  // function — so neither is the presence test `omitUndefined` rewrites, and both
  // were `guard-invariants` rule 22 occurrences carried on a baseline.
  //
  // `Content-Range` is inclusive of its last byte, unlike everything else here —
  // hence `end - 1`, and hence the empty-range case being excluded by `parseRange`
  // rather than papered over. An EMPTY name gets no disposition at all, which is
  // the deliberate half of that truthiness: `filename=""` is worse than absent.
  if (range) headers["Content-Range"] = `bytes ${start}-${end - 1}/${info.size}`;
  if (info.name) headers["Content-Disposition"] = contentDisposition(info.name);
  res.writeHead(range ? 206 : 200, headers);

  // Streamed a chunk at a time, several reads ahead of the socket — see the module
  // doc. This route exists for files far larger than this process's memory, so
  // buffering the answer would defeat the storage layer's whole shape, and reading
  // one chunk per write would pay a round trip per megabyte.
  for await (const bytes of mapStream(chunkRanges(start, end), UPLOAD_READ_AHEAD, (window) =>
    held.read(window.start, window.end),
  )) {
    // A client that hung up mid-download: stop reading rather than filling a
    // socket nobody is on the other end of. Leaving the loop closes the stream,
    // which settles the reads that were already in flight.
    if (!res.write(bytes)) await drained(res);
    if (res.destroyed) return;
  }
  res.end();
}

/** `[start, end)` as the chunk windows the store is asked for, in order. */
function* chunkRanges(start: number, end: number): Generator<{ start: number; end: number }> {
  for (let at = start; at < end; at += UPLOAD_CHUNK_BYTES) {
    yield { start: at, end: Math.min(at + UPLOAD_CHUNK_BYTES, end) };
  }
}

/**
 * Wait for the response's buffer to empty, so a slow reader paces the reads.
 *
 * **Both listeners come off when either fires**, which they did not: `once` removes
 * the listener it fired and leaves its sibling attached forever, so a download that
 * hit backpressure `n` times left `n` `close` listeners on the response. Node warns
 * at ten (`MaxListenersExceededWarning`) and a large file goes far past it — a 2 GiB
 * read is two thousand of them — which is a leak on the fan-out path and a warning
 * on a log nobody can act on. Surfaced by the read-ahead above: reading several
 * chunks at once is what makes a socket back up often enough to notice.
 */
function drained(res: http.ServerResponse): Promise<void> {
  const settled = Promise.withResolvers<void>();
  const done = (): void => {
    res.off("drain", done);
    res.off("close", done);
    settled.resolve();
  };
  res.once("drain", done);
  res.once("close", done);
  return settled.promise;
}

/**
 * One `Range` header as `[start, end)`, or `"unsatisfiable"`.
 *
 * Only a single byte range is understood: a multi-range request would have to
 * answer `multipart/byteranges`, which no caller here sends and which is a
 * second body format to get wrong. Per RFC 9110 a range this cannot parse is
 * IGNORED (the whole file is a legal answer), while one that parses and falls
 * outside the file is a 416 — so a plan computed against a stale size fails
 * loudly instead of silently reading nothing.
 */
export function parseRange(
  header: string,
  size: number,
): { start: number; end: number } | "unsatisfiable" | undefined {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return undefined;
  const [, rawStart = "", rawEnd = ""] = match;
  if (rawStart === "" && rawEnd === "") return undefined;
  if (rawStart === "") {
    // `bytes=-N` — the last N bytes. A suffix longer than the file is the whole
    // file, which is what the spec says and is also the friendlier answer.
    const suffix = Number(rawEnd);
    if (suffix <= 0) return "unsatisfiable";
    return { start: Math.max(0, size - suffix), end: size };
  }
  const start = Number(rawStart);
  if (start >= size) return "unsatisfiable";
  const end = rawEnd === "" ? size : Math.min(Number(rawEnd) + 1, size);
  return end > start ? { start, end } : "unsatisfiable";
}

/**
 * Everything a `filename="…"` may hold: printable ASCII, minus the two
 * characters that would break out of the quoting.
 *
 * An ALLOW-list, because the deny-list it replaced (`["\\\r\n]`) was solving the
 * wrong problem. Stripping CR/LF is response-SPLITTING defence; what a filename
 * also has to be is a header value Node will accept, and Node rejects every
 * control character. A `\x01` in an uploaded name therefore survived into the
 * metadata row and then made `res.writeHead` throw `ERR_INVALID_CHAR` — the same
 * throw on every subsequent read, so that upload was permanently a 500 with no
 * way to correct it. Non-ASCII is not lost: `filename*` carries the real name
 * and every browser prefers it.
 */
const FILENAME_UNSAFE = /["\\]|[^\x20-\x7e]/g;

/**
 * A `Content-Disposition` naming the file.
 *
 * The filename is the UPLOADER's string, so the quoted form is stripped to
 * {@link FILENAME_UNSAFE}'s complement rather than escaped — no filename needs
 * those characters enough to justify either risk. `encodeURIComponent` makes the
 * `filename*` half ASCII by construction, so it is safe whatever arrived.
 */
function contentDisposition(name: string): string {
  const plain = name.replaceAll(FILENAME_UNSAFE, "");
  return `attachment; filename="${plain}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
