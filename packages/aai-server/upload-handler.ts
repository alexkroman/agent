// Copyright 2026 the AAI authors. MIT license.
/**
 * `PUT/GET/HEAD /:slug/uploads/:id/:offset` — one window of a workflow upload's
 * bytes, in the platform's own bucket.
 *
 * The route the bytes take instead of the guest. A part used to travel
 * browser → platform → guest → the app's Postgres, which cost the app's database
 * six times what file storage costs, put every upload byte in the WAL and in every
 * base backup, and shared the guest's connection pool with its own queries. Worse,
 * `guest-forward.ts` measures how fast a guest drains a body to decide whether it is
 * alive, so an upload that was storing perfectly well read as a stall and was
 * aborted at ~121s. `aai/host/_upload-blobs.ts` has the measurements.
 *
 * Now the browser PUTs here and then tells the agent one window landed
 * (`PUT /:slug/workflows/uploads/:id/parts?offset=…&stored=1`, a request with no
 * body). The guest reads through this same route. So no upload byte reaches a guest
 * or a tenant database at all, and the guest holds no bucket credential — which is
 * the whole reason this is a platform route rather than a guest one. See
 * `upload-bytes.ts` and `aai/host/_upload-blobs.ts`, "Signing is NOT here".
 *
 * ## The KEY is composed here, from the slug
 *
 * `uploadKey(slug, id, offset)` and nothing the caller sends. The slug comes from the
 * path Hono matched against the slug grammar, the id is checked against the SDK's own
 * `UPLOAD_TOKEN_RE`, and the offset has to parse as a non-negative integer. So a
 * caller cannot address another agent's prefix, and cannot address anything outside
 * the prefix at all — which matters more here than in most places, because this is
 * the one route that writes into a bucket shared by every tenant.
 *
 * ## It is as PUBLIC as the routes beside it
 *
 * No authentication, exactly like `GET /:slug/client-config`, `POST /:slug/phone`
 * and the whole `/:slug/workflows/*` API. An upload id is `upl_` plus a hyphenless
 * UUID, so a read is guarded by 122 bits the same way
 * `GET /:slug/workflows/uploads/:id` already is; a write is reachable by anyone who
 * can already `POST /:slug/workflows/uploads` and put two gigabytes somewhere. This
 * moves where those bytes land — it does not widen what a stranger holding a slug
 * can do.
 *
 * What a write does NOT do is make a NEW object count for anything. A window in the
 * bucket that no `recordParts` ever named is invisible to every reader: `size` comes
 * from the upload's own record, and the store asks the bucket for a part's length
 * before it records one. So the worst an unrecorded write at a FRESH key achieves is
 * an orphan.
 *
 * A write at a key some record already names is a different thing entirely, and it
 * is the one this route has to refuse — see {@link assertUploadOpen}. That paragraph
 * used to end here, and "the worst is an orphan" was read as covering the whole
 * verb.
 *
 * ## A WRITE requires the agent to exist, which is what bounds that orphan
 *
 * "The worst is an orphan" is only reassuring if the number of prefixes an orphan
 * can appear under is bounded, and for a while it was not: `slugMw` validates a
 * slug's SHAPE and its reserved names, never its existence, so
 * `PUT /no-such-agent-here/uploads/upl_x/0` answered **201** and put bytes at
 * `uploads/no-such-agent-here/upl_x/0`. Measured against production. Nothing
 * reclaimed them either — `aai-sweep-blob-gc` matched `name like 'blobs/%'` — so an
 * unauthenticated caller could mint unbounded prefixes in a bucket shared by every
 * tenant, and the platform had no record that any of them existed.
 *
 * Both halves of that are closed now. This route is the first: a prefix belongs to
 * an agent somebody deployed. The GC is the second — it grew an UPLOADS arm that
 * reclaims a window no `workflow_uploads` row names, so the orphans this guard
 * bounds are also finite in TIME rather than merely in number. See
 * {@link sweepBlobGc}; the grace window there exists for the one flow that writes
 * bytes before its record, which is the flow below.
 *
 * So a write costs one indexed column read (`store.getAgentVersion`) and answers the
 * same 404 an unknown agent gets everywhere else. What it says is that the prefix
 * belongs to an agent somebody deployed.
 *
 * **And a second indexed read says whether the upload is FINISHED**, which this
 * layer could not ask when the paragraph above was written — the record lived in the
 * app's own database and only the guest could reach it. It is
 * `aai_platform.workflow_uploads` now (`platform-uploads.ts`), keyed by the same
 * `(slug, id)` this route already holds, so the question is a primary-key lookup on
 * a connection the platform has. {@link assertUploadOpen} carries what it refuses
 * and why the condition is "complete" rather than "the object exists".
 *
 * **Reads are NOT gated, and that is a cost decision.** A read is the fan-out — sixty
 * steps each taking their own window — so a lookup there is sixty extra queries per
 * run to establish something a miss already reports: an unknown slug has no objects,
 * so the answer is the 404 it would get anyway, and the key space is guarded by the
 * upload id's 122 bits regardless.
 *
 * ## Reads REDIRECT, writes do not
 *
 * A read is a fan-out — sixty steps each taking their own window of one recording —
 * so answering them from here would move the whole file through the platform once
 * per run. A 302 to a signed URL carries no body, and `fetch` follows it with the
 * `Range` header intact. A write has no equivalent: there is one of them per window,
 * and a signed upload URL would cost the browser an extra round trip per part to save
 * the platform a hop it takes anyway.
 */

import { UploadTooLargeError } from "@alexkroman1/aai-runtime";
import { UPLOAD_TOKEN_RE } from "@alexkroman1/aai-runtime/internal";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { guestTrace, withReserved } from "./_platform-route.ts";
import type { HonoEnv } from "./context.ts";
import { createLogger } from "./logger.ts";
import { callerReachableUrl } from "./microsandbox-network.ts";
import type { AdminDb } from "./platform-lock.ts";
import { readUpload } from "./platform-uploads.ts";
import { notFoundMessage } from "./sandbox-broker.ts";
import { UPLOAD_READ_URL_TTL_SECONDS, type UploadBytes, uploadKey } from "./upload-bytes.ts";

const log = createLogger("uploads.bytes");

/** The path an upload window lives at, under `/:slug`. */
export const UPLOAD_BYTES_ROUTE = "/uploads/:id/:offset";

/** Methods this route answers. Declared once so the registration cannot drift. */
export const UPLOAD_BYTES_METHODS = ["PUT", "GET", "HEAD"] as const;

/**
 * Largest window this route accepts, and it is NOT the file cap.
 *
 * The SDK cuts a body into `UPLOAD_PART_BYTES` (8 MiB) windows and a browser sends
 * parts of that size, so anything an order of magnitude above it is a caller doing
 * something other than what the client does. `MAX_WORKFLOW_UPLOAD_BYTES` (2 GiB)
 * would be the wrong number here: it bounds a FILE, and a file is many windows.
 */
export const MAX_UPLOAD_WINDOW_BYTES = 64 * 1024 * 1024;

/**
 * Canonical decimal, and nothing `Number` would also accept.
 *
 * The agent composes its own key from a NUMBER, so `1e9` and `1000000000` would name
 * the same object by two different paths — one of which no agent will ever ask for.
 * Requiring the canonical spelling keeps the path and the key in bijection, which is
 * what makes "the object at this offset" a single answerable question.
 */
const OFFSET_RE = /^\d{1,16}$/;

/** The window a caller named, or the reason it is not one. */
function windowTarget(c: Context<HonoEnv>): { id: string; key: string } {
  const id = c.req.param("id") ?? "";
  const raw = c.req.param("offset") ?? "";
  if (!UPLOAD_TOKEN_RE.test(id)) {
    throw new HTTPException(400, { message: "Not an upload id." });
  }
  const offset = Number(raw);
  if (!(OFFSET_RE.test(raw) && Number.isSafeInteger(offset))) {
    throw new HTTPException(400, { message: "A window is named by the byte it starts at." });
  }
  return { id, key: uploadKey(c.var.slug, id, offset) };
}

/** What this route needs besides the bytes. */
export type UploadBytesHandlerOptions = {
  /**
   * The platform database, for the ONE question a write has to ask of the record —
   * see {@link assertUploadOpen}. Absent on a deployment with no platform database
   * (the memory stores, and every test that does not pass one), where there is no
   * record to consult and the write proceeds as it always did.
   */
  adminDb?: AdminDb | undefined;
};

/**
 * The handler for all three methods.
 *
 * One function rather than three, because the three share the key derivation and
 * that is the part that must not be got wrong twice.
 */
export function createUploadBytesHandler(bytes: UploadBytes, opts: UploadBytesHandlerOptions = {}) {
  return async (c: Context<HonoEnv>): Promise<Response> => {
    const { id, key } = windowTarget(c);
    if (c.req.method === "PUT") {
      await assertAgentExists(c);
      await assertUploadOpen(c, opts.adminDb, id);
      return await storeWindow(c, bytes, key);
    }
    if (c.req.method === "HEAD") return await measureWindow(c, bytes, key);
    return await serveWindow(c, bytes, key);
  };
}

/**
 * Refuse a write to a window of an upload that is already FINISHED.
 *
 * **A `PUT` here REPLACES an object, and this is the only thing that bounds what it
 * may replace.** The key is `uploads/<slug>/<id>/<offset>`, which is exactly where
 * every window of every upload of that agent lives — a `create`d one, a streamed
 * one, a part — so a second `PUT` at a window a run is about to read swapped the
 * bytes under it and answered 201. Measured: longer, shorter or the same length, all
 * 201, and nothing in the RECORD moved, so `size` and `complete` still described the
 * file that used to be there and no reader had anything to notice. The route is as
 * unauthenticated as `/client-config` beside it and an upload id is the caller's own
 * choice, so this needed no credential and no tenancy mistake — only a slug from a
 * URL and an id from a page.
 *
 * The store's own refusal (`UploadCompleteError`, 409 on `PUT …/parts?offset=`) does
 * not reach this: that one guards the RECORD, and a rewrite here changes no record
 * at all. So both layers refuse, and this is the one that makes a finished upload's
 * bytes immutable.
 *
 * ## Why COMPLETE and not "the object exists"
 *
 * Refusing every overwrite is the stronger rule and it breaks two flows the client
 * genuinely takes, both documented in `aai/sdk/_upload-parts-send.ts`: a window is
 * re-sent as ONE unit after a transport failure or a 5xx, whose response may have
 * been lost after the object landed; and a resumed upload re-sends a window whose
 * bytes are stored but whose CLAIM was lost, that being the only repair that leaves
 * the record and the bucket agreeing. Both act on an upload that is still arriving.
 * A 409 is not in `RETRYABLE_STATUS` and `isResumableFailure` declines it too, so
 * getting this wrong does not degrade an upload — it ends one.
 *
 * A finished upload has no such flow: `storedRanges` reads `complete` as full
 * coverage, so a resume of one sends nothing at all.
 *
 * ## An ABSENT record permits the write, deliberately
 *
 * `POST /workflows/uploads` writes its windows FIRST and its record LAST — an
 * upload does not exist until all of its bytes do — so during that upload there is
 * no row to consult, and a rule of "no record, no write" would refuse the whole
 * route. The same answer covers a deployment whose records live somewhere else.
 * What this closes is the DURABLE hole: once a record says the file is whole, its
 * windows stop being writable, and before that a window is as contended as any
 * other in-flight upload.
 */
async function assertUploadOpen(
  c: Context<HonoEnv>,
  adminDb: AdminDb | undefined,
  id: string,
): Promise<void> {
  if (!adminDb) return;
  const held = await withReserved(
    adminDb,
    {
      log,
      failure: "upload lookup failed",
      detail: { slug: c.var.slug, id },
      trace: guestTrace(c),
    },
    async (sql) => await readUpload(sql, c.var.slug, id),
  );
  if (!held?.complete) return;
  // The store's own wording for the same refusal, so a client meets one sentence
  // whichever route it took to the bytes. 409 for the reason it is there: the
  // request is well formed and the resource is closed, which a client must not
  // retry.
  throw new HTTPException(409, {
    message: `Upload ${id} is complete; its bytes may not be rewritten.`,
  });
}

/**
 * Refuse a write under a slug no agent answers to — see the module doc.
 *
 * `getAgentVersion` rather than `getAgent`: this needs one bit of information, and
 * that is the read which fetches a single column and is cached briefly for exactly
 * this shape of question — where `getAgent` returns the record's credential hashes
 * and client-file list to have them discarded.
 *
 * The 404 is `notFoundMessage`, so a slug that does not exist reads the same here as
 * it does from `/client-config` and the session broker. A caller cannot tell it apart
 * from a slug that exists and holds no such window, which is correct: both are "there
 * is nothing of yours here".
 */
async function assertAgentExists(c: Context<HonoEnv>): Promise<void> {
  const version = await c.env.store.getAgentVersion(c.var.slug);
  if (version === null) {
    throw new HTTPException(404, { message: notFoundMessage(c.var.slug) });
  }
}

/** `PUT` — the window goes into the bucket. */
async function storeWindow(
  c: Context<HonoEnv>,
  bytes: UploadBytes,
  key: string,
): Promise<Response> {
  const body = c.req.raw.body;
  if (!body) throw new HTTPException(400, { message: "A window carries its bytes." });
  // Streamed rather than buffered, for the reason `workflow-handler.ts` gives: this
  // process is memory-bounded and peak usage would otherwise be the arrival rate times
  // a number the caller picks. `put` still has to hold ONE window to hand Storage a
  // length — that is inherent, and it is why the cap is a window's size, not a file's.
  //
  // 413 rather than the router's 500: the cap is part of this route's contract and a
  // caller has to tell "too big" apart from "the platform is broken", the same reason
  // the SDK's own upload routes answer it themselves.
  const stored = await bytes
    .put(key, body, { limit: MAX_UPLOAD_WINDOW_BYTES, ...typeHeader(c) })
    .catch((err: unknown) => {
      if (err instanceof UploadTooLargeError) {
        throw new HTTPException(413, { message: err.message, cause: err });
      }
      throw err;
    });
  return c.json({ bytes: stored }, 201);
}

/**
 * `HEAD` — how many bytes the window holds.
 *
 * Answered here rather than redirected: it is one number, the platform holds the
 * credential, and a 302 would cost a second round trip to learn it.
 */
async function measureWindow(
  c: Context<HonoEnv>,
  bytes: UploadBytes,
  key: string,
): Promise<Response> {
  const size = await bytes.size(key);
  if (size === undefined) return c.body(null, 404);
  return c.body(null, 200, { "Content-Length": String(size), "Accept-Ranges": "bytes" });
}

/** `GET` — a signed redirect, or the bytes when this backend cannot sign. */
async function serveWindow(
  c: Context<HonoEnv>,
  bytes: UploadBytes,
  key: string,
): Promise<Response> {
  const signed = await bytes.readUrl(key, UPLOAD_READ_URL_TTL_SECONDS);
  // 302 rather than 307: the follower re-issues a GET either way, and every client that
  // reads this is ours. `Range` survives a redirect, which is what makes it usable.
  //
  // Through `callerReachableUrl`, because the follower may be a guest inside a
  // microVM and this URL is on the platform's Supabase origin — loopback in local
  // dev, i.e. the VM itself. Unrewritten it killed a durable run four retries
  // later as a bare `TypeError: fetch failed`, with nothing naming the host; that
  // function carries the trace and why the decision is the REQUEST's rather than
  // the backend's (a browser reads through this route too).
  if (signed) return c.redirect(callerReachableUrl(signed, c.req.header("host")), 302);

  // No signing backend — memory, i.e. `aai dev` and the tests. The window is served
  // from here, which is exactly the behaviour that predates signing.
  //
  // SIZE FIRST, which settles the 404 in one lookup. Reading first and then asking
  // for the size to tell "empty window" from "no window" cost a read plus a lookup
  // on exactly the miss path, and it read to `MAX_SAFE_INTEGER` — so a rangeless GET
  // of a full window materialized `MAX_UPLOAD_WINDOW_BYTES` (64 MiB) in one buffer
  // on a developer's machine to answer a request whose production twin moves no
  // bytes at all. The end is now the object's own length.
  const size = await bytes.size(key);
  if (size === undefined) return c.body(null, 404);
  const range = parseRange(c.req.header("range"));
  const found = await bytes.read(key, range?.start ?? 0, Math.min(range?.end ?? size, size));
  // `new Response` rather than `c.body`, whose `Data` is `string | ArrayBuffer |
  // ReadableStream` — a `Uint8Array` is a perfectly good `BodyInit` and the only way
  // through that signature is a cast that stops reporting if the type ever moves.
  return new Response(found, {
    status: range ? 206 : 200,
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(found.length),
      "Accept-Ranges": "bytes",
    },
  });
}

/** The declared content type, when there is one worth storing. */
function typeHeader(c: Context<HonoEnv>): { type?: string } {
  const declared = (c.req.header("content-type") ?? "").split(";")[0]?.trim();
  return declared ? { type: declared } : {};
}

/**
 * One `bytes=a-b` header as `[start, end)`, or `undefined`.
 *
 * Deliberately smaller than the SDK's `parseRange`: this arm exists only for the
 * unsigned backend, whose one caller is the guest's brokered client sending exactly
 * the form it composes. An unparsable header is IGNORED rather than refused, which is
 * what RFC 9110 says and also the friendlier answer — the whole object is legal.
 */
function parseRange(header: string | undefined): { start: number; end: number } | undefined {
  const match = /^bytes=(\d+)-(\d+)$/.exec((header ?? "").trim());
  if (!match) return undefined;
  const [start, last] = [Number(match[1]), Number(match[2])];
  // Inclusive of its last byte, unlike every offset in the store.
  return last >= start ? { start, end: last + 1 } : undefined;
}
