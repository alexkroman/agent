// Copyright 2026 the AAI authors. MIT license.
/**
 * `POST /:slug/workflow-storage` — the guest's Storage calls, scoped and forwarded.
 *
 * One route rather than eleven, and that is a decision about where the tenant check
 * lives. Eleven REST paths would mean eleven bearer checks and eleven places to
 * restate a scoping rule — and the dangerous mistake in this surface is forgetting
 * one. Here the bearer is checked once, `decideScope` classifies the call from a
 * closed table, and `serve()` is the only thing that can reach the world.
 *
 * The request is `{ method, args }` and the reply is the DevKit's own return value.
 * The platform models neither: their params and entities are their business, and a
 * schema here would be a second copy of it to keep current.
 *
 * ## Where the scoping went
 *
 * The per-scope enforcement is `workflow-storage-apply.ts`, which this file calls
 * through one `serve()`. Three files, three jobs: `workflow-storage-scope.ts`
 * DECIDES how a method is scoped (a total record, so a new method is a compile
 * error), `-apply.ts` ENFORCES it, and this is the HTTP surface — bearer, body
 * codec, pooled connection, status taxonomy. Read the apply module for the four
 * rules that are not "check a run id" and for the never-403 argument that governs
 * all of them.
 *
 * ## Why a failed check is a 404 and not a 403
 *
 * "You do not own this run" and "there is no such run" have to be the same answer.
 * A 403 says a run id exists, which is the one bit a caller must not be able to
 * probe for — run ids are ULIDs, and their unguessability is only worth something
 * if nothing confirms a guess.
 */

import { isRecord } from "@alexkroman1/aai/utils";
import {
  decodeStorageJson,
  encodeStorageJson,
  PLATFORM_ROUTES,
} from "@alexkroman1/aai-runtime/internal";
import { HTTPException } from "hono/http-exception";
import { guestSlug, notConfigured, withReserved } from "./_platform-route.ts";
import type { AppContext } from "./context.ts";
import { createLogger } from "./logger.ts";
import type { AdminDb } from "./platform-lock.ts";
import { type StorageCall, serve } from "./workflow-storage-apply.ts";
import { isStorageMethod } from "./workflow-storage-scope.ts";
import type { PlatformWorldStorage } from "./workflow-storage-world.ts";

const log = createLogger("workflow.storage");

/**
 * This route's own path under `/:slug`.
 *
 * From `PLATFORM_ROUTES`, not a literal: the guest client that CALLS this route
 * (`aai-runtime/platform-endpoint.ts`) is the other half of one wire, and a
 * literal on each side is a rename away from a 404 the runtime can only report as
 * `answered HTTP 404`. `aai-server` already imports that package's `/internal`;
 * the dependency does not run the other way, which is why the table lives there.
 */
export const WORKFLOW_STORAGE_ROUTE = PLATFORM_ROUTES.workflowStorage;

/**
 * Cap on a storage request body.
 *
 * `events.create` carries a step's arguments or a run's output, which is the
 * largest thing on this surface. 4 MiB is well above every real one — a run with
 * a large payload uses the upload surface — and bounded well below anything worth
 * buffering on a route that writes to the platform's database.
 */
export const MAX_STORAGE_BODY_BYTES = 4_194_304;

/** The request body, or undefined when it is not JSON this route can read. */
function decodeBody(text: string): unknown {
  try {
    return decodeStorageJson(text);
  } catch {
    return undefined;
  }
}

function parseCall(raw: unknown): StorageCall {
  if (!isRecord(raw)) throw new HTTPException(400, { message: "body must be a JSON object" });
  if (!isStorageMethod(raw.method)) {
    // The value is NOT echoed. It is caller-supplied and this reply is a tenant's
    // to read, so naming the method set is the useful half without reflecting
    // input back.
    throw new HTTPException(400, { message: "unknown storage method" });
  }
  if (!Array.isArray(raw.args)) throw new HTTPException(400, { message: "args must be an array" });
  return { method: raw.method, args: raw.args };
}

export type StorageHandlerOptions = {
  adminDb?: AdminDb | undefined;
  /** The platform's world, or undefined when there is no database behind it. */
  storage?: PlatformWorldStorage | undefined;
};

/**
 * Build the storage handler.
 *
 * @internal
 */
export function createWorkflowStorageHandler(
  opts: StorageHandlerOptions,
): (c: AppContext) => Promise<Response> {
  return async (c) => {
    const slug = await guestSlug(c);
    const { adminDb, storage } = opts;
    // 501, like the enqueue route: there is no run storage on this deployment and
    // a retry will not make one.
    if (!(adminDb && storage)) throw notConfigured("platform run storage");
    // DECODED with the binary reviver, not `c.req.json()`. A run's input and a
    // step's arguments are `Uint8Array` at specVersion >= 2, and plain JSON turns
    // one into an index map — so the world would be handed `{"0":7}` where it
    // expects bytes, and nothing would error until devalue failed to read it. See
    // `aai-runtime/workflow-typed-json.ts`, which is the codec BOTH sides use.
    const call = parseCall(decodeBody(await c.req.text()));

    return await withReserved(
      adminDb,
      { log, failure: "storage call failed", detail: { slug, method: call.method } },
      async (sql) => {
        const result = await serve(call, { slug, sql, storage });
        // ENCODED the same way, for the same reason in the other direction:
        // `runs.get` returns input and output, and `c.json` would flatten both.
        // `ok` rides along because a VOID method's `result` does not survive
        // `JSON.stringify` — see the client's own note in
        // `aai-runtime/workflow-platform-storage.ts`. Without it `writeToStream`
        // answered `{}` and the guest read its own success as a protocol error.
        return new Response(encodeStorageJson({ ok: true, result }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    );
  };
}
