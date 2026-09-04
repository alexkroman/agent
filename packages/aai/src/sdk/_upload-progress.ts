// Copyright 2026 the AAI authors. MIT license.
/**
 * The upload transport that can report BYTES SENT, and the report it makes.
 *
 * Its own module because it is the one thing in the upload path that is not
 * `fetch`, and the reason it exists is where the split matters: `fetch` cannot
 * observe a request body — the streaming request form (`duplex: "half"`) is one
 * engine's extension that rejects outright on the others — so a caller that
 * wants a progress bar goes through `XMLHttpRequest` instead.
 * `workflow-upload-client.ts`'s module doc carries the rest of that argument.
 *
 * The one rule to preserve when editing this: the XHR answer is turned back into
 * a `Response` HERE, at the boundary, so exactly one error vocabulary and one
 * JSON guard sit above both transports. Anything that leaks the XHR's own shape
 * upward is a second way for this route to describe the same 413.
 *
 * `progressOf` lives here rather than beside the options that declare
 * `onProgress`, and the reason is mechanical: the sender below is its heaviest
 * caller, and importing it back from `workflow-upload-client.ts` would be a
 * runtime cycle between the two. The `UploadProgress` TYPE still belongs to the
 * client, which is a type-only import and erased.
 */

import { WORKFLOW_API_ERROR_LABEL } from "./_workflow-api-envelope.ts";
import { omitUndefined } from "./omit-undefined.ts";
import type { UploadBody, UploadProgress } from "./workflow-upload-client.ts";

/** One report, with the fraction derived once rather than at each call site. */
export function progressOf(loaded: number, total: number | undefined): UploadProgress {
  return {
    loaded,
    total,
    // `> 0` rather than `!== undefined`: a zero-byte body divides to `NaN`, and
    // the clamp covers a transport that reports the last chunk twice.
    fraction: total !== undefined && total > 0 ? Math.min(1, loaded / total) : undefined,
  };
}

/**
 * The slice of `XMLHttpRequest` this module uses.
 *
 * Structural rather than the DOM's own type, because `packages/aai` compiles
 * with `lib: ["ESNext"]` — no browser globals — which is the boundary that keeps
 * host code from reaching for `document`. Naming only the members this module
 * touches states the dependency exactly and costs no `as any`.
 */
export type UploadXhr = {
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
export function uploadXhrClass(): (new () => UploadXhr) | undefined {
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
export function sendViaXhr(
  Xhr: new () => UploadXhr,
  method: "POST" | "PUT",
  url: string,
  headers: Record<string, string>,
  file: UploadBody,
  total: number | undefined,
  report: (progress: UploadProgress) => void,
  signal: AbortSignal | undefined,
): Promise<Response> {
  return new Promise<Response>((settleOk, settleErr) => {
    const xhr = new Xhr();
    // Detached on EVERY outcome, not just on abort. `{ once: true }` only fires
    // when the signal does, so on the success path the listener stayed on the
    // CALLER's signal — which a page holds for the whole upload — with the
    // finished `XMLHttpRequest` and its `responseText` alive in its closure.
    // A parallel multi-part upload registers one per part, so a large file left
    // hundreds of completed requests retained until the upload object went away.
    const done =
      <T>(settle: (value: T) => void) =>
      (value: T) => {
        if (signal) signal.removeEventListener("abort", onAbort);
        settle(value);
      };
    const resolve = done(settleOk);
    const reject = done(settleErr);
    const onAbort = () => xhr.abort();
    xhr.open(method, url);
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
      signal.addEventListener("abort", onAbort, { once: true });
    }
    xhr.send(file);
  });
}

/** What `fetch` rejects a failed request with, spelled for the other transport. */
function networkError(): Error {
  return new TypeError(`${WORKFLOW_API_ERROR_LABEL}: the upload did not reach the agent`);
}

/** What an aborted request rejects with when the signal named no reason. */
function abortError(): Error {
  return new DOMException("The upload was aborted.", "AbortError");
}
