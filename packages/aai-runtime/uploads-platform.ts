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
 * rather than becoming a generic error the store would retry. Everything else
 * non-2xx throws, because the store above has no fallback and a silent failure
 * would mean an upload whose bytes are in the bucket and whose record says nothing
 * arrived.
 */

import { isRecord, omitUndefined } from "@alexkroman1/aai/utils";
import { partsOf } from "./_upload-blobs.ts";
import type { UploadRecord, UploadRecords } from "./_upload-records.ts";
import { UploadIdTakenError } from "./_upload-store.ts";
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

/** One call to the platform's upload-records route. */
async function call(
  opts: PlatformUploadRecordsOptions,
  method: string,
  id: string,
  body: Record<string, unknown> = {},
): Promise<unknown> {
  return await platformResult(opts, {
    route: PLATFORM_ROUTES.uploadRecords,
    label: `upload-records ${method}`,
    timeoutMs: UPLOAD_RECORD_TIMEOUT_MS,
    body: JSON.stringify({ method, id, ...body }),
    // The one non-2xx that is not a failure — see the module doc. Translated back
    // into the store's own error so `claim`'s contract holds across all three
    // backends, and decided from the STATUS alone: what the platform said about a
    // refused id does not change what a refused id means.
    errorFor: (status) => (status === 409 ? new UploadIdTakenError(id) : undefined),
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
export function createPlatformUploadRecords(opts: PlatformUploadRecordsOptions): UploadRecords {
  return {
    // Nothing to ensure and nothing to send — see the module doc. Not a no-op by
    // omission: the seam requires the method, and answering it locally is what
    // saves a round trip before every other call.
    ensure: () => Promise.resolve(),

    async read(id) {
      return recordOf(await call(opts, "read", id));
    },

    async claim(id, record) {
      await call(opts, "claim", id, {
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
      await call(opts, "insert", id, {
        name: record.name,
        type: record.type,
        size: record.size,
        complete: record.complete,
        ...omitUndefined({ expected: record.expected }),
        parts: record.parts,
      });
    },

    async update(id, state) {
      await call(opts, "update", id, {
        size: state.size,
        complete: state.complete,
        parts: state.parts,
      });
    },

    async finish(id, size) {
      await call(opts, "finish", id, { size });
    },
  };
}
