// Copyright 2026 the AAI authors. MIT license.
/**
 * The two numbers `/:slug/workflows/*` is bounded by.
 *
 * Split out of `constants.ts` for the same file-length reason `aai`'s
 * `client-audio-constants.ts` is: the argument behind
 * {@link WORKFLOW_PROXY_TRANSFER_TIMEOUT_MS} took that file over its 500-line cap,
 * and the seam it already had was this pair. They belong together because they are
 * one deadline read two ways — see each one's own doc.
 *
 * NOT re-exported from `constants.ts`, unlike the `aai` split this copies. That
 * one is re-exported because dozens of modules import from it; these two have a
 * single reader (`workflow-handler.ts`), so a re-export would buy an unchanged
 * import path for one line and cost an import CYCLE — this module needs `envMs`
 * from there, which is the direction that has to stay one-way.
 */

import { envMs } from "./constants.ts";

/**
 * How long `/:slug/workflows/*` may go WITHOUT PROGRESS before giving up.
 *
 * An INACTIVITY deadline, not a total: two routes on the surface are
 * legitimately unbounded in opposite directions — `GET /runs/:id/events` holds
 * a stream open for minutes, and `POST /workflows/uploads` carries up to
 * `MAX_WORKFLOW_UPLOAD_BYTES` — so the forward is `bound: "activity"`, whose
 * doc in `guest-forward.ts` carries the argument and the 500 MB upload this
 * number used to abort at 30.3s.
 *
 * 30s rather than something tighter because the first request through this route
 * is what BOOTS the sandbox: the broker has already waited for readiness, but a
 * cold guest's first HTTP answer still lands behind module loading. Override
 * with `WORKFLOW_PROXY_TIMEOUT_MS`.
 */
export const WORKFLOW_PROXY_TIMEOUT_MS = envMs(process.env.WORKFLOW_PROXY_TIMEOUT_MS, 30_000);

/**
 * The same deadline, for a forward that is CARRYING A BODY.
 *
 * Its own number because the thing it waits on is unobservable from here, where
 * {@link WORKFLOW_PROXY_TIMEOUT_MS}'s is not. That deadline re-arms on every
 * chunk the forward drains, which reads as "the transfer is moving" and is
 * evidence of no such thing about the far end: undici accepts a stream body into
 * its own write buffer well ahead of the socket. Measured against a real reader
 * taking 64 KB every 200ms — **5 MiB handed over in 10ms, of which the reader
 * had 0.6 MiB.** So a pull stall means "the buffer is full", and the buffer
 * empties at the GUEST's pace, which for an upload route is the pace it writes
 * chunk rows into the app's Postgres.
 *
 * Both halves of that fall inside this window, and both were 30s: the wait for
 * the buffer to drain enough for one more chunk, and the wait for the answer
 * after the last byte is handed over. 27 upload `PUT`s answered 503 inside one
 * hour of production log, every one between 30.3s and 34.1s, on a guest that was
 * storing perfectly well while transcribing at the same time — and the run
 * watching that upload then failed with `the uploader stopped`.
 *
 * So this is a claim about the guest's WRITE bandwidth in exactly the way the
 * pre-`"activity"` total was a claim about the caller's UPLOAD bandwidth, and it
 * is sized like one: 120s is four times the head budget, enough for single-digit
 * MiB of buffered body against a loaded store, and still a bound on the one
 * failure left to catch — a guest that took the bytes and died. Override with
 * `WORKFLOW_PROXY_TRANSFER_TIMEOUT_MS`.
 */
export const WORKFLOW_PROXY_TRANSFER_TIMEOUT_MS = envMs(
  process.env.WORKFLOW_PROXY_TRANSFER_TIMEOUT_MS,
  120_000,
);
