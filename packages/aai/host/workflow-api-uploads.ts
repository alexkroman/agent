// Copyright 2026 the AAI authors. MIT license.
/**
 * The two upload routes: put a file somewhere a run can reach, and read it back.
 *
 * ```text
 * POST /workflows/uploads?name=recording.wav   → 201 { id, name, type, size, url }
 * GET  /workflows/uploads/:id                  → the bytes, `Range` honoured
 * ```
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
import { UPLOAD_CHUNK_BYTES } from "../sdk/upload-constants.ts";
import { WORKFLOW_API_PREFIX } from "../sdk/workflow-api-client.ts";
import type { Logger } from "./runtime-config.ts";
import { sendJson } from "./workflow-api-http.ts";
import { type UploadStore, UploadTooLargeError } from "./workflow-uploads.ts";

/** Path the upload routes live under. */
export const UPLOADS_PATH = `${WORKFLOW_API_PREFIX}/uploads`;

/** What `POST /workflows/uploads` answers with. */
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

/** `POST /workflows/uploads` — store the request body and answer with its id. */
export async function createUpload(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  store: UploadStore,
  logger: Logger,
): Promise<void> {
  const params = requestQuery(req.url);
  const type = req.headers["content-type"];
  try {
    const info = await store.create(
      {
        name: params.get("name") ?? undefined,
        // The declared type, minus any `; charset=` parameter — it describes
        // the request, not the file.
        type: typeof type === "string" ? (type.split(";")[0] ?? "").trim() : undefined,
      },
      req,
    );
    logger.info("Workflow upload stored", { id: info.id, name: info.name, size: info.size });
    sendJson(res, 201, { ...info, url: `${UPLOADS_PATH}/${info.id}` } satisfies UploadCreated);
  } catch (err: unknown) {
    // 413 here rather than in the router's catch, because this is the one route
    // whose body is MEANT to be large: the cap is part of its contract, and a
    // caller has to tell "too big" apart from "the agent is broken".
    if (err instanceof UploadTooLargeError) {
      sendJson(res, 413, { error: err.message });
      return;
    }
    throw err;
  }
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
 * A `Content-Disposition` naming the file.
 *
 * The filename is the UPLOADER's string, so it is quoted with its quotes and
 * backslashes stripped rather than escaped — a header value that breaks out of
 * its own quoting is a response-splitting bug, and no filename needs those
 * characters enough to justify the risk. The `filename*` form carries anything
 * non-ASCII.
 */
function contentDisposition(name: string): string {
  const plain = name.replaceAll(/["\\\r\n]/g, "");
  return `attachment; filename="${plain}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
