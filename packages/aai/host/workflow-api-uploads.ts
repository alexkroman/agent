// Copyright 2026 the AAI authors. MIT license.
/**
 * The two upload routes: put a file somewhere a run can reach, and read it back.
 *
 * ```text
 * POST /workflows/uploads?name=recording.wav   → 201 { id, …, complete: true }
 * PUT  /workflows/uploads/:id?name=…           → 201 { id, …, complete: true }
 * GET  /workflows/uploads/:id                  → the bytes, `Range` honoured
 * GET  /workflows/uploads/:id/info             → { id, name, type, size, complete }
 * ```
 *
 * ## POST mints the id; PUT lets the caller choose it
 *
 * The pair is not redundant, and the difference decides whether a run can start
 * before the bytes are in. `POST` answers with an id once the LAST byte is stored,
 * which is the only honest thing it can do — so a form that needs the id in a run
 * input has to wait for the whole upload. `PUT` takes the id in the path, so the
 * caller already has it: start the run, then stream the file, and the run reads
 * what has arrived. `GET …/info` is how anything other than a step watches that
 * happen; a step reads the same record in-process through `uploadInfo`.
 *
 * **`…/info` must be matched BEFORE `/uploads/:id`**, which is a prefix rule that
 * would otherwise read `"<id>/info"` as an id and 404 an upload that exists. Same
 * trap as `/runs/:id/events`; the router's own doc carries the general rule.
 *
 * Split from `workflow-api.ts` because nothing here is about runs — the store is
 * the only thing these two touch, and the module they came out of is the one
 * place a route may only do what a tool can do.
 *
 * ## The body is the FILE, not a multipart envelope
 *
 * `POST` takes the bytes raw: the filename rides in `?name=` and the type in
 * `Content-Type`. That is what lets the body stream straight into the store with
 * one chunk in memory at a time — a multipart parse would mean a boundary
 * scanner and a dependency, for an envelope carrying exactly one part. Both
 * callers are ours (`api.upload()` in the browser, `curl --data-binary`
 * everywhere else) and neither wanted the envelope.
 *
 * ## `Range` is honoured because the reader is a fan-out
 *
 * A page downloading its own upload is the rare case; the common one is sixty
 * steps each reading their own window. Steps read through `readUpload`, which is
 * in-process and never touches HTTP — but the route has to agree with it,
 * because the same window is what a browser, a `curl -r`, and the platform proxy
 * ask for. So the range arithmetic is HTTP's (inclusive bounds, 206, a
 * `Content-Range` naming the total) and the store's is JavaScript's, converted
 * once, here.
 */

import type http from "node:http";
import { requestQuery } from "../sdk/request-url.ts";
import type { UploadInfo } from "../sdk/step-uploads.ts";
import { UPLOAD_CHUNK_BYTES, UPLOAD_TOKEN_RE } from "../sdk/upload-constants.ts";
import { WORKFLOW_API_PREFIX } from "../sdk/workflow-api-client.ts";
import type { Logger } from "./runtime-config.ts";
import { sendJson } from "./workflow-api-http.ts";
import {
  UploadIdTakenError,
  type UploadMeta,
  type UploadStore,
  UploadTooLargeError,
} from "./workflow-uploads.ts";

/** Path the upload routes live under. */
export const UPLOADS_PATH = `${WORKFLOW_API_PREFIX}/uploads`;

/** What `POST` and `PUT /workflows/uploads` answer with. */
export type UploadCreated = UploadInfo & {
  /**
   * Where the bytes are, relative to the API's own prefix.
   *
   * Relative rather than absolute because only the CALLER knows the origin it
   * reached this agent on: on the platform that is `/:slug/workflows/...`, under
   * `aai dev` it is the dev server, and a guest answering with its own sandbox
   * URL would hand out a link that dies with the sandbox.
   */
  url: string;
};

/** What the uploader declared about the file, off the query and the header. */
function declaredMeta(req: http.IncomingMessage): UploadMeta {
  const type = req.headers["content-type"];
  return {
    name: requestQuery(req.url).get("name") ?? undefined,
    // The declared type, minus any `; charset=` parameter — it describes the
    // request, not the file.
    type: typeof type === "string" ? (type.split(";")[0] ?? "").trim() : undefined,
  };
}

/**
 * Answer a write failure, or re-throw.
 *
 * 413 here rather than in the router's catch, because these are the routes whose
 * body is MEANT to be large: the cap is part of their contract, and a caller has
 * to tell "too big" apart from "the agent is broken". 409 for a taken id for the
 * same reason — the request is well formed and the id is simply not available,
 * which a client retrying a `PUT` after a lost response needs to know.
 */
function sendWriteFailure(res: http.ServerResponse, err: unknown): boolean {
  if (err instanceof UploadTooLargeError) {
    sendJson(res, 413, { error: err.message });
    return true;
  }
  if (err instanceof UploadIdTakenError) {
    sendJson(res, 409, { error: err.message });
    return true;
  }
  return false;
}

/** `POST /workflows/uploads` — store the request body and answer with its id. */
export async function createUpload(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  store: UploadStore,
  logger: Logger,
): Promise<void> {
  try {
    const info = await store.create(declaredMeta(req), req);
    logger.info("Workflow upload stored", { id: info.id, name: info.name, size: info.size });
    sendJson(res, 201, { ...info, url: `${UPLOADS_PATH}/${info.id}` } satisfies UploadCreated);
  } catch (err: unknown) {
    if (sendWriteFailure(res, err)) return;
    throw err;
  }
}

/**
 * `PUT /workflows/uploads/:id` — store the body under the caller's own id,
 * readable as it arrives.
 *
 * The route that lets a run start first. Everything about it is the same as the
 * `POST` except who names the upload, and that one difference is the feature: the
 * caller has the id before the bytes leave, so it can go in a run input.
 */
export async function streamUpload(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  store: UploadStore,
  id: string,
  logger: Logger,
): Promise<void> {
  if (!UPLOAD_TOKEN_RE.test(id)) {
    sendJson(res, 400, {
      error:
        "A caller-chosen upload id is 1-64 characters of letters, digits, `-` and `_` — a " +
        "`crypto.randomUUID()` already qualifies.",
    });
    return;
  }
  try {
    const info = await store.stream(id, declaredMeta(req), req);
    logger.info("Workflow upload streamed", { id: info.id, name: info.name, size: info.size });
    sendJson(res, 201, { ...info, url: `${UPLOADS_PATH}/${info.id}` } satisfies UploadCreated);
  } catch (err: unknown) {
    if (sendWriteFailure(res, err)) return;
    throw err;
  }
}

/**
 * `GET /workflows/uploads/:id/info` — the record, including how much has arrived.
 *
 * The read a CLIENT polls while its own `PUT` is still in flight, and the one a
 * page shows progress from. A step reads the same record in-process (`uploadInfo`),
 * so this exists for everything that is not one: a script, a dashboard, or a person
 * with `curl` asking why a run is still waiting.
 */
export async function readUploadInfoRoute(
  res: http.ServerResponse,
  store: UploadStore,
  id: string,
): Promise<void> {
  const info = await store.info(id);
  if (!info) {
    sendJson(res, 404, { error: `No upload with id ${id}` });
    return;
  }
  sendJson(res, 200, info);
}

/** `GET /workflows/uploads/:id` — the bytes, whole or by range. */
export async function readUploadRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  store: UploadStore,
  id: string,
): Promise<void> {
  const info = id ? await store.info(id) : undefined;
  if (!info) {
    sendJson(res, 404, { error: `No upload with id ${id}` });
    return;
  }
  const header = req.headers.range;
  const range = typeof header === "string" ? parseRange(header, info.size) : undefined;
  if (range === "unsatisfiable") {
    res.writeHead(416, { "Content-Range": `bytes */${info.size}`, "Accept-Ranges": "bytes" });
    res.end();
    return;
  }

  const start = range?.start ?? 0;
  const end = range?.end ?? info.size;
  res.writeHead(range ? 206 : 200, {
    "Content-Type": info.type || "application/octet-stream",
    "Content-Length": String(end - start),
    "Accept-Ranges": "bytes",
    // `Content-Range` is inclusive of its last byte, unlike everything else
    // here — hence `end - 1`, and hence the empty-range case being excluded by
    // `parseRange` rather than papered over.
    ...(range ? { "Content-Range": `bytes ${start}-${end - 1}/${info.size}` } : {}),
    ...(info.name ? { "Content-Disposition": contentDisposition(info.name) } : {}),
  });

  // Streamed a chunk at a time: this route exists for files far larger than
  // this process's memory, so buffering the answer would defeat the storage
  // layer's whole shape.
  for (let at = start; at < end; at += UPLOAD_CHUNK_BYTES) {
    const bytes = await store.read(id, at, Math.min(at + UPLOAD_CHUNK_BYTES, end));
    // A client that hung up mid-download: stop reading rather than filling a
    // socket nobody is on the other end of.
    if (!res.write(bytes)) await drained(res);
    if (res.destroyed) return;
  }
  res.end();
}

/** Wait for the response's buffer to empty, so a slow reader paces the reads. */
function drained(res: http.ServerResponse): Promise<void> {
  return new Promise((resolve) => {
    res.once("drain", resolve);
    res.once("close", resolve);
  });
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
