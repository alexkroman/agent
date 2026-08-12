// Copyright 2026 the AAI authors. MIT license.
/**
 * The journal's BLOB half — uploads a run works on, deliberately outside the
 * journal itself.
 *
 * Split from `workflow-store.ts` when it reached the 500-line cap, on the seam the
 * whole feature is built around: replay re-reads every step row and the run input
 * on each resume, so bytes must not travel in them. These four methods are the
 * only ones here that are not about a RUN, which is what makes them the piece to
 * move rather than a slice of the run methods.
 *
 * Spread into the store rather than exposed as a second object, so
 * `WorkflowStore` stays one surface for its callers.
 *
 * @internal
 */

import type { Db } from "../sdk/db.ts";

/**
 * Decoded byte length of a base64 payload, padding accounted for.
 *
 * `length * 3 / 4` is the length of an UNPADDED encoding, and every encoder in
 * the path (`btoa`, `Buffer.toString("base64")`) pads to a multiple of four — so
 * that formula overstates any payload whose length is not a multiple of 3 by one
 * or two bytes. That number is what `putBlob` stores and what the API's upload
 * response reports, while `ctx.blob(id)` hands the run the REAL bytes: a page
 * showing "1,048,578 bytes uploaded" for a 1,048,576-byte file, and a step
 * sizing a request from the stored figure, disagree with each other by a margin
 * no test on a 3-byte-aligned fixture can see.
 */
export function base64ByteLength(base64: string): number {
  const trimmed = base64.trimEnd();
  if (trimmed.length === 0) return 0;
  let padding = 0;
  if (trimmed.endsWith("==")) padding = 2;
  else if (trimmed.endsWith("=")) padding = 1;
  return Math.floor((trimmed.length * 3) / 4) - padding;
}

/** The blob-facing quarter of `WorkflowStore`, bound to one `Db`. */
export function createBlobMethods(db: Db) {
  return {
    async putBlob(blobId: string, contentType: string, base64: string): Promise<void> {
      await db.query(
        `insert into aai_workflow_blobs (blob_id, content_type, data, bytes)
         values ($1, $2, $3, $4)`,
        // The byte count is stored rather than derived on read: every consumer
        // wants it (a page reporting progress, a step sizing a request) and
        // recovering it from base64 means decoding the whole payload.
        [blobId, contentType, base64, base64ByteLength(base64)],
      );
    },

    async getBlob(blobId: string): Promise<{ contentType: string; base64: string } | undefined> {
      const rows = await db.query<{ content_type: string; data: string }>(
        "select content_type, data from aai_workflow_blobs where blob_id = $1",
        [blobId],
      );
      const row = rows[0];
      return row ? { contentType: row.content_type, base64: row.data } : undefined;
    },

    async deleteBlob(blobId: string): Promise<boolean> {
      const rows = await db.query<{ blob_id: string }>(
        "delete from aai_workflow_blobs where blob_id = $1 returning blob_id",
        [blobId],
      );
      return rows.length > 0;
    },

    async pruneBlobs(maxAgeMs: number): Promise<number> {
      const rows = await db.query<{ blob_id: string }>(
        `delete from aai_workflow_blobs
          where created_at < now() - make_interval(secs => $1::float8)
          returning blob_id`,
        [maxAgeMs / 1000],
      );
      return rows.length;
    },
  };
}
