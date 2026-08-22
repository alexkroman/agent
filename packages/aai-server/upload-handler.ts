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
 * What it does NOT do is make the object count for anything. A window in the bucket
 * that no `recordParts` ever named is invisible to every reader: `size` comes from the
 * agent's own row, and the store asks the bucket for a part's length before it
 * records one. So the worst an unrecorded write achieves is an orphan.
 *
 * ## A WRITE requires the agent to exist, which is what bounds that orphan
 *
 * "The worst is an orphan" is only reassuring if the number of prefixes an orphan
 * can appear under is bounded, and for a while it was not: `slugMw` validates a
 * slug's SHAPE and its reserved names, never its existence, so
 * `PUT /no-such-agent-here/uploads/upl_x/0` answered **201** and put bytes at
 * `uploads/no-such-agent-here/upl_x/0`. Measured against production. Nothing
 * reclaims them either — `aai-sweep-blob-gc` matches `name like 'blobs/%'` — so an
 * unauthenticated caller could mint unbounded prefixes in a bucket shared by every
 * tenant, and the platform had no record that any of them existed.
 *
 * So a write now costs one indexed column read (`store.getAgentVersion`) and answers the
 * same 404 an unknown agent gets everywhere else. That is the STRONGEST check
 * available at this layer and deliberately not the one you would want: the upload
 * RECORD lives in the app's own database, which only the guest can reach, so the
 * platform cannot ask whether this id was ever claimed. What it can say is that the
 * prefix belongs to an agent somebody deployed.
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

import { UPLOAD_TOKEN_RE, UploadTooLargeError } from "@alexkroman1/aai-runtime";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { HonoEnv } from "./context.ts";
import { notFoundMessage } from "./sandbox-broker.ts";
import { UPLOAD_READ_URL_TTL_SECONDS, type UploadBytes, uploadKey } from "./upload-bytes.ts";

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
function windowKey(c: Context<HonoEnv>): string {
  const id = c.req.param("id") ?? "";
  const raw = c.req.param("offset") ?? "";
  if (!UPLOAD_TOKEN_RE.test(id)) {
    throw new HTTPException(400, { message: "Not an upload id." });
  }
  const offset = Number(raw);
  if (!(OFFSET_RE.test(raw) && Number.isSafeInteger(offset))) {
    throw new HTTPException(400, { message: "A window is named by the byte it starts at." });
  }
  return uploadKey(c.var.slug, id, offset);
}

/**
 * The handler for all three methods.
 *
 * One function rather than three, because the three share the key derivation and
 * that is the part that must not be got wrong twice.
 */
export function createUploadBytesHandler(bytes: UploadBytes) {
  return async (c: Context<HonoEnv>): Promise<Response> => {
    const key = windowKey(c);
    if (c.req.method === "PUT") {
      await assertAgentExists(c);
      return await storeWindow(c, bytes, key);
    }
    if (c.req.method === "HEAD") return await measureWindow(c, bytes, key);
    return await serveWindow(c, bytes, key);
  };
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
  if (signed) return c.redirect(signed, 302);

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
