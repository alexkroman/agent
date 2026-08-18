// Copyright 2026 the AAI authors. MIT license.
/**
 * The client half of `POST /workflows/uploads`.
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
 * the same 413.
 */

import { omitUndefined } from "./omit-undefined.ts";
import { readJsonBody } from "./response-body.ts";

/**
 * Names the surface in a failure that was not the agent's own `{ error }`
 * sentence — the same label `workflow-api-client.ts` uses, spelled here because
 * that module imports THIS one and not the other way round.
 */
const UPLOAD_ERROR_LABEL = "Workflow API";

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
};

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
  /** Absolute URL the bytes can be read back from, `Range` included. */
  url: string;
};

/** One report, with the fraction derived once rather than at each call site. */
function progressOf(loaded: number, total: number | undefined): UploadProgress {
  return {
    loaded,
    total,
    // `> 0` rather than `!== undefined`: a zero-byte body divides to `NaN`, and
    // the clamp covers a transport that reports the last chunk twice.
    fraction: total !== undefined && total > 0 ? Math.min(1, loaded / total) : undefined,
  };
}

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
 * The slice of `XMLHttpRequest` this module uses.
 *
 * Structural rather than the DOM's own type, because `packages/aai` compiles
 * with `lib: ["ESNext"]` — no browser globals — which is the boundary that keeps
 * host code from reaching for `document`. Naming only the members this module
 * touches states the dependency exactly and costs no `as any`.
 */
type UploadXhr = {
  open(method: string, url: string): void;
  setRequestHeader(name: string, value: string): void;
  send(body: UploadBody): void;
  abort(): void;
  addEventListener(type: "load" | "error" | "timeout" | "abort", listener: () => void): void;
  readonly upload: {
    addEventListener(
      type: "progress",
      listener: (event: { loaded: number; total: number; lengthComputable: boolean }) => void,
    ): void;
  };
  readonly status: number;
  readonly statusText: string;
  readonly responseText: string;
  getResponseHeader(name: string): string | null;
};

/**
 * `XMLHttpRequest`, when this runtime has one.
 *
 * Read off `globalThis` rather than referenced directly so the module still
 * loads under Node, where the name does not exist at all and a bare reference
 * would be a `ReferenceError` at first call rather than a fallback.
 */
function uploadXhrClass(): (new () => UploadXhr) | undefined {
  const candidate = (globalThis as Partial<{ XMLHttpRequest: new () => UploadXhr }>).XMLHttpRequest;
  return typeof candidate === "function" ? candidate : undefined;
}

/** Statuses a `Response` may not carry a body for. */
const BODILESS_STATUSES = new Set([204, 205, 304]);
/** The status range a `Response` can be constructed with at all. */
const MIN_RESPONSE_STATUS = 200;
const MAX_RESPONSE_STATUS = 599;

/**
 * Send the body through XHR and answer the `Response` it amounts to.
 *
 * The conversion is the point: everything above this line — the 413's sentence,
 * the JSON guard, the `ok` check — is written against `Response`, and a second
 * shape here would be a second way to describe the same failure.
 */
function sendViaXhr(
  Xhr: new () => UploadXhr,
  url: string,
  headers: Record<string, string>,
  file: UploadBody,
  total: number | undefined,
  report: (progress: UploadProgress) => void,
  signal: AbortSignal | undefined,
): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const xhr = new Xhr();
    xhr.open("POST", url);
    for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);
    xhr.upload.addEventListener("progress", (event) => {
      // The event's own total when it has one — it is the encoded length, which
      // for a string body is the only correct answer — and the measured one
      // otherwise, so a bar keeps its scale across a non-computable event.
      report(progressOf(event.loaded, event.lengthComputable ? event.total : total));
    });
    xhr.addEventListener("load", () => {
      // A `Response` can only be built over 200-599, and XHR reports 0 for a
      // response the browser refused to expose (an opaque cross-origin
      // redirect). Nothing above this line could read such an answer anyway, so
      // it becomes the same failure the `error` event is — checked here rather
      // than left to `new Response`, whose `RangeError` would be thrown inside
      // an event listener where it can reject nothing and the call would hang.
      if (xhr.status < MIN_RESPONSE_STATUS || xhr.status > MAX_RESPONSE_STATUS) {
        reject(networkError());
        return;
      }
      const type = xhr.getResponseHeader("Content-Type");
      resolve(
        new Response(BODILESS_STATUSES.has(xhr.status) ? null : xhr.responseText, {
          status: xhr.status,
          statusText: xhr.statusText,
          headers: omitUndefined({ "Content-Type": type ?? undefined }),
        }),
      );
    });
    xhr.addEventListener("error", () => reject(networkError()));
    xhr.addEventListener("timeout", () => reject(networkError()));
    // `signal.reason` is what `fetch` rejects an aborted request with, so a
    // caller's `catch` reads the same on both transports.
    xhr.addEventListener("abort", () => reject(signal?.reason ?? abortError()));
    if (signal) {
      if (signal.aborted) {
        reject(signal.reason ?? abortError());
        return;
      }
      signal.addEventListener("abort", () => xhr.abort(), { once: true });
    }
    xhr.send(file);
  });
}

/** What `fetch` rejects a failed request with, spelled for the other transport. */
function networkError(): Error {
  return new TypeError(`${UPLOAD_ERROR_LABEL}: the upload did not reach the agent`);
}

/** What an aborted request rejects with when the signal named no reason. */
function abortError(): Error {
  return new DOMException("The upload was aborted.", "AbortError");
}

/**
 * Issue the request, on whichever transport the options call for.
 *
 * Both paths end at a full bar: XHR's last event usually says so already, and
 * `fetch`'s answer is proof the whole body went. Reporting it here rather than
 * per path is what stops a bar resting at 99% on one of them.
 */
async function sendUpload(
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
  const init: RequestInit = { method: "POST", headers, body, ...omitUndefined({ signal }) };
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
    ? await sendViaXhr(Xhr, url, headers, file, total, report, signal)
    : await fetch(url, init);
  report(progressOf(total ?? sent, total));
  return res;
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
  // A `File` already knows both; anything else says so or gets the defaults.
  const described = file as { name?: unknown; type?: unknown };
  const name = options?.name ?? (typeof described.name === "string" ? described.name : "");
  const type =
    options?.type ??
    (typeof described.type === "string" && described.type
      ? described.type
      : "application/octet-stream");
  const res = await sendUpload(
    `${base}/uploads?name=${encodeURIComponent(name)}`,
    { ...headers, "Content-Type": type },
    file,
    options,
  );
  if (!res.ok) throw await fail(res);
  // Guarded like every other read on this surface: a 2xx whose body is not
  // JSON is a proxy answering, not the agent, and `res.json()` would reject
  // with a bare `SyntaxError` for a file that has already been stored.
  const stored = await readJsonBody<{ id: string; name: string; type: string; size: number }>(
    res,
    UPLOAD_ERROR_LABEL,
  );
  // The URL is built from THIS client's base, not from the `url` the agent
  // answered with: the agent knows its own paths and not the origin it was
  // reached on, which on the platform is `/:slug/workflows/…`.
  return { ...stored, url: `${base}/uploads/${encodeURIComponent(stored.id)}` };
}
