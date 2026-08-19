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
 * ## The bytes may not come to the agent at all
 *
 * On the managed platform they do not. A deployed guest holds no bucket credential,
 * so it reaches an upload's bytes through a route the PLATFORM serves — and a part
 * sent to the agent would cross that platform twice on its way to the same bucket,
 * through a forward that measures a body's drain to decide whether the guest is
 * alive. So the claim answers `directParts: true`, and each window goes
 * `PUT <origin>/<slug>/uploads/<id>/<offset>` followed by a bodyless
 * `PUT …/parts?offset=…&stored=1` telling the agent which window landed.
 *
 * Two properties make that safe to be the ordinary path rather than an option:
 *
 * - **The CLAIM decides, not the client.** `aai dev` and a self-hosted server hold
 *   the credential themselves and serve no such route, so they answer without the
 *   field and the bytes come to them — as does an agent deployed before any of this
 *   existed. A client that guessed from its own URL would send 8 MiB into a 404.
 * - **The agent still measures the part.** `stored=1` carries an offset and no size:
 *   the store asks the bucket how big the object is before it records the window, so
 *   a client cannot advance `size` past a hole however it got there.
 *
 * Everything else about the fan-out is unchanged — the same windows, the same
 * concurrency, the same retry budget, the same resume — because the RECORD is still
 * the agent's and it is what `size`, `complete` and `ranges` come from.
 *
 * ## This is the DEFAULT, and it degrades to the single request
 *
 * Three things make this path decline rather than fail, because none of them is
 * worth an error a caller has to handle — which is also what makes it safe to be
 * the default rather than something a caller opts into (`partsSettings`):
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
 * speed — so a failed part is re-sent (`UPLOAD_PART_ATTEMPTS`) and the store
 * accepts the repeat as the same part rather than as a duplicate. What is NOT
 * retried is a part the agent REFUSED: a 400 (the offset contradicts the declared
 * total), a 409, a 413 are all requests that will be refused again, and retrying
 * them is a loop the caller pays for twice.
 *
 * **The WAIT between attempts is half of that**, and it was missing: a re-send
 * went out immediately, so a fan-out that hit a capacity limit together asked
 * again together, microseconds later, and spent its whole budget inside the window
 * it was supposed to be waiting out. `retryDelay` honours `Retry-After` first —
 * the far side's own number, which is what makes a burst DRAIN rather than
 * re-collide — and otherwise backs off exponentially with jitter.
 *
 * The same treatment covers the two requests that BRACKET the fan-out, which were
 * bare `fetch` calls with no retry at all: losing the claim wastes a round trip,
 * and losing the closing `/info` read threw away a file whose every byte was
 * already stored.
 *
 * **A 5xx is not a refusal, and reading every answer as one cost a real upload.**
 * The platform's own vocabulary for "come back" is a status: a sandbox that is
 * booting, draining or momentarily unreachable is a 503, and "Server busy — retry
 * shortly" is a 503 that says so in words. Retrying a transport rejection while
 * treating those as final meant one aborted forward — a proxy deadline, in the
 * case this was written for — ended the whole fan-out; the contiguous prefix
 * froze at the three parts that had landed, and the run watching that upload
 * failed five minutes later with `the uploader stopped`. So
 * a "come back" status is re-sent on the same budget as a dropped connection,
 * which is what it is — `_upload-retry.ts` owns that vocabulary.
 */

import { withRetries } from "./_upload-retry.ts";
import { WORKFLOW_API_PREFIX } from "./_workflow-api-envelope.ts";
import { mapConcurrent } from "./map-concurrent.ts";
import { omitUndefined } from "./omit-undefined.ts";
import { readJsonBody } from "./response-body.ts";
import type { UploadInfo, UploadRange } from "./step-uploads.ts";
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

/**
 * The settings this upload runs with, or nothing when the caller opted OUT.
 *
 * Absent means ON, which is the one thing about this module that is a policy
 * rather than a mechanism. It was opt-in while the path was new, and what that
 * left in place was a default that is both slower and less recoverable than the
 * alternative: the single-request writers have no retry at all and cannot have
 * one — a `POST` retried after a lost response mints a SECOND upload, and a `PUT`
 * retried against its own id is refused as taken — so every failure on the
 * default path cost the whole file, at whatever a single connection could carry.
 * Everything that makes this path decline is a property of the file or of the
 * agent (see the module doc), so turning it on by default costs nothing where it
 * would not have helped.
 */
export function partsSettings(
  parallel: UploadParallel | undefined,
): UploadPartsSettings | undefined {
  if (parallel === false) return undefined;
  return parallel === undefined || parallel === true ? {} : parallel;
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
  /** The windows to send, as {@link partsPlan} worked them out. */
  plan: UploadPartsPlan;
};

/** A file's total and the windows it was cut into. */
export type UploadPartsPlan = { total: number; parts: Part[] };

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

/**
 * How this file would be cut, or `undefined` when the parts path declines it.
 *
 * SYNCHRONOUS, and separate from {@link uploadInParts} for that reason alone: two
 * of the three reasons to decline are properties of the file, so deciding them
 * before anything is awaited keeps a small upload's first request in the same tick
 * as the call — the third reason (an agent with no `/parts` routes) is an ANSWER
 * and necessarily costs a round trip.
 */
export function partsPlan(
  file: UploadBody,
  settings: UploadPartsSettings,
): UploadPartsPlan | undefined {
  const total = sliceableBytes(file);
  if (total === undefined) return undefined;
  const parts = planParts(total, settings.partBytes ?? UPLOAD_PART_BYTES);
  // One part is the single request with two extra round trips in front of it.
  if (parts.length < 2) return undefined;
  return { total, parts };
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
 * Where the PLATFORM serves an upload's bytes, given the workflow API's own base.
 *
 * `…/<slug>/workflows` → `…/<slug>/uploads`, i.e. one segment across rather than one
 * level up: both routes hang off the same agent prefix, and the base is the only
 * thing in this client that knows what that prefix is (it may be an origin, a path
 * under one, or a `/:slug` on the platform).
 *
 * `undefined` when the base does not end in the API prefix, which is a base composed
 * by something other than this client. Declining is the conservative half: sending
 * bytes to a URL guessed from a shape nobody recognises is exactly the 404 the
 * capability flag exists to prevent.
 */
export function directBytesBase(base: string): string | undefined {
  const trimmed = base.replace(/\/+$/, "");
  if (!trimmed.endsWith(WORKFLOW_API_PREFIX)) return undefined;
  return `${trimmed.slice(0, -WORKFLOW_API_PREFIX.length)}/uploads`;
}

/**
 * Store one file as concurrent parts, or resolve `undefined` to say this path
 * declined.
 *
 * `undefined` is not a failure and every one of its causes is in the module doc;
 * the caller answers it by sending the file the ordinary way.
 */
export async function uploadInParts(req: UploadPartsRequest): Promise<UploadRef | undefined> {
  const { total, parts } = req.plan;

  const uploads = `${req.base}/uploads/${encodeURIComponent(req.id)}`;
  // The first failure ends the upload, so every part still in flight is bytes
  // nobody will read — on a link the person is waiting on, and against a store
  // that has to write them. `AbortSignal.any` rather than bookkeeping, and the
  // caller's own signal is folded in here so exactly one signal reaches the
  // requests.
  const failed = new AbortController();
  const signal = req.options?.signal
    ? AbortSignal.any([req.options.signal, failed.signal])
    : failed.signal;
  const options: UploadOptions = { ...req.options, signal };
  const attempts = UPLOAD_PART_ATTEMPTS;

  const { res: begun, attempts: claims } = await withRetries(
    () =>
      fetch(`${uploads}/parts?name=${encodeURIComponent(req.name)}&total=${total}`, {
        method: "POST",
        headers: { ...req.headers, "Content-Type": req.type },
        signal,
      }),
    { attempts, signal },
  );
  // An older agent, and the file has not moved yet — so this costs one round trip
  // and the caller falls back.
  if (NO_SUCH_ROUTE.has(begun.status)) return undefined;
  // A 409 says the id is already claimed, and on a FIRST attempt that is exactly
  // what it sounds like — the store refusing a second upload into somebody else's
  // id, which is what makes a caller-chosen id safe. Two things make it OURS: a
  // LATER attempt, since the claim we retried is the one that took the id and only
  // its answer was lost (failing there would throw away a whole file for a dropped
  // response); or a caller that said it is RESUMING, which is a claim about an id
  // it already owns.
  const begunAlready = begun.status === 409 && (claims > 1 || req.options?.resume === true);
  if (!(begun.ok || begunAlready)) throw await req.fail(begun);

  // Where the bytes go, decided by the CLAIM — see the module doc. A 409'd claim
  // carries no body to read the flag from, so a resume reads it off the record
  // instead of assuming: an upload begun on the direct path is finished on it.
  const claimed = begun.ok
    ? await readJsonBody<{ directParts?: boolean }>(begun, "Workflow API").catch(
        () => ({}) as { directParts?: boolean },
      )
    : {};
  const bytesBase = claimed.directParts === true ? directBytesBase(req.base) : undefined;

  // What is already stored, so a resume sends the windows that are MISSING rather
  // than the file. Only asked for when the claim says the upload already existed —
  // a fresh one has nothing in it, and this is a round trip.
  const landed = begunAlready ? await storedRanges(req, uploads, signal, attempts) : undefined;
  const missing = landed ? parts.filter((part) => !covers(landed, part)) : parts;

  const report = partReporter(total, parts.length, req.options?.onProgress);
  // A skipped part is a part the BAR should already be past: a resume that started
  // its progress at zero would report a nearly-finished file as barely begun.
  for (const part of parts) {
    if (!missing.includes(part)) report(part.index, part.end - part.start);
  }
  const sendPart = async (part: Part): Promise<void> => {
    // Where the bytes go. The whole window is retried as ONE unit even on the direct
    // path, and it has to be: a stored object that was never recorded is an orphan
    // nothing reads, so re-sending the bytes and re-recording them is the only repair
    // that leaves the record and the bucket agreeing.
    const target = bytesBase
      ? `${bytesBase}/${encodeURIComponent(req.id)}/${part.start}`
      : `${uploads}/parts?offset=${part.start}`;
    const { res } = await withRetries(
      () => {
        // Reset before every attempt, so a retried part does not leave the bytes of
        // its failed try counted in the total.
        report(part.index, 0);
        return req.send(
          "PUT",
          target,
          // No auth headers on the direct path: it is the PLATFORM's route, and the
          // agent's own `AAI_WORKFLOW_API_TOKEN` means nothing there. Sending them
          // would leak the agent's bearer to a surface that never checks it.
          bytesBase ? { "Content-Type": req.type } : { ...req.headers, "Content-Type": req.type },
          sliceOf(req.file, part.start, part.end),
          partOptions(options, part, report),
        );
      },
      { attempts, signal },
    );
    if (!res.ok) throw await req.fail(res);
    // The window is in the bucket and the agent has not heard. Recorded as its own
    // retried request, because the two failures are different: the bytes are already
    // stored, so a lost receipt costs one small request rather than the window.
    if (bytesBase) {
      const { res: recorded } = await withRetries(
        () =>
          fetch(`${uploads}/parts?offset=${part.start}&stored=1`, {
            method: "PUT",
            headers: req.headers,
            signal,
          }),
        { attempts, signal },
      );
      if (!recorded.ok) throw await req.fail(recorded);
    }
    report(part.index, part.end - part.start);
  };

  // `mapConcurrent` rather than a pool written here, and it is the SDK's own — a
  // window over a cursor with exactly the semantics this needs, including the one
  // the local copy got wrong: a rejection stops the other slots taking new items,
  // where the local pool kept them pulling from the cursor and relied on the abort
  // below to make each new request fail on arrival.
  await mapConcurrent(
    missing,
    req.settings.concurrency ?? UPLOAD_PART_CONCURRENCY,
    async (part) => {
      try {
        await sendPart(part);
      } catch (err: unknown) {
        // Before re-throwing, so the parts already ON THE WIRE stop too — stopping
        // the window is not the same as abandoning the requests it has issued.
        failed.abort(err);
        throw err;
      }
    },
  );
  // The record as the agent has it, rather than one assembled here: `complete` is
  // the agent's own answer about whether every byte landed, which is the one claim
  // this path must not make on its behalf. Retried like everything else on this
  // path — every byte is already stored by the time it is asked, so losing the
  // file to a dropped read of the receipt is the cheapest failure to prevent here.
  const { res: stored } = await withRetries(
    () => fetch(`${uploads}/info`, { headers: req.headers, signal }),
    { attempts, signal },
  );
  if (!stored.ok) throw await req.fail(stored);
  const info = await readJsonBody<Omit<UploadRef, "url">>(stored, "Workflow API");
  return { ...info, url: uploads };
}

/**
 * The windows already stored under this id.
 *
 * `complete` first, because a finished upload publishes no ranges — see
 * `UploadInfo.ranges` — and reading that absence as "nothing has landed" would
 * re-send a file that is entirely there. An agent too old to report ranges at all
 * answers the same way an empty upload does, so a resume against one degrades to
 * sending the whole file rather than to a hole.
 */
async function storedRanges(
  req: UploadPartsRequest,
  uploads: string,
  signal: AbortSignal,
  attempts: number,
): Promise<readonly UploadRange[]> {
  const { res } = await withRetries(
    () => fetch(`${uploads}/info`, { headers: req.headers, signal }),
    { attempts, signal },
  );
  if (!res.ok) throw await req.fail(res);
  const info = await readJsonBody<UploadInfo>(res, "Workflow API");
  return info.complete ? [{ start: 0, end: info.size }] : (info.ranges ?? []);
}

/** Whether one window is wholly inside what has landed. */
function covers(landed: readonly UploadRange[], part: Part): boolean {
  return landed.some((range) => range.start <= part.start && range.end >= part.end);
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
    ...omitUndefined({ signal: options?.signal }),
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
