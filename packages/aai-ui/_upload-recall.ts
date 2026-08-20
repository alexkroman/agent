// Copyright 2026 the AAI authors. MIT license.
/**
 * Where an upload's ID survives a page RELOAD.
 *
 * A streamed upload is resumable because its id outlives the attempt that began
 * it — `_upload-files.ts` says so, and `_upload-session.ts` turns that into a
 * pause a person can press. Both of them hold the id in MEMORY: the walk's
 * `UploadSession` lives in a `useRef`, so a reload was the one interruption the
 * mechanism could not survive. Everything else was already in place — the windows
 * were still in the store, the agent could still name them
 * (`UploadInfo.ranges`), and the id was minted in the browser — and the browser
 * had thrown away the only name for them. So a person who refreshed at 90% of a
 * 200 MB recording sent the whole file again, which is the one interruption they
 * are most likely to cause on purpose.
 *
 * This is that name, written down. It is what tus-js-client's `urlStorage` and
 * Uppy's Golden Retriever sell, in the shape `session-resume-store.ts` already
 * uses for a session id.
 *
 * ## A FINGERPRINT, because a `File` has no name a page can address
 *
 * A file from a picker carries no path and no handle, so the key is what
 * tus-js-client fingerprints on: size, last-modified, type and name. Two
 * different files agreeing on all four is the case this cannot tell apart — and
 * the reason NOTHING here decides to resume. `_upload-files.ts` asks the agent
 * what the id actually holds before sending a byte to it, so a wrong hit costs
 * one `GET` and a fresh id rather than a corrupted upload.
 *
 * ## `sessionStorage`, deliberately
 *
 * The same call `session-resume-store.ts` makes, for a reason that happens to be
 * stronger here: a reload and a same-tab navigation are exactly what this is for,
 * and an id from yesterday names an upload the agent's sweep has very likely
 * already collected. A tab is also the boundary the walk itself has — two tabs
 * uploading the same recording are two submissions.
 *
 * Every access is guarded. Storage throws outright in Safari private mode and
 * under a blocking policy, and an upload that cannot be REMEMBERED must degrade
 * to the upload we would have done anyway rather than failing to start.
 */

import { isRecord } from "@alexkroman1/aai/utils";

const PREFIX = "aai:upload:";

/**
 * How many ids one form keeps.
 *
 * A cap rather than an expiry, because `sessionStorage` already expires with the
 * tab and an entry is ~80 bytes. What it bounds is the long-lived tab that
 * submits a hundred files: the oldest go first, and the id most likely to be
 * worth resuming is the one written last.
 */
const MAX_REMEMBERED = 32;

/** One form's slot in storage. */
function keyFor(scope: string): string {
  return `${PREFIX}${scope}`;
}

/**
 * What names this file across a reload.
 *
 * The four fields a browser gives a picked file that do not change between loads.
 * `name` last because it is the one a person can read in a debugger.
 */
function fingerprint(file: File): string {
  return `${file.size}:${file.lastModified}:${file.type}:${file.name}`;
}

/** This scope's remembered ids, or nothing at all — a parse failure is nothing. */
function read(scope: string): Record<string, unknown> {
  try {
    const raw = globalThis.sessionStorage?.getItem(keyFor(scope));
    if (raw === null || raw === undefined) return {};
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : {};
  } catch {
    // Unavailable, or holding something this version does not recognise. Either
    // way there is nothing to resume, which is where this code started.
    return {};
  }
}

function write(scope: string, entries: Record<string, unknown>): void {
  try {
    globalThis.sessionStorage?.setItem(keyFor(scope), JSON.stringify(entries));
  } catch {
    // Unavailable, or the quota is gone. The id still lives in the session for
    // this page's lifetime, so only the reload loses.
  }
}

/**
 * The id this file was last being stored under in this tab, if any.
 *
 * A hit is a CANDIDATE and never a decision — see the module doc.
 *
 * @internal
 */
export function recallUploadId(scope: string, file: File): string | undefined {
  const found = read(scope)[fingerprint(file)];
  return typeof found === "string" ? found : undefined;
}

/**
 * Remember the id this file is being stored under.
 *
 * Called before the first byte leaves rather than after the last one lands: the
 * reload this exists for happens in between, and an id written at the end is an
 * id written for the one case that did not need it.
 *
 * @internal
 */
export function rememberUploadId(scope: string, file: File, id: string): void {
  const entries = read(scope);
  const key = fingerprint(file);
  // Re-inserted rather than assigned in place. A key keeps its original position
  // in a JS object, and position is what the cap below evicts by — so assigning
  // would leave a file being uploaded right now looking like the oldest entry.
  delete entries[key];
  entries[key] = id;
  const keys = Object.keys(entries);
  for (const stale of keys.slice(0, Math.max(0, keys.length - MAX_REMEMBERED))) {
    delete entries[stale];
  }
  write(scope, entries);
}

/**
 * Forget it: the agent holds nothing resumable under this id.
 *
 * The other half of the agent deciding. Without it a swept upload is re-read on
 * every submission of the same file for the life of the tab, which is a round
 * trip spent learning the same 404.
 *
 * @internal
 */
export function forgetUploadId(scope: string, file: File): void {
  const entries = read(scope);
  const key = fingerprint(file);
  if (!(key in entries)) return;
  delete entries[key];
  write(scope, entries);
}
