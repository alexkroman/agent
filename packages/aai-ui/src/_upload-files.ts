// Copyright 2026 the AAI authors. MIT license.
/**
 * Turning a form's `File`s into stored upload ids, pauses and all.
 *
 * Split out of `use-workflow-form.ts` for the 500-line cap, and the seam is a
 * real one: that module is the two HOOKS and the state between them, where this
 * is the walk over a submitted input — which is the only part of it that knows
 * what a `File` is, holds a loop, and survives being re-entered.
 *
 * `_`-internal. `useWorkflowSubmit` is the only caller; `useWorkflowStream` sends
 * one file rather than walking an input and shares only the gate underneath both
 * (`_upload-session.ts`).
 */

import { isRecord, omitUndefined } from "@alexkroman1/aai/utils";
import type { UploadParallelOption } from "@alexkroman1/aai/workflow-api";
import { forgetUploadId, recallUploadId, rememberUploadId } from "./_upload-recall.ts";
import {
  createUploadGate,
  randomUploadId,
  sendThroughGate,
  type UploadGate,
} from "./_upload-session.ts";
import { filesOf } from "./_workflow-files.ts";
import type { UploadStatus } from "./use-workflow-form.ts";
import type { WorkflowApi } from "./workflow-client.ts";

/**
 * What one submission's uploads know about themselves, across pauses.
 *
 * Held by the hook rather than by the walk below, because the walk RE-RUNS: a
 * pause unwinds nothing, so resuming re-enters `uploadFiles` with the same input
 * and the same session, and every file whose bytes are already in is skipped by
 * `stored` rather than sent again.
 *
 * Which is also why the ids live here. A resumable upload is one whose id
 * outlives the attempt that began it — that is the whole mechanism — so an id
 * minted per attempt would make each round a fresh upload of the whole file.
 */
export type UploadSession = {
  /**
   * What this form's remembered ids are filed under (`_upload-recall.ts`).
   *
   * The workflow's name, so two forms on one page do not read each other's
   * entries. It is not a SAFETY boundary and does not need to be — a recalled id
   * is checked against the agent before anything is sent to it — it just keeps a
   * form from spending a round trip on another form's upload.
   */
  scope: string;
  /** The id each file is being stored under, minted once. */
  ids: Map<File, string>;
  /** Files whose every byte has landed, by the id they landed under. */
  stored: Map<File, string>;
  /**
   * Files that have had an attempt, so the next one must claim the id as its own.
   *
   * `sendThroughGate` tracks this itself WITHIN one file's attempts. What this
   * carries is the attempt made by a page load that is gone: an id recalled from
   * storage was claimed by whoever minted it, so the first attempt of this load is
   * a resume even though this load has sent nothing.
   */
  tried: Set<File>;
  /** The person's pause. */
  gate: UploadGate;
};

/** A fresh session for one submission of `workflow`. */
export function createUploadSession(workflow: string): UploadSession {
  return {
    scope: workflow,
    ids: new Map(),
    stored: new Map(),
    tried: new Set(),
    gate: createUploadGate(),
  };
}

/**
 * The id to store this file under: the one a previous page load was using, or a
 * fresh one.
 *
 * **The AGENT decides, never the fingerprint.** Two files can agree on every
 * field `_upload-recall.ts` keys by, so the recalled id is a candidate that has to
 * be checked before a byte is sent to it — and the check is cheap and exact,
 * because `uploadInfo` is the same record a resume already reads.
 *
 * Three answers, and the third is why this is not just a storage lookup:
 *
 * - **Complete.** Every byte is in from a load that is gone, so there is nothing
 *   to send: the caller takes the id and starts the run. This is the refresh that
 *   costs one `GET` instead of a second 200 MB upload.
 * - **Unfinished, with windows.** `UploadInfo.ranges` is what makes an
 *   upload resumable at all, so the id is reused and the attempt claims it.
 * - **Anything else.** A 404 (swept, or never seen), a failure, or an unfinished
 *   upload reporting NO windows — which is a partial single `PUT`, and a second
 *   `PUT` to that id is a 409 rather than an append (`streamUploadFile`). Reusing
 *   it would turn a reload into a failure the person cannot clear, so the entry is
 *   dropped and the file gets a fresh id.
 */
async function claimId(
  api: WorkflowApi,
  session: UploadSession,
  file: File,
): Promise<{ id: string; complete: boolean }> {
  const remembered = recallUploadId(session.scope, file);
  if (remembered === undefined) return { id: randomUploadId(), complete: false };
  // A rejection is an ANSWER here rather than something to retry: the file is in
  // hand and sending it is always available, so there is nothing this could be
  // waiting for.
  const info = await api.uploadInfo(remembered).catch(() => undefined);
  if (info?.complete === true) return { id: remembered, complete: true };
  if (info !== undefined && (info.ranges?.length ?? 0) > 0) {
    session.tried.add(file);
    return { id: remembered, complete: false };
  }
  forgetUploadId(session.scope, file);
  return { id: randomUploadId(), complete: false };
}

/**
 * Replace every `File` in a submitted form with the id of a stored upload,
 * reporting how far each one has got.
 *
 * Sequential rather than `Promise.all`: these are large bodies, and a form with
 * two 200 MB recordings should send them one after another rather than compete
 * for the same connection. That is also what makes a single bar honest — one
 * file is in flight at a time, and `index`/`count` say which.
 *
 * Anything that is not a `File` (or an array of them) passes through untouched,
 * so this is invisible to every form that has none — including one whose values
 * are not an object at all, which `submit` accepts.
 *
 * ## `uploadStream`, not `upload`, and the id is the reason
 *
 * The difference between the two calls is only who mints the id — and that is
 * exactly what decides whether an interrupted upload can be picked up again. An
 * `upload` mints its own at the END and hands it back, so a caller whose upload
 * died has nothing to name what was stored and no choice but to send the file
 * again. A `uploadStream` is told the id up front, so the windows already in the
 * store are addressable, which is what both a pause and a server restart need.
 *
 * Nothing else about the submission changes: the run is still started after the
 * last byte lands, so the incomplete record a streamed upload leaves along the
 * way is one nobody reads.
 */
export async function uploadFiles(
  api: WorkflowApi,
  input: unknown,
  report: (status: UploadStatus) => void,
  parallel: UploadParallelOption | undefined,
  session: UploadSession,
): Promise<unknown> {
  if (!isRecord(input)) return input;
  const entries = Object.entries(input);
  // Counted before the first byte leaves, because "1 of 3" needs the 3 and the
  // last field is where it becomes known.
  const count = entries.reduce((total, [, value]) => total + filesOf(value).length, 0);
  let index = 0;
  const store = async (file: File): Promise<string> => {
    // Before the early return, so a file's position is the same on every walk: an
    // index derived from what is LEFT would renumber the bar on every resume.
    index += 1;
    const done = session.stored.get(file);
    if (done !== undefined) return done;
    const position = { name: file.name, index, count };
    const known = session.ids.get(file);
    const claimed =
      known === undefined ? await claimId(api, session, file) : { id: known, complete: false };
    const id = claimed.id;
    if (known === undefined) {
      session.ids.set(file, id);
      // Remembered before the first byte leaves — see `rememberUploadId`. A
      // recalled id is re-written rather than skipped, which is what keeps the file
      // being uploaded RIGHT NOW from ageing out of a full store.
      rememberUploadId(session.scope, file, id);
    }
    if (claimed.complete) {
      // Every byte was already in, from a load that is gone. Reported full rather
      // than skipped in silence, so a submission whose first of three files is
      // already stored still counts "1 of 3" over a bar that reached the end.
      report({ ...position, loaded: file.size, total: file.size, fraction: 1, paused: false });
      session.stored.set(file, id);
      return id;
    }
    await sendThroughGate(session.gate, async (resume) => {
      await api.uploadStream(id, file, {
        name: file.name,
        signal: session.gate.signal,
        onProgress: (progress) =>
          // `gate.paused` rather than a constant `false`: an XHR can deliver one
          // more progress event between the abort and its rejection, and that one
          // would otherwise report a parked upload as running.
          report({ ...position, ...progress, paused: session.gate.paused }),
        // Files stay SEQUENTIAL above whatever this says: `parallel` splits ONE
        // file across connections, and a form sending two recordings at once would
        // still have them competing for the same link with two bars to explain it.
        // A recalled id was claimed by the load that minted it, so this load's FIRST
        // attempt is already a resume — which is what `session.tried` carries.
        ...omitUndefined({
          parallel,
          resume: resume || session.tried.has(file) ? true : undefined,
        }),
      });
    });
    session.stored.set(file, id);
    return id;
  };
  const out: Record<string, unknown> = {};
  for (const [name, value] of entries) {
    if (value instanceof File) {
      out[name] = await store(value);
      continue;
    }
    const chosen = filesOf(value);
    if (chosen.length === 0) {
      out[name] = value;
      continue;
    }
    const ids: string[] = [];
    for (const file of chosen) ids.push(await store(file));
    // The SHAPE follows the field, not the count: a `multiple` field carrying
    // one file still submits a list, because that is what its schema declares.
    out[name] = ids;
  }
  return out;
}
