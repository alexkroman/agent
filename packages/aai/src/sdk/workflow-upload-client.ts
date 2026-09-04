// Copyright 2026 the AAI authors. MIT license.
/**
 * The client half of the `/workflows/uploads` routes.
 *
 * Its own module rather than another method body inside
 * `workflow-api-client.ts`, because it is the one call on that surface that is
 * not JSON in and JSON out: the body is a file, the metadata rides in the query
 * and the header, and the deadline rules are different (a 200 MB recording
 * legitimately takes minutes, where every other route is a round trip).
 *
 * Why an upload exists at all is in `sdk/step-uploads.ts`: a run's input is
 * journaled and replayed, so bytes may not travel in it.
 *
 * ## Two writers, and the difference is who names the upload
 *
 * `uploadFile` POSTs and is answered with an id once the last byte is stored —
 * which is all a `POST` can honestly do, and it means a form needing that id in a
 * run input has to wait for the whole upload. `streamUploadFile` PUTs to an id the
 * CALLER chose, so the id exists before the bytes leave: start the run, then send
 * the file, and the run reads what has arrived. `readUploadInfo` is how anything
 * that is not a step watches that happen.
 *
 * Both go through the same transport, the same headers and the same failures. The
 * only thing that differs is the method and the URL, which is why they share
 * `sendUpload` rather than being two request builders.
 *
 * ## Why there are TWO transports here
 *
 * It is also the one call slow enough that a page has to say how far it has got,
 * and **`fetch` cannot report that**: a request body is not observable, and the
 * streaming request form (`duplex: "half"`) is one engine's extension that
 * rejects outright on the others. So a call that passes
 * {@link UploadOptions.onProgress} goes through `XMLHttpRequest`, whose
 * `upload.progress` event has reported bytes-sent since long before any of this,
 * and every other call stays on `fetch`. The XHR answer is turned back into a
 * `Response` at the boundary, so exactly one error vocabulary and one JSON guard
 * sit above both paths — the alternative is two ways for this route to describe
 * the same 413. That transport is `_upload-progress.ts`.
 *
 * ## And a THIRD shape, which is several of the first
 *
 * `UploadOptions.parallel` cuts the file up and sends the windows at once. It is
 * not a fourth transport — every part goes through `sendUpload` below, on
 * whichever of the two the options call for — so what `workflow-upload-parts.ts`
 * owns is the plan, the pool and the one aggregate report over them.
 */

import { progressOf, sendViaXhr, uploadXhrClass } from "./_upload-progress.ts";
import { withResumes } from "./_upload-resume.ts";
import { readApiJson } from "./_workflow-api-envelope.ts";
import { invariant } from "./invariant.ts";
import { omitUndefined } from "./omit-undefined.ts";
import type { UploadInfo } from "./step-uploads.ts";
import { UPLOAD_TOKEN_RE } from "./upload-constants.ts";
import {
  partsPlan,
  partsSettings,
  type UploadParallel,
  type UploadPartsRequest,
  uploadInParts,
} from "./workflow-upload-parts.ts";

/** What an upload call accepts as the file's bytes. */
export type UploadBody = Blob | ArrayBuffer | ArrayBufferView | string;

/**
 * How far an upload has got, as {@link UploadOptions.onProgress} reports it.
 *
 * @public
 */
export type UploadProgress = {
  /** Bytes handed to the network so far. */
  loaded: number;
  /**
   * The body's size, when it is knowable. Undefined for a body whose length the
   * transport cannot state up front, which is the case a bar has to render as
   * indeterminate rather than as empty.
   */
  total: number | undefined;
  /**
   * `loaded / total`, clamped to `0..1` — the number a bar's width IS, so no
   * caller divides and none has to guard the zero-byte body that would divide
   * to `NaN` and render as a bar of no width labelled `NaN%`.
   *
   * Undefined exactly when {@link UploadProgress.total} is.
   */
  fraction: number | undefined;
};

/** Options for an upload. */
export type UploadOptions = {
  /** Filename to store. Defaults to a `File`'s own `name`, else `""`. */
  name?: string | undefined;
  /** MIME type to store. Defaults to a `Blob`'s own `type`, else octet-stream. */
  type?: string | undefined;
  /**
   * Abort the upload. Its own option rather than the client's `timeoutMs`,
   * which is sized for a JSON round trip: a large file legitimately takes
   * minutes, and a deadline that cannot tell those apart cancels the one thing
   * on this surface that is expensive to redo.
   */
  signal?: AbortSignal | undefined;
  /**
   * Called as the bytes leave, so a page can draw a progress bar over the one
   * call on this surface slow enough to need one.
   *
   * It fires at least twice: once at `0` before anything is sent, so a bar
   * exists from the moment the request leaves rather than from whenever the
   * first chunk clears, and once at the end, so a bar cannot be left stopped
   * short of full by a transport whose last chunk report raced the response.
   *
   * **Asking for it changes the transport, and only where that is possible.**
   * See this module's doc: byte-level progress means `XMLHttpRequest`, and where
   * there is none (Node, a worker without it) the call stays on `fetch` and the
   * reports degrade to the two ends — sending, then sent. Nothing else differs:
   * same URL, same headers, same failures.
   */
  onProgress?: ((progress: UploadProgress) => void) | undefined;
  /**
   * Cut the file up and send the pieces at once, instead of in one request.
   *
   * **On by default.** `false` opts out, `{ partBytes, concurrency }` tunes it.
   * What it buys is the difference between one connection's throughput and the
   * link's: a single request is bounded by its congestion window over the
   * round-trip time, so the further away the agent is the smaller a fraction of
   * the available bandwidth one request can use, and a recording is exactly the
   * body big enough for that to be the wait a person is sitting through. It is
   * also the only path here that can RETRY — see `partsSettings` for why the
   * single-request writers cannot.
   *
   * It degrades rather than failing: a body that cannot be cut by byte (a
   * string), a file that fits in one part, or an agent deployed before the
   * `/parts` routes existed all send the file the ordinary way instead. So the
   * default does nothing where it would not have helped, and opting out is for a
   * caller who knows something about their own link that this does not.
   * `workflow-upload-parts.ts` carries the rest.
   */
  parallel?: UploadParallel | undefined;
  /**
   * Continue an upload already begun under this id, sending only the windows that
   * are missing.
   *
   * What it buys is the difference between resuming a recording and starting it
   * over. Without it a second attempt at an id is REFUSED — which is the rule that
   * makes a caller-chosen id safe, since nothing else stops one upload writing into
   * another's — so this is how a caller says the id is its own.
   *
   * **A transient failure needs no flag: this call re-enters itself.** A round
   * that fails for a reason that looks like an outage is retried with the resume
   * already set, up to `UPLOAD_RESUME_ATTEMPTS` (see `_upload-resume.ts`, which
   * carries what "looks like an outage" excludes). So this option is for a
   * SEPARATE call against an id the caller already owns — the round after a pause,
   * a second submit of a form the person interrupted — and not for retrying.
   *
   * Only the parts path can do it, and the store is what makes it safe: a part's
   * rows are keyed by the offset it starts at, so re-sending one is writing the
   * same bytes to the same place. The windows already stored come from
   * `UploadInfo.ranges`, and an agent too old to report them re-sends the whole
   * file rather than leaving a hole.
   *
   * The bytes must be the SAME FILE. Nothing here can check that — the id is a
   * capability and the offsets are the caller's contract — so a resume with a
   * different file is a corrupted upload only its owner can read.
   */
  resume?: boolean | undefined;
};

export type { UploadParallel, UploadPartsSettings } from "./workflow-upload-parts.ts";

/** A stored upload, as `WorkflowApi.upload` resolves it. */
export type UploadRef = {
  /** The handle a run input carries. */
  id: string;
  /** Filename as stored. */
  name: string;
  /** MIME type as stored. */
  type: string;
  /** Size in bytes. */
  size: number;
  /** Whether every byte is in — always true for a call that resolved. */
  complete: boolean;
  /** Absolute URL the bytes can be read back from, `Range` included. */
  url: string;
};

/**
 * The body's size in bytes, where asking is free.
 *
 * A string is deliberately UNKNOWN: its byte length is its UTF-8 encoding's, and
 * measuring that means encoding the whole thing a second time to draw a bar. The
 * transport knows it anyway — XHR reports `lengthComputable` totals for a string
 * body — so this is the fallback path's answer, not the only one.
 */
function bodyBytes(file: UploadBody): number | undefined {
  if (typeof file === "string") return undefined;
  if (file instanceof ArrayBuffer) return file.byteLength;
  if (ArrayBuffer.isView(file)) return file.byteLength;
  // Read rather than guarded by `instanceof Blob`: a `File` handed over from
  // another realm (an iframe, a worker) fails an instance check while carrying a
  // perfectly good size, and anything with none reports an unknown total.
  const size: unknown = file.size;
  return typeof size === "number" ? size : undefined;
}

/**
 * Issue the request, on whichever transport the options call for.
 *
 * Both paths end at a full bar: XHR's last event usually says so already, and
 * `fetch`'s answer is proof the whole body went. Reporting it here rather than
 * per path is what stops a bar resting at 99% on one of them.
 */
async function sendUpload(
  method: "POST" | "PUT",
  url: string,
  headers: Record<string, string>,
  file: UploadBody,
  options: UploadOptions | undefined,
): Promise<Response> {
  const signal = options?.signal;
  // `NonNullable` because `exactOptionalPropertyTypes` reads the property's own
  // `| undefined` as a value this may be, and a body is exactly what an upload
  // always has.
  const body = file as NonNullable<RequestInit["body"]>;
  // `omitUndefined` is this repo's one spelling of an optional field
  // (`guard-invariants` rule 2), and it is the same one
  // `workflow-api-client.ts` uses for this exact key.
  const init: RequestInit = { method, headers, body, ...omitUndefined({ signal }) };
  const onProgress = options?.onProgress;
  if (!onProgress) return await fetch(url, init);

  const total = bodyBytes(file);
  let sent = 0;
  const report = (progress: UploadProgress): void => {
    sent = progress.loaded;
    onProgress(progress);
  };
  report(progressOf(0, total));
  const Xhr = uploadXhrClass();
  const res = Xhr
    ? await sendViaXhr(Xhr, method, url, headers, file, total, report, signal)
    : await fetch(url, init);
  report(progressOf(total ?? sent, total));
  return res;
}

/**
 * The name and type to store: what the caller said, else what the file says.
 *
 * One helper because the two writers below had it letter for letter, and a parts
 * upload adds a THIRD reader — the metadata has to be the same whichever route
 * carries the bytes, or the same file stores under two different names depending
 * on how fast the link was.
 */
function describeUpload(
  file: UploadBody,
  options: UploadOptions | undefined,
): { name: string; type: string } {
  // A `File` already knows both; anything else says so or gets the defaults.
  const described = file as { name?: unknown; type?: unknown };
  return {
    name: options?.name ?? (typeof described.name === "string" ? described.name : ""),
    type:
      options?.type ??
      (typeof described.type === "string" && described.type
        ? described.type
        : "application/octet-stream"),
  };
}

/**
 * An id for an upload this module names itself.
 *
 * A hyphenless `crypto.randomUUID()`, which satisfies {@link UPLOAD_TOKEN_RE} by
 * construction — asserted rather than assumed, because the store answers a bad one
 * with a 400 and this is the one id no caller can see to correct.
 */
function newClientUploadId(): string {
  const id = crypto.randomUUID().replaceAll("-", "");
  // The doc above says "asserted rather than assumed", and this is the assert:
  // the grammar and the minter are both ours, so a miss is our bug and not an
  // upload error the caller could act on.
  invariant(UPLOAD_TOKEN_RE.test(id), "upload.id.minted", () => ({ id }));
  return id;
}

/**
 * Run the parts path to completion across resume rounds.
 *
 * The two entry points below differ in exactly two things — where the id comes
 * from, and whether the FIRST round counts as a resume. Everything else (the
 * eleven fields {@link uploadInParts} takes, threading each round's `resume`
 * through the options, and lifting the signal for the backoff) was written out
 * twice, so a field added to `UploadPartsRequest` had two call sites to reach
 * and one of them would be found by a test.
 *
 * Answers `undefined` when the parts path declined, exactly as `uploadInParts`
 * does — the file has not moved and the caller falls through to the single-body
 * route.
 */
function storeInParts(
  req: Omit<UploadPartsRequest, "send">,
  firstResume: boolean | undefined,
): Promise<UploadRef | undefined> {
  return withResumes(
    (round) =>
      uploadInParts({
        ...req,
        send: sendUpload,
        options: { ...req.options, resume: round.resume },
      }),
    { resume: firstResume, ...omitUndefined({ signal: req.options?.signal }) },
  );
}

/**
 * Store one file against an already-resolved API base.
 *
 * @param base - The API root (`…/workflows`), as the client resolved it.
 * @param headers - Auth headers, if the API is closed.
 * @param fail - How the caller turns a failed response into an error, so this
 *   module does not own a second error vocabulary.
 * @internal
 */
export async function uploadFile(
  base: string,
  headers: Record<string, string>,
  fail: (res: Response) => Promise<Error>,
  file: UploadBody,
  options?: UploadOptions,
): Promise<UploadRef> {
  const { name, type } = describeUpload(file, options);
  const settings = partsSettings(options?.parallel);
  // Decided before anything is awaited, so a file the parts path will not take is
  // sent in the same tick as the call rather than a microtask later.
  const plan = settings && partsPlan(file, settings);
  if (settings && plan) {
    // The id is minted HERE, because the parts routes are caller-named and this
    // call is not: `upload` promises only to resolve the ref, so where the id came
    // from is this module's business. Random rather than derived, for the reason
    // `useWorkflowStream` mints one that way — an upload id is a capability.
    //
    // Minted ONCE, outside the loop: an id that changed per round would make every
    // round a fresh upload of the whole file, which is the thing being fixed.
    const id = newClientUploadId();
    // No `resume` on the first round: nothing has been stored under an id minted
    // one line above.
    const stored = await storeInParts(
      { base, headers, fail, id, file, name, type, options, settings, plan },
      undefined,
    );
    // `undefined` means this path declined; the file has not moved, so it goes the
    // ordinary way below.
    if (stored) return stored;
  }
  const res = await sendUpload(
    "POST",
    `${base}/uploads?name=${encodeURIComponent(name)}`,
    { ...headers, "Content-Type": type },
    file,
    options,
  );
  if (!res.ok) throw await fail(res);
  // Guarded like every other read on this surface: a 2xx whose body is not
  // JSON is a proxy answering, not the agent, and `res.json()` would reject
  // with a bare `SyntaxError` for a file that has already been stored.
  const stored = await readApiJson<Omit<UploadRef, "url">>(res);
  // The URL is built from THIS client's base, not from the `url` the agent
  // answered with: the agent knows its own paths and not the origin it was
  // reached on, which on the platform is `/:slug/workflows/…`.
  return { ...stored, url: `${base}/uploads/${encodeURIComponent(stored.id)}` };
}

/**
 * Store one file under an id the CALLER chose, so a run can be started on it
 * before the bytes are in.
 *
 * The whole difference from {@link uploadFile} is the method and the URL — same
 * transport, same headers, same progress, same failures. What it buys is the
 * ORDER: the caller already has the id, so it can go in a run input, and the run
 * reads what has arrived while the rest is still on the wire.
 *
 * The id must satisfy `UPLOAD_TOKEN_RE` (a `crypto.randomUUID()` does) and must
 * not already exist — a second PUT to the same id is a 409 rather than an append,
 * which is what makes a chosen id safe.
 *
 * That refusal is also why this plans as `resumable` where {@link uploadFile} does
 * not: the parts routes are the only shape an interrupted upload can be picked up
 * in, so a one-part file declining them is a caller-named upload that cannot be
 * resumed — which is the one thing this call exists to provide. The extra round
 * trips buy that rather than speed; `_upload-parts-plan.ts`'s module doc carries
 * the rest, including why one part is not enough on its own.
 *
 * @internal
 */
export async function streamUploadFile(
  base: string,
  headers: Record<string, string>,
  fail: (res: Response) => Promise<Error>,
  id: string,
  file: UploadBody,
  options?: UploadOptions,
): Promise<UploadRef> {
  const { name, type } = describeUpload(file, options);
  const settings = partsSettings(options?.parallel);
  const plan = settings && partsPlan(file, settings, { resumable: true });
  if (settings && plan) {
    // The caller's OWN id, which is the difference from `uploadFile` and is why
    // parts compose with this at all: a run started on this id reads the
    // contiguous prefix as the parts fill it in, exactly as it reads a single
    // streaming `PUT`.
    // The caller's own `resume` decides the FIRST round, because only the caller
    // knows whether this id already holds bytes — it chose the id. Every round
    // after a failure is a resume regardless.
    const stored = await storeInParts(
      { base, headers, fail, id, file, name, type, options, settings, plan },
      options?.resume,
    );
    if (stored) return stored;
  }
  const res = await sendUpload(
    "PUT",
    `${base}/uploads/${encodeURIComponent(id)}?name=${encodeURIComponent(name)}`,
    { ...headers, "Content-Type": type },
    file,
    options,
  );
  if (!res.ok) throw await fail(res);
  const stored = await readApiJson<Omit<UploadRef, "url">>(res);
  // Built from THIS client's base, not from the `url` the agent answered with: the
  // agent knows its own paths and not the origin it was reached on.
  return { ...stored, url: `${base}/uploads/${encodeURIComponent(stored.id)}` };
}

/**
 * Read an upload's BYTES, as a `Blob` a page can play or save.
 *
 * The counterpart of {@link readUploadInfo}, and the browser half of
 * `writeUpload` — a run whose output is a file returns the id, and this is how
 * that id becomes something to hand an `<audio>` element or a download link.
 *
 * **A `Blob` rather than a URL, and the auth is why.** The byte route takes the
 * same `Authorization` header every other route here does, and neither
 * `<audio src>` nor `<a href>` can send one — so a page built on a URL works
 * against `aai dev`, where there is no token, and 401s the moment the agent has
 * one. Reading it here and calling `URL.createObjectURL` on the result works in
 * both, at the cost of holding the file in the tab, which for anything a person
 * is about to look at is what a browser does anyway.
 *
 * @internal — reached through `WorkflowApi.download`.
 */
export async function downloadUpload(
  base: string,
  headers: Record<string, string>,
  fail: (res: Response) => Promise<Error>,
  id: string,
  signal?: AbortSignal | undefined,
): Promise<Blob> {
  const res = await fetch(`${base}/uploads/${encodeURIComponent(id)}`, {
    headers,
    ...omitUndefined({ signal }),
  });
  if (!res.ok) throw await fail(res);
  return await res.blob();
}

/**
 * Read one upload's record — its name, how much has ARRIVED, and whether that is
 * all of it.
 *
 * What a client watches its own streamed upload with, and what answers "why is
 * this run still waiting". A step reads the same record in-process
 * (`uploadInfo` on `@alexkroman1/aai/utils`), so this is for everything that is
 * not one: a script, a dashboard, a person with `curl`.
 *
 * @internal
 */
export async function readUploadInfo(
  base: string,
  headers: Record<string, string>,
  fail: (res: Response) => Promise<Error>,
  id: string,
): Promise<UploadInfo> {
  const res = await fetch(`${base}/uploads/${encodeURIComponent(id)}/info`, { headers });
  if (!res.ok) throw await fail(res);
  return await readApiJson<UploadInfo>(res);
}
