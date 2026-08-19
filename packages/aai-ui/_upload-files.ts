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
import type { UploadParallel } from "@alexkroman1/aai/workflow-api";
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
  /** The id each file is being stored under, minted once. */
  ids: Map<File, string>;
  /** Files whose every byte has landed, by the id they landed under. */
  stored: Map<File, string>;
  /** Files that have had an attempt, so the next one must claim the id as its own. */
  tried: Set<File>;
  /** The person's pause. */
  gate: UploadGate;
};

/** A fresh session for one submission. */
export function createUploadSession(): UploadSession {
  return { ids: new Map(), stored: new Map(), tried: new Set(), gate: createUploadGate() };
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
  parallel: UploadParallel | undefined,
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
    let id = session.ids.get(file);
    if (id === undefined) {
      id = randomUploadId();
      session.ids.set(file, id);
    }
    const position = { name: file.name, index, count };
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
        ...omitUndefined({ parallel, resume: resume ? true : undefined }),
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
