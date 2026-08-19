// Copyright 2026 the AAI authors. MIT license.
/**
 * Sending one file over SEVERAL connections at once.
 *
 * `workflow-upload-client.ts` is the ordinary writer: one request carrying the
 * whole body, which is the right shape for a small file and the wrong one for a
 * recording. An upload in one request runs at the speed of one TCP connection, and
 * that is not the speed of the link — a single connection's throughput is bounded
 * by its congestion window over the round-trip time, so the further the agent is
 * the smaller a fraction of the available bandwidth it gets. The link is not busy;
 * it is idle, waiting for acknowledgements.
 *
 * So the file is cut into `UPLOAD_PART_BYTES` windows and
 * `UPLOAD_PART_CONCURRENCY` of them are sent at once, against the two `/parts`
 * routes: one `POST` declaring the id and the total, then a `PUT` per window. The
 * agent reassembles them, and nothing downstream of the store knows it happened.
 *
 * ## Everything here is OPT-IN, and degrades to the single request
 *
 * Three things make this path decline rather than fail, because none of them is
 * worth an error a caller has to handle:
 *
 * - **A body that cannot be cut by BYTE.** A `Blob` and an `ArrayBuffer` slice
 *   exactly; a `string` does not — its byte length is its UTF-8 encoding's, so
 *   cutting it by character would put a part boundary inside a code point.
 * - **A file that fits in one part.** There is nothing to parallelize, and the
 *   `POST`+`PUT` pair would be strictly more requests than the single call.
 * - **An agent that does not serve `/parts`.** A deploy older than this answers
 *   404 or 405 to the `POST`, which is an ANSWER: the same file goes up the
 *   ordinary way, one request later. That is the same shape `watch`'s 404
 *   fallback takes, and for the same reason — a page cannot know which version of
 *   the SDK an agent was deployed with.
 *
 * ## A part that dies is re-sent; a part that is REFUSED is not
 *
 * N connections give a file N chances to lose one, which is the cost of the
 * speed — so a failed part is retried once (`UPLOAD_PART_ATTEMPTS`) and the
 * store accepts the repeat as the same part rather than as a duplicate. What is
 * NOT retried is a part the agent answered: a 400 (the offset contradicts the
 * declared total), a 409, a 413 are all requests that will be refused again, and
 * retrying them is a loop the caller pays for twice.
 */

import { readJsonBody } from "./response-body.ts";
import {
  UPLOAD_CHUNK_BYTES,
  UPLOAD_PART_ATTEMPTS,
  UPLOAD_PART_BYTES,
  UPLOAD_PART_CONCURRENCY,
} from "./upload-constants.ts";
import type {
  UploadBody,
  UploadOptions,
  UploadProgress,
  UploadRef,
} from "./workflow-upload-client.ts";

/**
 * How a caller tunes the fan-out.
 *
 * Both fields have defaults sized on the constants' own reasoning, and a caller
 * that just wants the speed passes `parallel: true` and never sees this type.
 *
 * @public
 */
export type UploadPartsSettings = {
  /**
   * Bytes per part. Defaults to 8 MiB (`UPLOAD_PART_BYTES`).
   *
   * Rounded UP to a whole number of `UPLOAD_CHUNK_BYTES`, because a part starts at
   * a chunk boundary in the store and a size that is not a multiple of one would
   * put the next part's start inside a stored chunk.
   */
  partBytes?: number | undefined;
  /** Parts in flight at once. Defaults to 4 (`UPLOAD_PART_CONCURRENCY`). */
  concurrency?: number | undefined;
};

/**
 * What {@link UploadOptions.parallel} accepts: `true` for the defaults, or the
 * settings to tune them.
 *
 * @public
 */
export type UploadParallel = boolean | UploadPartsSettings;

/** The settings a caller asked for, or nothing when they did not ask. */
export function partsSettings(
  parallel: UploadParallel | undefined,
): UploadPartsSettings | undefined {
  if (parallel === undefined || parallel === false) return undefined;
  return parallel === true ? {} : parallel;
}

/** How a part's request is issued — `sendUpload`, injected so this module owns no transport. */
type SendPart = (
  method: "PUT",
  url: string,
  headers: Record<string, string>,
  body: UploadBody,
  options: UploadOptions | undefined,
) => Promise<Response>;

/** What {@link uploadInParts} needs to do its job. */
export type UploadPartsRequest = {
  /** The API root (`…/workflows`), as the client resolved it. */
  base: string;
  /** Auth headers, if the API is closed. */
  headers: Record<string, string>;
  /** How the caller turns a failed response into an error. */
  fail: (res: Response) => Promise<Error>;
  /** The single-body writer, so both paths share one transport and one error vocabulary. */
  send: SendPart;
  /** The upload's id. Minted by the caller, because a parts upload is always caller-named. */
  id: string;
  /** The whole file. */
  file: UploadBody;
  /** Filename to store. */
  name: string;
  /** MIME type to store. */
  type: string;
  /** The caller's upload options — signal and progress. */
  options: UploadOptions | undefined;
  /** What the caller asked for, already normalized. */
  settings: UploadPartsSettings;
};

/** A window of the file, and the part index that reports its progress. */
type Part = { start: number; end: number; index: number };

/**
 * The file's byte length, when it can be cut by byte at all.
 *
 * `undefined` is what makes this path DECLINE — see the module doc. A string is
 * excluded deliberately rather than encoded first: encoding it to measure it is a
 * second copy of the whole body, for a body that is not what this exists for.
 */
function sliceableBytes(file: UploadBody): number | undefined {
  if (typeof file === "string") return undefined;
  if (file instanceof ArrayBuffer) return file.byteLength;
  if (ArrayBuffer.isView(file)) return file.byteLength;
  // Read structurally rather than `instanceof Blob`: a `File` from another realm
  // (an iframe, a worker) fails an instance check while slicing perfectly well.
  const described = file as { size?: unknown; slice?: unknown };
  return typeof described.size === "number" && typeof described.slice === "function"
    ? described.size
    : undefined;
}

/** One window of the body, however it is spelled. */
function sliceOf(file: UploadBody, start: number, end: number): UploadBody {
  if (file instanceof ArrayBuffer) return file.slice(start, end);
  if (ArrayBuffer.isView(file)) {
    return new Uint8Array(file.buffer, file.byteOffset + start, end - start);
  }
  return (file as Blob).slice(start, end);
}

/** The windows to send, in order. */
export function planParts(total: number, partBytes: number): Part[] {
  // Rounded up to a whole number of chunks — the store's alignment rule, applied
  // here so a caller's `partBytes` is a preference rather than a way to fail.
  const size = Math.max(
    UPLOAD_CHUNK_BYTES,
    Math.ceil(partBytes / UPLOAD_CHUNK_BYTES) * UPLOAD_CHUNK_BYTES,
  );
  const parts: Part[] = [];
  for (let start = 0; start < total; start += size) {
    parts.push({ start, end: Math.min(start + size, total), index: parts.length });
  }
  return parts;
}

/** Statuses that mean "this agent has no `/parts` routes", as opposed to a failure. */
const NO_SUCH_ROUTE = new Set([404, 405]);

/**
 * Store one file as concurrent parts, or resolve `undefined` to say this path
 * declined.
 *
 * `undefined` is not a failure and every one of its causes is in the module doc;
 * the caller answers it by sending the file the ordinary way.
 */
export async function uploadInParts(req: UploadPartsRequest): Promise<UploadRef | undefined> {
  const total = sliceableBytes(req.file);
  if (total === undefined) return undefined;
  const parts = planParts(total, req.settings.partBytes ?? UPLOAD_PART_BYTES);
  // One part is the single request with two extra round trips in front of it.
  if (parts.length < 2) return undefined;

  const uploads = `${req.base}/uploads/${encodeURIComponent(req.id)}`;
  const begun = await fetch(
    `${uploads}/parts?name=${encodeURIComponent(req.name)}&total=${total}`,
    {
      method: "POST",
      headers: { ...req.headers, "Content-Type": req.type },
      ...(req.options?.signal ? { signal: req.options.signal } : {}),
    },
  );
  // An older agent, and the file has not moved yet — so this costs one round trip
  // and the caller falls back.
  if (NO_SUCH_ROUTE.has(begun.status)) return undefined;
  if (!begun.ok) throw await req.fail(begun);

  const report = partReporter(total, parts.length, req.options?.onProgress);
  const sendPart = async (part: Part): Promise<void> => {
    for (let attempt = 1; ; attempt += 1) {
      // Reset before every attempt, so a retried part does not leave the bytes of
      // its failed try counted in the total.
      report(part.index, 0);
      const res = await req
        .send(
          "PUT",
          `${uploads}/parts?offset=${part.start}`,
          { ...req.headers, "Content-Type": req.type },
          sliceOf(req.file, part.start, part.end),
          partOptions(req.options, part, report),
        )
        .catch((err: unknown) => {
          // A transport failure — the case parts are most exposed to. Re-thrown on
          // the last attempt, so the caller sees the real error rather than ours.
          if (attempt >= UPLOAD_PART_ATTEMPTS) throw err;
        });
      if (res?.ok) {
        report(part.index, part.end - part.start);
        return;
      }
      // An ANSWER is final: the agent refused this part and will refuse it again.
      if (res) throw await req.fail(res);
    }
  };

  await inParallel(parts, req.settings.concurrency ?? UPLOAD_PART_CONCURRENCY, sendPart);
  // The record as the agent has it, rather than one assembled here: `complete` is
  // the agent's own answer about whether every byte landed, which is the one claim
  // this path must not make on its behalf.
  const stored = await fetch(`${uploads}/info`, { headers: req.headers });
  if (!stored.ok) throw await req.fail(stored);
  const info = await readJsonBody<Omit<UploadRef, "url">>(stored, "Workflow API");
  return { ...info, url: uploads };
}

/**
 * The per-part options: the caller's signal, and a progress callback scoped to one
 * part.
 *
 * The name and type are already on the URL and the header, so nothing else of the
 * caller's options survives here — in particular a caller's own `onProgress` must
 * NOT be passed through, or it would receive one part's bytes as though they were
 * the file's.
 */
function partOptions(
  options: UploadOptions | undefined,
  part: Part,
  report: (index: number, loaded: number) => void,
): UploadOptions {
  return {
    ...(options?.signal ? { signal: options.signal } : {}),
    ...(options?.onProgress
      ? { onProgress: (progress: UploadProgress) => report(part.index, progress.loaded) }
      : {}),
  };
}

/**
 * Turn per-part byte counts into ONE report about the file.
 *
 * A caller drawing a bar wants the file's progress, and the parts are in flight at
 * once — so the bar is the SUM of what each part has sent, which is why each
 * part's own loaded count is kept rather than added. A part that restarts subtracts
 * itself by being reset to zero.
 */
function partReporter(
  total: number,
  count: number,
  onProgress: ((progress: UploadProgress) => void) | undefined,
): (index: number, loaded: number) => void {
  const loaded = new Array<number>(count).fill(0);
  if (!onProgress) return () => undefined;
  // Once at zero before anything is sent, the same promise the single-request path
  // makes: a bar exists from the moment the upload starts.
  onProgress({ loaded: 0, total, fraction: 0 });
  return (index, sent) => {
    loaded[index] = sent;
    const done = loaded.reduce((sum, part) => sum + part, 0);
    onProgress({ loaded: done, total, fraction: Math.min(1, done / total) });
  };
}

/**
 * Run `work` over every item with at most `limit` in flight.
 *
 * A fixed pool of workers pulling from a shared cursor, rather than
 * `Promise.all` over batches: a batch is only as fast as its slowest member, so a
 * pool keeps every connection busy while one part is finishing. The first failure
 * rejects, and the parts already in flight settle without being awaited — the
 * upload is over either way, and the caller's `signal` is what stops them early.
 */
async function inParallel<T>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let at = next++; at < items.length; at = next++) {
      const item = items[at];
      if (item !== undefined) await work(item);
    }
  };
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker);
  await Promise.all(workers);
}
