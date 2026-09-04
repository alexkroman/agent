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
 * On the platform they do not: a deployed guest holds no bucket credential, so a part
 * sent to it would cross the platform twice to reach the same bucket. The claim answers
 * `directParts: true` and each window goes `PUT <origin>/<slug>/uploads/<id>/<offset>`
 * followed by a bodyless `PUT …/parts?offset=…&stored=1` naming the window that landed.
 * `aai-server/upload-handler.ts` and `aai/host/_upload-blobs.ts` carry the argument.
 *
 * Two properties make that the ordinary path rather than an option. **The CLAIM
 * decides** — `aai dev`, a self-hosted server and an agent deployed before this all
 * answer without the field, and a client guessing from its own URL would send 8 MiB
 * into a 404. And **the agent still measures the part**: `stored=1` carries an offset
 * and no size, so a client cannot advance `size` past a hole however it got there.
 * Everything else is unchanged, because the RECORD is still the agent's.
 *
 * ## This is the DEFAULT, and it degrades to the single request
 *
 * Two things make this path decline rather than fail, because neither is
 * worth an error a caller has to handle — which is also what makes it safe to be
 * the default rather than something a caller opts into (`partsSettings`):
 *
 * - **A body that cannot be cut by BYTE.** A `Blob` and an `ArrayBuffer` slice
 *   exactly; a `string` does not — its byte length is its UTF-8 encoding's, so
 *   cutting it by character would put a part boundary inside a code point.
 * - **A file that fits in one part**, for `upload` only. There is nothing to
 *   parallelize, and the `POST`+`PUT` pair would be strictly more requests than
 *   the single call. `uploadStream` takes the path anyway, because for a
 *   CALLER-NAMED id the path buys resumability rather than speed and a one-part
 *   file needs that as much as any other — `_upload-parts-plan.ts`'s module doc
 *   carries the rule.
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

import { createClaimer } from "./_upload-claims.ts";
import type { Part, UploadPartsPlan } from "./_upload-parts-plan.ts";
import { createPartSender, type SendPart, sendEveryPart } from "./_upload-parts-send.ts";
import { withRetries } from "./_upload-retry.ts";
import { WORKFLOW_API_PREFIX } from "./_workflow-api-envelope.ts";
import { readJsonBody } from "./response-body.ts";
import type { UploadInfo, UploadRange } from "./step-uploads.ts";
import { UPLOAD_PART_ATTEMPTS, UPLOAD_PART_CONCURRENCY } from "./upload-constants.ts";
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
// Re-exported rather than moved out of the import surface: `partsPlan` is what
// `workflow-upload-client.ts` calls, and `planParts` is what the specs pin. The
// split above is a file-size seam, not an API change.
export { partsPlan, planParts, type UploadPartsPlan } from "./_upload-parts-plan.ts";

/**
 * The two capability fields a DEPLOYMENT answers with — see `UploadCreated`.
 *
 * Read off the claim on a fresh upload and off `…/info` on a resume, because a 409
 * has no body. Both routes answer the same pair for the same reason: they describe
 * where an upload's bytes go and how its receipts may be batched, and neither is a
 * property of the FILE.
 */
type UploadCapability = { directParts?: boolean; claimBatch?: number };

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
 * What the DEPLOYMENT can do, and what this upload still owes — resolved together
 * because on a resume they come from the same request.
 *
 * Its own function because `uploadInParts` is at the cognitive-complexity cap and
 * this is the part of it with one subject: reconciling a claim's answer, a 409's
 * silence, and the record.
 */
async function openedUpload(ctx: {
  req: UploadPartsRequest;
  begun: Response;
  /** Whether the 409 is OURS — see the caller. */
  begunAlready: boolean;
  uploads: string;
  signal: AbortSignal;
  attempts: number;
  parts: readonly Part[];
}): Promise<{ bytesBase: string | undefined; claimBatch: number; missing: readonly Part[] }> {
  const { req, begun, begunAlready, uploads, signal, attempts, parts } = ctx;
  const claimed = begun.ok
    ? await readJsonBody<UploadCapability>(begun, "Workflow API").catch(
        () => ({}) as UploadCapability,
      )
    : {};

  // What is already stored, so a resume sends the windows that are MISSING rather
  // than the file. Only asked for when the claim says the upload already existed — a
  // fresh one has nothing in it, and this is a round trip.
  const resumed = begunAlready ? await storedRanges(req, uploads, signal, attempts) : undefined;

  // Where the bytes go, decided by the CLAIM — see the module doc. **A 409'd claim
  // carries no body to read the flag from, so a resume reads it off the RECORD.**
  // The module doc described exactly that for a while and the code did not do it:
  // this was `{}` on the 409 path, so every resumed upload silently abandoned the
  // direct path and sent its bytes to the agent — which works, and is the topology
  // this path exists to avoid, and which the platform's forward measures as a
  // stalled guest.
  const capability = begun.ok ? claimed : (resumed?.capability ?? {});
  return {
    bytesBase: capability.directParts === true ? directBytesBase(req.base) : undefined,
    claimBatch: claimBatchOf(capability.claimBatch),
    missing: resumed ? parts.filter((part) => !covers(resumed.ranges, part)) : parts,
  };
}

/**
 * How many landed offsets one claim may name, as the AGENT answered — never this
 * SDK's own constant.
 *
 * Absent is the ordinary answer from a deployment that does not serve the direct
 * path, and the value arrives in a JSON body — so anything that is not a whole
 * number above one (absent, `1`, a float, a string) means one offset per claim.
 * Batching against an agent that reads a single `?offset=` records the first
 * window, answers 200, and leaves the rest as holes that read as silence in a step
 * much later.
 */
function claimBatchOf(advertised: number | undefined): number {
  return Number.isInteger(advertised) && (advertised ?? 0) > 1 ? (advertised ?? 1) : 1;
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
  // A 409 says the id is already claimed, and on a FIRST attempt that is exactly
  // what it sounds like — the store refusing a second upload into somebody else's
  // id, which is what makes a caller-chosen id safe. Two things make it OURS: a
  // LATER attempt, since the claim we retried is the one that took the id and only
  // its answer was lost (failing there would throw away a whole file for a dropped
  // response); or a caller that said it is RESUMING, which is a claim about an id
  // it already owns.
  const begunAlready = begun.status === 409 && (claims > 1 || req.options?.resume === true);
  if (!(begun.ok || begunAlready)) throw await req.fail(begun);

  const { bytesBase, claimBatch, missing } = await openedUpload({
    req,
    begun,
    begunAlready,
    uploads,
    signal,
    attempts,
    parts,
  });

  const claimer = createClaimer({
    uploads,
    headers: req.headers,
    batch: claimBatch,
    attempts,
    signal,
    fail: req.fail,
    // A claim that will not land makes every window it named an orphan, so the
    // windows still going are bytes nobody will read — the same abort a failed part
    // takes, for the same reason.
    onFail: (err) => failed.abort(err),
  });

  const report = partReporter(total, parts.length, req.options?.onProgress);
  // A skipped part is a part the BAR should already be past: a resume that started
  // its progress at zero would report a nearly-finished file as barely begun.
  for (const part of parts) {
    if (!missing.includes(part)) report(part.index, part.end - part.start);
  }
  const sendPart = createPartSender({
    req,
    bytesBase,
    uploads,
    options,
    attempts,
    signal,
    report,
    claimer,
  });

  // `mapConcurrent` rather than a pool written here, and it is the SDK's own — a
  // window over a cursor with exactly the semantics this needs, including the one
  // the local copy got wrong: a rejection stops the other slots taking new items,
  // where the local pool kept them pulling from the cursor and relied on the abort
  // below to make each new request fail on arrival.
  await sendEveryPart({
    missing,
    width: req.settings.concurrency ?? UPLOAD_PART_CONCURRENCY,
    sendPart,
    failed,
    claimer,
  });
  // Before the closing read, and this is the ordering the whole batched path rests
  // on: `/info` is what decides the upload is complete, and a claim still in the air
  // is a window the agent has not recorded yet. Draining here is also what surfaces
  // a claim that failed after its window's bytes had already been reported.
  await claimer.drain();
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
  assertRecorded(info, req.id, total);
  return { ...info, url: uploads };
}

/**
 * Refuse a record that does not hold the file, after every window was acknowledged.
 *
 * The agent's own `complete` is the reason the closing read exists, and ignoring it
 * made every failure in the record-keeping path SILENT. Every window has been sent
 * and 2xx'd by the time this runs, so an incomplete record does not mean a dropped
 * part — it means the agent did not record what it acknowledged, and the caller is
 * about to start a run over a file that reads as empty.
 *
 * That is exactly what shipped. A `Content-Length` the platform's proxy removed from
 * a body-less `HEAD` made the store measure every window as zero bytes (see
 * `host/_upload-blobs.ts`'s `contentLength`), so a 660 MB recording was reported here
 * as stored while the record said `size: 0` — and the run then failed on a header
 * probe that came back empty, minutes later and in a different component.
 */
function assertRecorded(info: Omit<UploadRef, "url">, id: string, total: number): void {
  if (info.complete) return;
  throw new UploadNotRecordedError(
    `Workflow API: upload ${id} stored every part but reports ${info.size} of ` +
      `${total} byte(s) and is not complete. The agent acknowledged each window and ` +
      "then did not record it, so nothing can read this upload.",
  );
}

/**
 * The one failure on this path that RE-SENDING cannot repair.
 *
 * Its own type because `_upload-resume.ts` has to tell it apart, and it is the
 * exception to that module's rule: every other failure here is the far side being
 * away, where sending the missing windows again is exactly the remedy. This one
 * says the windows all arrived and the agent recorded none of them — so a resume
 * reads the ranges, finds nothing, and re-sends the WHOLE file into the same
 * defect, once per round. On the 660 MB recording that found this bug that is
 * four uploads of it to reach the same sentence.
 */
export class UploadNotRecordedError extends Error {
  override readonly name = "UploadNotRecordedError";
}

/**
 * The windows already stored under this id.
 *
 * `complete` first, because a finished upload publishes no ranges — see
 * `UploadInfo.ranges` — and reading that absence as "nothing has landed" would
 * re-send a file that is entirely there. A store that declines to report windows
 * answers the same way an empty upload does, so a resume against one degrades to
 * sending the whole file rather than to a hole.
 */
async function storedRanges(
  req: UploadPartsRequest,
  uploads: string,
  signal: AbortSignal,
  attempts: number,
): Promise<{ ranges: readonly UploadRange[]; capability: UploadCapability }> {
  const { res } = await withRetries(
    () => fetch(`${uploads}/info`, { headers: req.headers, signal }),
    { attempts, signal },
  );
  if (!res.ok) throw await req.fail(res);
  const info = await readJsonBody<UploadInfo & UploadCapability>(res, "Workflow API");
  return {
    ranges: info.complete ? [{ start: 0, end: info.size }] : (info.ranges ?? []),
    // The record answers the same two capability fields the claim does, precisely so
    // this read can serve the 409 the claim answered with nothing.
    capability: info,
  };
}

/** Whether one window is wholly inside what has landed. */
function covers(landed: readonly UploadRange[], part: Part): boolean {
  return landed.some((range) => range.start <= part.start && range.end >= part.end);
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
