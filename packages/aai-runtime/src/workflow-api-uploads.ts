// Copyright 2026 the AAI authors. MIT license.
/**
 * The upload WRITES: putting a file somewhere a run can reach.
 *
 * ```text
 * POST /workflows/uploads?name=recording.wav   → 201 { id, …, complete: true }
 * PUT  /workflows/uploads/:id?name=…           → 201 { id, …, complete: true }
 * POST /workflows/uploads/:id/parts?total=…    → 201 { id, …, complete: false }
 * PUT  /workflows/uploads/:id/parts?offset=…   → 200 { id, …, complete }
 * PUT  …/parts?offset=&offset=…&stored=1       → 200 { id, …, complete }
 * ```
 *
 * The two `GET`s are `workflow-api-uploads-read.ts`, which carries why the halves
 * are separate modules. `_upload-route-failures.ts` is the refusal vocabulary they
 * share.
 *
 * ## POST mints the id; PUT lets the caller choose it
 *
 * The pair is not redundant, and the difference decides whether a run can start
 * before the bytes are in. `POST` answers with an id once the LAST byte is stored,
 * which is the only honest thing it can do — so a form that needs the id in a run
 * input has to wait for the whole upload. `PUT` takes the id in the path, so the
 * caller already has it: start the run, then stream the file, and the run reads
 * what has arrived. `GET …/info` is how anything other than a step watches that
 * happen; a step reads the same record in-process through `stepUploadInfo`.
 *
 * Split from `workflow-api.ts` because nothing here is about runs — the store is
 * the only thing these two touch, and the module they came out of is the one
 * place a route may only do what a tool can do.
 *
 * ## The two `/parts` routes are ONE upload over SEVERAL connections
 *
 * `POST` and `PUT` above each carry a whole file in one request, so an upload runs
 * at the speed of one connection to the agent — which over any real distance is a
 * fraction of the link. The `/parts` pair splits it: `POST …/parts` declares the id
 * and the total, and then any number of concurrent `PUT …/parts?offset=` requests
 * fill in windows of it.
 *
 * Everything about a part is the same as a whole-file `PUT` — the body is the
 * bytes, the cap is the same, the id is the caller's — and the two rules that come
 * with it are the store's rather than this module's: a part starts on a megabyte
 * boundary, and `size` reports the CONTIGUOUS prefix, so nothing downstream (the
 * range route, `stepReadUpload`, a run polling `size`) learns that parts exist.
 * `workflow-uploads.ts` carries the argument.
 *
 * ## The body is the FILE, not a multipart envelope
 *
 * `POST` takes the bytes raw: the filename rides in `?name=` and the type in
 * `Content-Type`. That is what lets the body stream straight into the store,
 * which holds a bounded few windows of it at a time and never the file — a
 * multipart parse would mean a boundary scanner and a dependency, for an envelope
 * carrying exactly one part. Both
 * callers are ours (`api.upload()` in the browser, `curl --data-binary`
 * everywhere else) and neither wanted the envelope.
 */

import type http from "node:http";
import { UPLOAD_CLAIM_BATCH, UPLOAD_TOKEN_RE } from "@alexkroman1/aai/host-internal";
import { requestQuery, WORKFLOW_API_PREFIX } from "@alexkroman1/aai/internal";
import type { UploadInfo } from "@alexkroman1/aai/step";
import { decodePathSegment } from "./_path-decode.ts";
import { sendUploadFailure } from "./_upload-route-failures.ts";
import type { Logger } from "./runtime-config.ts";
import { sendJson } from "./workflow-api-http.ts";
import type { UploadMeta, UploadStore } from "./workflow-uploads.ts";

/** Path the upload routes live under. */
export const UPLOADS_PATH = `${WORKFLOW_API_PREFIX}/uploads`;

/** Suffix the two multi-part routes hang off `…/uploads/:id`. */
export const UPLOAD_PARTS_SUFFIX = "/parts";

/**
 * What a caller-chosen id has to look like.
 *
 * Answered by {@link uploadIdOr400} for every `/uploads/:id` route. The check used
 * to be per-route and only two routes had it, which left the other three taking a
 * 500 from the store's own throw for the same mistake.
 */
const CHOSEN_ID_MESSAGE =
  "A caller-chosen upload id is 1-64 characters of letters, digits, `-` and `_` — a " +
  "`crypto.randomUUID()` already qualifies.";

/**
 * The upload id in this path, or `undefined` having ALREADY answered 400.
 *
 * The same shape as `runIdOr400` in `workflow-api.ts` and for the same reason: a path
 * segment is percent-decoded, `decodeURIComponent` throws on a malformed escape, and
 * no decode site in this package may let that reach the router's catch as a 500.
 *
 * **The GRAMMAR is checked here, for every `/uploads/:id` route rather than in three
 * of the five.** It used to sit inside the two writes that take a caller-chosen id,
 * so the other three answered a bad id from the store: `assertUploadToken` throws a
 * plain `Error`, `sendUploadFailure` can only classify the store's five typed
 * failures, and the router's catch turned a plainly bad request into
 * `500 Internal server error` with the reason in the log and not in the answer. That
 * split the same class of mistake across two statuses — `POST …/not..valid/parts`
 * said 400 and named the grammar, `GET …/not..valid/info` said 500 — which is the
 * thing `_upload-route-failures.ts` argues a client must never have to guess at.
 *
 * Rejecting before the store is also what keeps the id grammar a boundary rule: an
 * id that would escape the store never reaches one, whichever verb asked.
 */
export function uploadIdOr400(
  res: http.ServerResponse,
  url: string,
  suffix = "",
): string | undefined {
  const id = decodePathSegment(
    url.slice(UPLOADS_PATH.length + 1, suffix ? -suffix.length : undefined),
  );
  if (id === undefined) {
    sendJson(res, 400, { error: "Malformed upload id" });
    return undefined;
  }
  if (!UPLOAD_TOKEN_RE.test(id)) {
    sendJson(res, 400, { error: CHOSEN_ID_MESSAGE });
    return undefined;
  }
  return id;
}

/** What `POST` and `PUT /workflows/uploads` answer with. */
export type UploadCreated = UploadInfo & {
  /**
   * Present and `true` when a part's bytes go to the PLATFORM rather than here.
   *
   * A capability of the deployment, answered by the claim so a client never has to
   * guess: a deployed agent holds no bucket credential and brokers every byte
   * operation, so the platform serves a byte route of its own and a part sent here
   * would cross it twice. `aai dev` and a self-hosted server hold the credential
   * themselves and have no such route, so the field is ABSENT and a client keeps
   * sending bodies to `PUT …/parts?offset=`.
   *
   * Absent also covers an agent deployed before this existed, which is the same
   * answer and the right one.
   */
  directParts?: boolean | undefined;
  /**
   * How many landed offsets one `stored=1` claim may name, when batching is on.
   *
   * Present only alongside {@link directParts}, because a part whose BODY comes
   * here is recorded by the request that carries it — there is no separate claim
   * to batch. Absent means one offset per claim, which is what an agent deployed
   * before this answers and what a client must therefore assume.
   *
   * **A client may not infer this from `directParts`.** The two shipped in
   * different versions, and guessing wrong is the one mistake with no symptom: an
   * agent reading a single `?offset=` out of a batched claim would record the
   * first window, answer 200, and leave the rest as holes that read as silence
   * later, in a step, with nothing reporting an error. See
   * `UPLOAD_CLAIM_BATCH`.
   */
  claimBatch?: number | undefined;
  /**
   * Where the bytes are, relative to the API's own prefix.
   *
   * Relative rather than absolute because only the CALLER knows the origin it
   * reached this agent on: on the platform that is `/:slug/workflows/...`, under
   * `aai dev` it is the dev server, and a guest answering with its own sandbox
   * URL would hand out a link that dies with the sandbox.
   */
  url: string;
};

/** What the uploader declared about the file, off the query and the header. */
function declaredMeta(req: http.IncomingMessage): UploadMeta {
  const type = req.headers["content-type"];
  return {
    name: requestQuery(req.url).get("name") ?? undefined,
    // The declared type, minus any `; charset=` parameter — it describes the
    // request, not the file.
    type: typeof type === "string" ? (type.split(";")[0] ?? "").trim() : undefined,
  };
}

/** `POST /workflows/uploads` — store the request body and answer with its id. */
export async function createUpload(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  store: UploadStore,
  logger: Logger,
): Promise<void> {
  try {
    const info = await store.create(declaredMeta(req), req);
    logger.info("Workflow upload stored", { id: info.id, name: info.name, size: info.size });
    sendJson(res, 201, { ...info, url: `${UPLOADS_PATH}/${info.id}` } satisfies UploadCreated);
  } catch (err: unknown) {
    if (sendUploadFailure(res, err)) return;
    throw err;
  }
}

/**
 * `PUT /workflows/uploads/:id` — store the body under the caller's own id,
 * readable as it arrives.
 *
 * The route that lets a run start first. Everything about it is the same as the
 * `POST` except who names the upload, and that one difference is the feature: the
 * caller has the id before the bytes leave, so it can go in a run input.
 */
export async function streamUpload(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  store: UploadStore,
  id: string,
  logger: Logger,
): Promise<void> {
  // The id's grammar was checked by `uploadIdOr400`, which is the only caller and
  // now checks it for every upload route rather than for this one and the claim.
  try {
    const info = await store.stream(id, declaredMeta(req), req);
    logger.info("Workflow upload streamed", { id: info.id, name: info.name, size: info.size });
    sendJson(res, 201, { ...info, url: `${UPLOADS_PATH}/${info.id}` } satisfies UploadCreated);
  } catch (err: unknown) {
    if (sendUploadFailure(res, err)) return;
    throw err;
  }
}

/**
 * `POST /workflows/uploads/:id/parts?total=<bytes>` — declare an upload its parts
 * will fill in.
 *
 * No body: this is the CLAIM, and the bytes arrive through {@link writeUploadPart}.
 * The total is declared here rather than inferred from the parts because
 * `complete` has to be answerable — with parts landing in any order, "the last one
 * arrived" is not something a server can observe, and an upload nothing ever
 * declares finished is one a run waits on forever.
 */
export async function beginUploadParts(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  store: UploadStore,
  id: string,
  logger: Logger,
  directParts = false,
): Promise<void> {
  const declared = requestQuery(req.url).get("total");
  const total = Number(declared);
  if (declared === null || !Number.isFinite(total)) {
    sendJson(res, 400, {
      error: "A parts upload declares the file's whole size in bytes as `?total=`.",
    });
    return;
  }
  try {
    const info = await store.beginParts(id, declaredMeta(req), total);
    logger.info("Workflow parts upload begun", { id: info.id, name: info.name, total });
    sendJson(res, 201, {
      ...info,
      url: `${UPLOADS_PATH}/${info.id}`,
      // `undefined` rather than `false` when the bytes come here, and `sendJson`'s
      // `JSON.stringify` drops it: a client reads the field's PRESENCE, and absent is
      // also what an agent deployed before this existed answers — one shape for "send
      // the body to me", not two.
      directParts: directParts ? true : undefined,
      // Same presence rule and the same reason: a client reads whether the field is
      // THERE, and absent is what every older agent answers.
      claimBatch: directParts ? UPLOAD_CLAIM_BATCH : undefined,
    } satisfies UploadCreated);
  } catch (err: unknown) {
    if (sendUploadFailure(res, err)) return;
    throw err;
  }
}

/**
 * `PUT /workflows/uploads/:id/parts?offset=<byte>` — store one window of a parts
 * upload, or RECORD one that is already stored.
 *
 * Answers the record as it now stands, so the caller writing the part that closes
 * the last gap learns the upload is complete from its own response rather than by
 * polling for it. 200 rather than 201: a part creates nothing, it fills in a
 * resource that already exists.
 *
 * ## `&stored=1` is the direct path, and it is the same route on purpose
 *
 * With `stored=1` the request carries NO body: the client sent the window straight
 * to the byte store and is telling the agent which window landed. Everything else
 * about it is identical — the id, the offset grid, the answer — which is what lets a
 * client take either route without anything downstream knowing, and lets a page
 * built against the body form keep working where the direct path is unavailable
 * (`aai dev` against a bucket the browser cannot reach).
 *
 * A separate PATH would have been the other option and is worse: the two are one
 * operation with one set of refusals, and a second route is a second place for the
 * offset rule, the 404 and the 400 to drift.
 *
 * The flag says nothing about how big the part is. `recordParts` asks the STORE, and
 * that is the whole defence: a client claiming a part it never uploaded would
 * otherwise advance `size` past a hole, and a step reading there gets silence.
 *
 * ## A claim may name SEVERAL windows, and that is where an upload's time went
 *
 * `?offset=0&offset=8388608&…&stored=1`. The claim carries no bytes and measured
 * 1604-1969 ms against a deployed agent — per PART, about half of an upload's wall
 * clock — because it crosses the platform into the sandbox and then costs the guest
 * a read of the record and a probe of the bucket per window. Naming several windows
 * in one request collapses the record half to one read and one write however many
 * landed, and `UPLOAD_CLAIM_BATCH` carries the measurement; what the probes then
 * cost is `UPLOAD_PROBE_CONCURRENCY`'s.
 *
 * Repeated query parameters rather than a JSON body, because the request that has
 * always been body-less staying body-less is what lets this be the same route: a
 * body here would have to be read, capped and parsed, and `writePart`'s body is the
 * FILE. `UPLOAD_CLAIM_BATCH` bounds the list so one request cannot ask for
 * unbounded work.
 *
 * **Only the body-less form is a list.** A part carrying bytes names the one byte
 * they start at, and a second offset beside a body is a 400 rather than something
 * to interpret.
 */
export async function writeUploadPart(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  store: UploadStore,
  id: string,
): Promise<void> {
  const query = requestQuery(req.url);
  // `getAll`, because a claim may name every window that has landed since the last
  // one — see `UPLOAD_CLAIM_BATCH`. One `?offset=` is the same request with a
  // list of one, which is what keeps the batched and unbatched forms one route with
  // one set of refusals.
  const offsets = query.getAll("offset").map(Number);
  // `first === undefined` IS the no-offset case under `noUncheckedIndexedAccess`, so
  // reading it here is both the guard and what saves a cast at the `writePart` call.
  const [first] = offsets;
  if (first === undefined || offsets.some((one) => !Number.isFinite(one))) {
    sendJson(res, 400, { error: "A part names the byte it starts at as `?offset=`." });
    return;
  }
  if (offsets.length > UPLOAD_CLAIM_BATCH) {
    sendJson(res, 400, {
      error: `A claim names at most ${UPLOAD_CLAIM_BATCH} parts; this one named ${offsets.length}.`,
    });
    return;
  }
  const stored = query.get("stored") !== null;
  // A BODY carries one window and names where it starts, so a second offset is a
  // caller that has composed the wrong request rather than one asking for something
  // this route could do. Only the body-less claim is a list.
  if (!stored && offsets.length > 1) {
    sendJson(res, 400, {
      error: "A part carrying a body names one `?offset=`; several is only for `&stored=1`.",
    });
    return;
  }
  try {
    sendJson(
      res,
      200,
      stored ? await store.recordParts(id, offsets) : await store.writePart(id, first, req),
    );
  } catch (err: unknown) {
    if (sendUploadFailure(res, err)) return;
    throw err;
  }
}
