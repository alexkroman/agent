// Copyright 2026 the AAI authors. MIT license.
/**
 * `POST /:slug/upload-records` — the guest's workflow upload RECORDS.
 *
 * The bytes never come through here: those go to the bucket through the upload
 * broker's own routes. This is the record, and it is the last piece of a guest's
 * durable state that lived on local disk — see `platform-uploads.ts` for why that
 * was wrong and what it cost.
 *
 * ## The shape is `session-state`'s, deliberately
 *
 * `{ method, id, … }` behind one bearer check, dispatched to one statement. The
 * alternative is six routes and six places to restate the same scoping, and the
 * scoping is the only security-relevant thing here.
 *
 * The SLUG comes from the bearer, never from the body — `assertGuestBearer` proves
 * the caller is the guest currently deployed for it, and every statement in the
 * store takes it as a parameter. So a guessed upload id reaches nothing: there is
 * no query that can be pointed at another agent's rows.
 *
 * ## One status is load-bearing beyond the usual
 *
 * A CLAIMED id answers **409**. That is not an error class the other guest routes
 * have, and it is the whole point of `claim` existing separately from `insert`: a
 * caller-chosen id must be refusable, and the refusal has to be distinguishable
 * from "the platform is broken" so the runtime can turn it back into its own
 * `UploadIdTakenError` rather than a retry.
 */

import { isRecord, omitUndefined } from "@alexkroman1/aai/utils";
import { PLATFORM_ROUTES } from "@alexkroman1/aai-runtime/internal";
import { HTTPException } from "hono/http-exception";
import { isOneOf, requiredSize, requiredString } from "./_body-fields.ts";
import {
  guestSlug,
  guestTrace,
  notConfigured,
  type PlatformCall,
  withReserved,
} from "./_platform-route.ts";
import type { AppContext } from "./context.ts";
import { createLogger } from "./logger.ts";
import type { AdminDb } from "./platform-lock.ts";
import {
  claimUpload,
  finishUpload,
  insertUpload,
  PlatformUploadIdTakenError,
  type PlatformUploadPart,
  type PlatformUploadRecord,
  readUpload,
  updateUpload,
} from "./platform-uploads.ts";

const log = createLogger("uploads.records");

/**
 * This route's own path under `/:slug`.
 *
 * From `PLATFORM_ROUTES`, not a literal: the guest client that CALLS this route
 * (`aai-runtime/platform-endpoint.ts`) is the other half of one wire, and a
 * literal on each side is a rename away from a 404 the runtime can only report as
 * `answered HTTP 404`. `aai-server` already imports that package's `/internal`;
 * the dependency does not run the other way, which is why the table lives there.
 */
export const UPLOAD_RECORDS_ROUTE = PLATFORM_ROUTES.uploadRecords;

/**
 * Cap on a request body.
 *
 * A record carries a name, a type, three numbers and a boundary list. The list is
 * the only part that grows — one entry per window — and a whole-file upload of the
 * largest size the store allows produces a few thousand. 1 MiB is far above that
 * and far below anything worth buffering.
 */
export const MAX_UPLOAD_RECORD_BODY_BYTES = 1_048_576;

/**
 * Every method this route serves — the `UploadRecords` seam, minus `ensure`.
 *
 * `ensure` is absent because there is nothing to ensure: the table is a MIGRATION
 * here, not a lazy `create table if not exists`. That laziness existed because an
 * app's first workflow might be its first ever deploy and there was no provisioning
 * pass to hang DDL off; the platform's own schema has one. A guest still calls
 * `ensure` on its backend, and the platform backend answers it locally without a
 * round trip.
 */
const METHODS = ["read", "claim", "insert", "update", "finish"] as const;

type Method = (typeof METHODS)[number];

function isMethod(value: unknown): value is Method {
  return isOneOf(METHODS, value);
}

/** The boundary list off the wire, refusing anything malformed. */
function parts(body: Record<string, unknown>): PlatformUploadPart[] {
  const value = body.parts;
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new HTTPException(400, { message: "parts must be an array" });
  return value.map((entry) => {
    if (!isRecord(entry) || typeof entry.at !== "number" || typeof entry.bytes !== "number") {
      // REFUSED here rather than dropped, unlike the read path: a malformed window
      // arriving from the guest is a bug in the guest, and accepting it would store
      // a record whose prefix silently disagrees with its bytes. On the way OUT a
      // corrupt entry is dropped, because there the alternative is an upload that
      // can never be read at all.
      throw new HTTPException(400, { message: "each part needs a numeric at and bytes" });
    }
    return { at: entry.at, bytes: entry.bytes };
  });
}

/** A full record off the wire, for `claim` and `insert`. */
function record(body: Record<string, unknown>): PlatformUploadRecord {
  const expected = body.expected;
  if (expected !== undefined && (typeof expected !== "number" || !Number.isInteger(expected))) {
    throw new HTTPException(400, { message: "expected must be an integer when present" });
  }
  return {
    name: typeof body.name === "string" ? body.name : "",
    type: typeof body.type === "string" ? body.type : "",
    size: requiredSize(body, "size"),
    complete: body.complete === true,
    // ABSENT is a value here — it is what says "not a parts upload" — so the key is
    // omitted rather than set to undefined.
    ...omitUndefined({ expected }),
    parts: parts(body),
  };
}

export type UploadsHandlerOptions = { adminDb?: AdminDb | undefined };

/**
 * Build the upload-records handler.
 *
 * @internal
 */
export function createUploadsHandler(
  opts: UploadsHandlerOptions,
): (c: AppContext) => Promise<Response> {
  return async (c) => {
    const slug = await guestSlug(c);
    const adminDb = opts.adminDb;
    // 501, like the enqueue, storage and session-state routes: there are no
    // platform upload records on this deployment and a retry will not make any.
    // TERMINAL for the guest — `createUploadStore`'s `opts.platform` arm is taken
    // once, so there is no local store to fall back TO, which is what
    // `uploads-platform.ts` means by "the store above has no fallback". See
    // `notConfigured`.
    if (!adminDb) throw notConfigured("platform upload records");

    const body: unknown = await c.req.json().catch(() => undefined);
    if (!isRecord(body)) throw new HTTPException(400, { message: "body must be a JSON object" });
    if (!isMethod(body.method)) {
      // Not echoed: the value is caller-supplied and this reply is a tenant's to
      // read.
      throw new HTTPException(400, { message: "unknown upload-records method" });
    }
    const method = body.method;
    const id = requiredString(body, "id");
    // Read BEFORE the reservation: a body this route is going to refuse must not
    // take an admin connection to be refused. See `PlatformCall`.
    const call = plan(method, { slug, id }, body);

    return await withReserved(
      adminDb,
      {
        log,
        failure: "upload-records call failed",
        detail: { slug, method },
        trace: guestTrace(c),
        // 409 and NOT logged as a failure: a refused claim is this route working.
        // The runtime turns it back into `UploadIdTakenError`, which is a 409 to
        // the caller who chose the id.
        statusFor: (err) =>
          err instanceof PlatformUploadIdTakenError
            ? new HTTPException(409, { message: "upload id already taken", cause: err })
            : undefined,
      },
      async (sql) => c.json({ result: await call(sql) }, 200),
    );
  };
}

type Ctx = {
  slug: string;
  id: string;
};

/**
 * Read one call's fields and return the work that needs a connection.
 *
 * The slug comes from `ctx`, never from the body. Every `record`, `parts` and
 * `requiredSize` below runs HERE — outside `withReserved` — which is the whole
 * point of the shape: see `PlatformCall`.
 */
function plan(method: Method, ctx: Ctx, body: Record<string, unknown>): PlatformCall {
  const { slug, id } = ctx;
  switch (method) {
    case "read":
      // `null` rather than omitting the key: the guest distinguishes "no record" from
      // a malformed reply, and `{ result: undefined }` serializes to neither.
      return async (sql) => (await readUpload(sql, slug, id)) ?? null;
    case "claim": {
      const claimed = record(body);
      return async (sql) => {
        await claimUpload(sql, slug, id, claimed);
        return null;
      };
    }
    case "insert": {
      const inserted = record(body);
      return async (sql) => {
        await insertUpload(sql, slug, id, inserted);
        return null;
      };
    }
    case "update": {
      const patch = {
        size: requiredSize(body, "size"),
        complete: body.complete === true,
        parts: parts(body),
      };
      return async (sql) => {
        await updateUpload(sql, slug, id, patch);
        return null;
      };
    }
    case "finish": {
      const size = requiredSize(body, "size");
      return async (sql) => {
        await finishUpload(sql, slug, id, size);
        return null;
      };
    }
    default: {
      // Unreachable, and the ASSIGNMENT is what keeps it so — see the twin in
      // `session-state-handler.ts`. `finish` used to live in this arm, so a sixth
      // `METHODS` entry compiled clean and silently finished the upload.
      const unreachable: never = method;
      throw new HTTPException(400, { message: `unknown method ${String(unreachable)}` });
    }
  }
}
