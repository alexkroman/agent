// Copyright 2026 the AAI authors. MIT license.
/**
 * The one place an upload failure becomes a STATUS.
 *
 * Its own module because both halves of the upload surface answer with it — the
 * writes in `workflow-api-uploads.ts` and the reads in
 * `workflow-api-uploads-read.ts` — and a second copy is a second place for the
 * 409, the 413 and the 501 to drift apart. It is the store's error vocabulary
 * translated once; nothing here decides anything else.
 */

import type http from "node:http";
import { sendJson } from "./workflow-api-http.ts";
import {
  UnknownUploadError,
  UploadCompleteError,
  UploadIdTakenError,
  UploadPartError,
  UploadsUnavailableError,
  UploadTooLargeError,
} from "./workflow-uploads.ts";

/**
 * Answer an upload failure this route can name, or decline so the caller re-throws.
 *
 * 413 here rather than in the router's catch, because these are the routes whose
 * body is MEANT to be large: the cap is part of their contract, and a caller has
 * to tell "too big" apart from "the agent is broken". 409 for a taken id for the
 * same reason — the request is well formed and the id is simply not available,
 * which a client retrying a `PUT` after a lost response needs to know.
 *
 * **It serves the READS too, which is why it is no longer `sendWriteFailure`.**
 * The two `GET` routes called `store.info(id)` outside any `try`, so on a
 * deployment with no upload backend they took the same opaque 500 as the writes —
 * and `info` is precisely the route a person reaches for to ask why the others are
 * failing.
 */
export function sendUploadFailure(res: http.ServerResponse, err: unknown): boolean {
  // 501, and it is the only status here addressed to an OPERATOR rather than to a
  // client — see `UploadsUnavailableError` for why not 500 or 503. The message is
  // the whole value: it names which half is missing and the command that supplies
  // it, and until this branch existed it was composed and then discarded.
  if (err instanceof UploadsUnavailableError) {
    sendJson(res, 501, { error: err.message });
    return true;
  }
  if (err instanceof UploadTooLargeError) {
    sendJson(res, 413, { error: err.message });
    return true;
  }
  if (err instanceof UploadIdTakenError) {
    sendJson(res, 409, { error: err.message });
    return true;
  }
  // 409 for the same reason one line up, and it is the same fact from the other
  // end: `stream` refuses an id already taken, and this refuses a window of an
  // upload already finished. A client must not read either as a transport failure —
  // `RETRYABLE_STATUS` excludes 409, so a re-send stops here rather than spending
  // four attempts on an answer that cannot change.
  if (err instanceof UploadCompleteError) {
    sendJson(res, 409, { error: err.message });
    return true;
  }
  // 400: the request contradicts itself (a misaligned offset, a part past the
  // declared total), which a client has to be able to tell from a transport
  // failure it should retry — a retried part is the ordinary case, and retrying
  // one that can never be accepted is a loop.
  if (err instanceof UploadPartError) {
    sendJson(res, 400, { error: err.message });
    return true;
  }
  // 404: well formed, and there is simply nothing to write into.
  if (err instanceof UnknownUploadError) {
    sendJson(res, 404, { error: err.message });
    return true;
  }
  return false;
}
