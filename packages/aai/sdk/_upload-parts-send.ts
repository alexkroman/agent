// Copyright 2026 the AAI authors. MIT license.
/**
 * The MECHANICS of the fan-out: how one window is sent, and how they all are.
 *
 * Split from `workflow-upload-parts.ts`, which owns the DECISIONS — whether this path
 * applies at all, which route the bytes take, what a resume still owes — and which is
 * at both the file-length and the cognitive-complexity caps. Nothing here decides
 * anything: it is handed what the claim already answered.
 */

import type { Claimer } from "./_upload-claims.ts";
import { type Part, sliceOf } from "./_upload-parts-plan.ts";
import { withRetries } from "./_upload-retry.ts";
import { mapConcurrent } from "./map-concurrent.ts";
import { omitUndefined } from "./omit-undefined.ts";
import type { UploadBody, UploadOptions, UploadProgress } from "./workflow-upload-client.ts";

/**
 * The part of an upload request this module reads, structurally.
 *
 * Deliberately NOT `UploadPartsRequest`: importing that type back from
 * `workflow-upload-parts.ts` is an import CYCLE, and naming the five fields is also
 * the honest statement of what sending a window needs — nothing about the plan, the
 * settings, or whether this path applies at all.
 */
type PartBytes = {
  /** The upload's id, which is the prefix each window's object is keyed under. */
  id: string;
  /** MIME type to store. */
  type: string;
  /** The whole file, sliced per window. */
  file: UploadBody;
  /** The single-body writer, so both paths share one transport. */
  send: SendPart;
  /** How the caller turns a failed response into an error. */
  fail: (res: Response) => Promise<Error>;
  /** Auth headers, if the API is closed — sent to the AGENT and never to the platform. */
  headers: Record<string, string>;
};

/**
 * Run the fan-out, and raise the failure that CAUSED it to stop.
 *
 * Its own function for two reasons. `uploadInParts` is at the cognitive-complexity
 * cap, and the error handling here is subtle enough to want a name: a failing CLAIM
 * aborts every window in flight, so what `mapConcurrent` reports is that abort
 * rather than its cause, and raising it would name the symptom — "aborted" — for a
 * caller whose real problem is that the agent refused a receipt.
 */
export async function sendEveryPart(ctx: {
  missing: readonly Part[];
  width: number;
  sendPart: (part: Part) => Promise<void>;
  failed: AbortController;
  claimer: Claimer;
}): Promise<void> {
  const { missing, width, sendPart, failed, claimer } = ctx;
  try {
    // `mapConcurrent` rather than a pool written here, and it is the SDK's own — a
    // window over a cursor with exactly the semantics this needs, including the one
    // the local copy got wrong: a rejection stops the other slots taking new items,
    // where the local pool kept them pulling from the cursor and relied on the abort
    // below to make each new request fail on arrival.
    await mapConcurrent(missing, width, async (part) => {
      try {
        await sendPart(part);
      } catch (err: unknown) {
        // Before re-throwing, so the parts already ON THE WIRE stop too — stopping
        // the window is not the same as abandoning the requests it has issued.
        failed.abort(err);
        throw err;
      }
    });
  } catch (err: unknown) {
    throw claimer.failure() ?? err;
  }
}

/**
 * How ONE window is sent, given everything the fan-out decided once.
 *
 * A factory rather than a closure inside {@link uploadInParts}, because that
 * function is at the cognitive-complexity cap and this is the part of it with its
 * own subject: where a window's bytes go, and who is told they arrived.
 */
export function createPartSender(ctx: {
  req: PartBytes;
  /** The platform's byte route, or `undefined` when the bytes come to the agent. */
  bytesBase: string | undefined;
  /** `…/uploads/<id>`, the agent's own route for this upload. */
  uploads: string;
  options: UploadOptions;
  attempts: number;
  signal: AbortSignal;
  report: (index: number, bytes: number) => void;
  claimer: Claimer;
}): (part: Part) => Promise<void> {
  const { req, bytesBase, uploads, options, attempts, signal, report, claimer } = ctx;
  return async (part: Part): Promise<void> => {
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
    // The window is in the bucket and the agent has not heard. Handed to the claimer
    // rather than claimed HERE, which is the difference this path is about: the two
    // failures are different — the bytes are already stored, so a lost receipt costs
    // one small request rather than the window — and awaiting the receipt in this
    // slot spent about half of the fan-out's width on a request carrying nothing.
    if (bytesBase) claimer.landed(part.start);
    // Reported on the BYTES, which is what a progress bar is about and what is now
    // durable; the claim behind it is bookkeeping the caller cannot act on.
    report(part.index, part.end - part.start);
  };
}

/** How a part's request is issued — `sendUpload`, injected so this module owns no transport. */
export type SendPart = (
  method: "PUT",
  url: string,
  headers: Record<string, string>,
  body: UploadBody,
  options: UploadOptions | undefined,
) => Promise<Response>;

/**
 * The per-part options: the caller's signal, and a progress callback scoped to one
 * part.
 *
 * The name and type are already on the URL and the header, so nothing else of the
 * caller's options survives here — in particular a caller's own `onProgress` must
 * NOT be passed through, or it would receive one part's bytes as though they were
 * the file's.
 */
export function partOptions(
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
