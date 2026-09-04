// Copyright 2026 the AAI authors. MIT license.
/**
 * The third {@link UploadRecords}: an upload's record over HTTP, on the platform.
 *
 * The other two are the app's own Postgres (`createPostgresUploadRecords`) and a
 * directory (`createFileUploadRecords`). This one is what a DEPLOYED guest uses,
 * and it exists because the choice between those two was made on a premise that
 * stopped being true.
 *
 * ## What was wrong
 *
 * `createUploadStore` picked its home from whether the agent had a `ctx.db`, and
 * its comment said why: "A database means durable runs, so the bytes have to be
 * durable too." The workflow queue moving to the platform falsified that — a
 * deployed app's runs are durable with no database of the author's at all — so the
 * decision keyed off a signal that no longer meant durability.
 *
 * The result, observed on a real sandbox: a deployed agent with no `DATABASE_URL`
 * got DURABLE RUNS and put their uploads in a directory that recycles. A
 * transcription workflow filled the guest's filesystem, every write raised
 * `ENOSPC`, and three layers retried it as though a full disk were transient.
 *
 * With this, a deployed guest keeps nothing durable on disk.
 *
 * ## `ensure` is local, and that is the interesting difference
 *
 * The seam's `ensure` exists because the Postgres backend creates its table lazily
 * — an agent's first workflow may be its first ever deploy, with no provisioning
 * pass to hang DDL off. The platform's own schema HAS one, so there is nothing to
 * ensure and nothing to round-trip: this resolves immediately. Sending a request
 * that always answers "fine" on every operation would be one wasted round trip per
 * upload call, and `ensure` is called before all of them.
 *
 * ## A CLAIMED id is a 409 and must stay distinguishable
 *
 * `claim` refusing an id is this backend working, not failing — it is what makes a
 * caller-chosen id safe. So a 409 is translated back into `UploadIdTakenError`
 * rather than becoming a generic error the store would retry.
 *
 * ## A 501 is a CONFIGURATION condition, not a failed call
 *
 * The second translated status, and the reason it needs translating is the same:
 * a 501 says the platform above this guest holds no upload records AT ALL (see
 * `uploads-handler.ts`, which answers it when it has no admin database), which is
 * a named condition rather than a call that went wrong. So it becomes
 * `UploadsUnavailableError` — the one error the upload routes answer with its own
 * message, as a 501 carrying the body.
 *
 * Untranslated it fell to the generic throw, and the cost was exactly what that
 * class exists to prevent: `sendUploadFailure` did not recognise it, so a caller
 * got `500 {"error":"Internal server error"}` while the sentence naming what to
 * configure stayed in the platform's log. Observed against a local platform with
 * no `SUPABASE_DB_URL` — every upload 500ed with nothing to act on.
 *
 * Neither translation is a FALLBACK, and the difference matters: this arm is
 * taken once (`createUploadStore`'s `options.platform` branch), so there is no local
 * store to fall back TO — and a local record behind the platform's bucket would
 * be the half-durable pairing `_upload-store-blobs.ts` refuses everywhere else.
 * Everything else non-2xx throws, because a silent failure would mean an upload
 * whose bytes are in the bucket and whose record says nothing arrived.
 */

import { isRecord, omitUndefined } from "@alexkroman1/aai/utils";
import { partsOf } from "./_upload-blobs.ts";
import type { UploadRecord, UploadRecords } from "./_upload-records.ts";
import { UploadIdTakenError, UploadsUnavailableError } from "./_upload-store.ts";
import { PLATFORM_ROUTES, type PlatformEndpoint } from "./platform-endpoint.ts";
import { platformResult } from "./platform-rpc.ts";

/**
 * How long one record call may take.
 *
 * Longer than session state's 10s, and the reason is what is waiting: a session
 * flush blocks a tool call, while an upload record is written between window
 * batches on a transfer that already takes as long as it takes. 20s is generous
 * enough that a slow platform read never fails an upload mid-flight, and short
 * enough that a wedged socket does not hold a window batch forever.
 */
const UPLOAD_RECORD_TIMEOUT_MS = 20_000;

/**
 * What this backend needs to reach the platform.
 *
 * An alias of {@link PlatformEndpoint}: the four platform clients take exactly the
 * same credential pair, which is why one `resolvePlatformQueue()` result is already
 * handed to three of them. The name is kept because it is what the call sites read.
 */
export type PlatformUploadRecordsOptions = PlatformEndpoint;

/**
 * The error a 501 becomes — this deployment's platform has no upload records.
 *
 * Its own function because the MESSAGE is the whole value: it reaches a browser
 * in the 501 body, so it has to name the missing thing and how to supply it
 * rather than describe the call that failed.
 */
function notConfiguredError(): UploadsUnavailableError {
  return new UploadsUnavailableError(
    "This deployment's platform has no workflow upload records configured, so an " +
      "upload has nowhere to record what arrived.\n\n" +
      "A production platform provisions them with its own database. A LOCAL platform " +
      "(`AAI_LOCAL_DEV=1`) has none until it has a `SUPABASE_DB_URL` — `supabase start` " +
      "from the repo root, which `scripts/dev-server.mjs` then resolves for it.\n\n" +
      "An agent run WITHOUT a platform does not need this: `aai dev` keeps uploads in " +
      "the local workflow world beside its runs.",
  );
}

/** One call to the platform's upload-records route. */
async function call(
  options: PlatformUploadRecordsOptions,
  method: string,
  id: string,
  body: Record<string, unknown> = {},
): Promise<unknown> {
  return await platformResult(options, {
    route: PLATFORM_ROUTES.uploadRecords,
    label: `upload-records ${method}`,
    timeoutMs: UPLOAD_RECORD_TIMEOUT_MS,
    body: JSON.stringify({ method, id, ...body }),
    // The two non-2xx statuses that are not failures of this call — see the module
    // doc. Both decided from the STATUS alone: what the platform said about a
    // refused id, or about its own configuration, does not change what either
    // status means.
    // Falls through to the generic error for every other status, which is the
    // `undefined` this seam reads as "take the default".
    errorFor: (status) => {
      // `claim`'s contract, held across all three backends.
      if (status === 409) return new UploadIdTakenError(id);
      if (status === 501) return notConfiguredError();
    },
  });
}

/** One record off the wire, or `undefined` when the platform answered `null`. */
function recordOf(value: unknown): UploadRecord | undefined {
  if (!isRecord(value)) return undefined;
  // `typeof`, never `Number(...)`: `Number(null)` is 0, and a size that reads 0
  // instead of "unreadable" is an upload the store believes is empty rather than
  // one it should refuse to answer about.
  if (typeof value.size !== "number") return undefined;
  const expected = value.expected;
  return {
    name: typeof value.name === "string" ? value.name : "",
    type: typeof value.type === "string" ? value.type : "",
    size: value.size,
    complete: value.complete === true,
    // ABSENT is a value: it is what says "not a parts upload", which decides how
    // completion is judged. So the key is omitted rather than set to undefined.
    ...omitUndefined({ expected: typeof expected === "number" ? expected : undefined }),
    parts: partsOf(value.parts),
  };
}

/**
 * Upload records on the platform's database, over HTTP.
 *
 * @internal
 */
export function createPlatformUploadRecords(options: PlatformUploadRecordsOptions): UploadRecords {
  return {
    // Nothing to ensure and nothing to send — see the module doc. Not a no-op by
    // omission: the seam requires the method, and answering it locally is what
    // saves a round trip before every other call.
    ensure: () => Promise.resolve(),

    async read(id) {
      return recordOf(await call(options, "read", id));
    },

    async claim(id, record) {
      await call(options, "claim", id, {
        name: record.name,
        type: record.type,
        size: record.size,
        complete: record.complete,
        // Only when present: sending `expected: null` would make the platform store
        // a declared total of nothing, which is a different upload kind.
        ...omitUndefined({ expected: record.expected }),
        parts: record.parts,
      });
    },

    async insert(id, record) {
      await call(options, "insert", id, {
        name: record.name,
        type: record.type,
        size: record.size,
        complete: record.complete,
        ...omitUndefined({ expected: record.expected }),
        parts: record.parts,
      });
    },

    async update(id, state) {
      await call(options, "update", id, {
        size: state.size,
        complete: state.complete,
        parts: state.parts,
      });
    },

    async finish(id, size) {
      await call(options, "finish", id, { size });
    },
  };
}
