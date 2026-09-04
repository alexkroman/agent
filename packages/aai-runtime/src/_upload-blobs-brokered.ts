// Copyright 2026 the AAI authors. MIT license.
/**
 * {@link UploadBackend} for a DEPLOYED guest: every byte operation is one request to
 * the agent's own public platform surface, and the guest holds no credential.
 *
 * This is the half of `_upload-blobs.ts`'s "Signing is NOT here" that makes the
 * rule true rather than aspirational. The bucket is platform-wide — every tenant's
 * uploads and every tenant's worker bundles are in it — and the guest runs tenant
 * code, so a service key in the guest env is a cross-tenant read of everything.
 * What the guest gets instead is a URL:
 *
 * ```text
 * PUT  <base>/uploads/<id>/<offset>                  → the platform stores the window
 * GET  <base>/uploads/<id>/<offset>  Range: bytes=…  → 302 to a signed read URL
 * HEAD <base>/uploads/<id>/<offset>                  → Content-Length, or 404
 * ```
 *
 * `<base>` is {@link BrokeredUploadBlobsOptions.base} — the agent's public origin
 * plus its slug, which the platform already bakes in as `AAI_PUBLIC_BASE_URL` for
 * durable webhooks. So the guest cannot name another app's prefix even in principle:
 * it does not compose the prefix at all, the slug in the URL it was given is the
 * prefix, and the platform derives the key from that.
 *
 * ## The requests are as public as the routes beside them, and that is not a gap
 *
 * These carry no authentication, exactly like `GET /:slug/client-config`,
 * `POST /:slug/phone` and the whole `/:slug/workflows/*` API they sit next to. An
 * upload id is `upl_` plus a hyphenless UUID, so the read is guarded by 122 bits the
 * same way the existing `GET /:slug/workflows/uploads/:id` route is; the write is
 * reachable by anyone who can already `POST /:slug/workflows/uploads` and put two
 * gigabytes somewhere. Nothing here widens what a stranger with a slug can do — it
 * moves where those bytes land.
 *
 * ## `read` follows the redirect; `size` does not need one
 *
 * A 302 is what keeps the bytes off the platform on the way OUT: the response
 * carries no body, `fetch` follows it with the `Range` header intact, and the guest
 * pulls the window from Storage directly. `size` is answered by the platform itself
 * — it holds the credential, a HEAD moves nothing, and a redirect would cost a
 * second round trip to learn one number.
 *
 * ## Every operation here is RE-ISSUED, because this is a network
 *
 * It reads as an in-process call and it is a request out of a microVM, through the
 * platform's proxy, to a bucket — and it was the one leg of an upload that did not
 * retry. See {@link BYTE_OP_ATTEMPTS} for the production failure that cost, and
 * {@link isTransient} for what is an answer rather than a hiccup.
 */

import { RETRYABLE_STATUS, sleep } from "@alexkroman1/aai/host-internal";
import { jitteredBackoff } from "@alexkroman1/aai/internal";
import { errorMessage, isRecord } from "@alexkroman1/aai/utils";
import pTimeout from "p-timeout";
import { blobFetch } from "./_egress-fetch.ts";
import type { UploadBackend } from "./_upload-blobs.ts";
import { contentLength, IDENTITY_ENCODING } from "./_upload-blobs.ts";
import { collectCapped } from "./_upload-byte-util.ts";

/**
 * How long one byte operation may take.
 *
 * Generous, because the thing being bounded is a window — megabytes over the
 * platform's own network — and a step reading ahead of an uplink is allowed to
 * wait. What it exists to stop is a hung socket parking a step forever: without a
 * bound, a run holds its worker slot until graphile-worker's four-hour job expiry.
 */
const BYTE_OP_TIMEOUT_MS = 120_000;

/**
 * How many times one byte operation is issued before it gives up.
 *
 * **This hop is a network, and it was the only leg of an upload that did not know
 * it.** Every other one retries — the browser's part `PUT` and its claim run on
 * `withRetries` (`sdk/_upload-retry.ts`), the platform's own store client retries
 * Storage — while a `fetch` from here rejecting with `TypeError: fetch failed`
 * reached the route as an unnamed rejection and became a 500. Observed in
 * production: two `PUT …/workflows/uploads/<id>/parts -> 500` on one upload, each
 * preceded by `Workflow API request failed { error: 'fetch failed' }`, and both
 * for a HEAD that measures a window already sitting in the bucket.
 *
 * What made that expensive is `UPLOAD_CLAIM_BATCH`: a claim names up to 32 windows
 * and `recordParts` probes every one of them, all-or-nothing, so ONE transient
 * probe failed a request that had already cost 5-16 seconds and the browser
 * re-sent the whole batch. Three attempts and a sub-second budget buy that back —
 * see {@link BYTE_OP_RETRY_BASE_MS} — against operations that are idempotent by
 * construction: the OFFSET is the object's name, so a re-sent `put` overwrites
 * itself and a re-issued `size` or `read` asks the same question.
 *
 * Bounded at three rather than the browser's four because a claim's probes are
 * concurrent and the caller above this has its own budget: the retry that matters
 * is the one that rides out a reset, and a guest still failing on the third is
 * reporting something the platform has to answer for.
 */
const BYTE_OP_ATTEMPTS = 3;

/**
 * The first backoff between attempts, doubling from there, jittered over the lower
 * half of the window so a claim's concurrent probes do not come back in unison.
 *
 * A quarter of the SDK's own `UPLOAD_RETRY_BASE_MS` because this is the INNER
 * budget: a claim that spends its own waits here also holds the browser's request
 * open, and the whole point is to be cheaper than failing the batch. Worst case
 * over three attempts is ~750 ms against a claim that measured 5-16 s.
 */
const BYTE_OP_RETRY_BASE_MS = 250;

export type BrokeredUploadBlobsOptions = {
  /**
   * The agent's public base URL, slug included — `AAI_PUBLIC_BASE_URL`.
   *
   * A trailing slash is tolerated: this arrives from an operator-set env var, and
   * refusing one would be a boot failure over a character.
   */
  base: string;
  /**
   * Test seam — production takes the pooled HTTP/1.1 `blobFetch`, NEVER
   * `globalThis.fetch`: see `_egress-fetch.ts`.
   */
  fetch?: typeof globalThis.fetch | undefined;
};

/** Path the platform's byte route hangs off the agent's public base. */
export const BROKERED_UPLOADS_PATH = "uploads";

/** {@link UploadBackend} brokered through the platform's own byte route. */
export function createBrokeredUploadBlobs(opts: BrokeredUploadBlobsOptions): UploadBackend {
  const base = opts.base.replace(/\/+$/, "");
  // `blobFetch`, NEVER `globalThis.fetch`: these are several concurrent requests
  // to one origin, some of them carrying megabytes, which is the exact shape undici
  // 8's HTTP/2 default turns into one multiplexed connection and a stream reset with
  // no status. That reset is the `fetch failed` this module's own retry could not
  // ride out — `_egress-fetch.ts` carries the production log and the measurements.
  const call = opts.fetch ?? blobFetch;
  // The key the STORE composes is `<prefix>/<id>/<at>`; the platform composes its
  // own from the slug, so only the last two segments travel. Sliced rather than
  // re-derived so there is one definition of a key's shape (`partKey`).
  const url = (key: string): string =>
    `${base}/${BROKERED_UPLOADS_PATH}/${key.split("/").slice(-2).join("/")}`;

  const send = async (key: string, init: RequestInit, op: string): Promise<Response> => {
    const res = await pTimeout(call(url(key), init), {
      milliseconds: BYTE_OP_TIMEOUT_MS,
      message: `upload blob ${op} for ${key} timed out after ${BYTE_OP_TIMEOUT_MS}ms`,
    });
    return res;
  };

  /**
   * Run one byte operation, re-issuing it while the far side is transiently unable
   * to answer — see {@link BYTE_OP_ATTEMPTS}.
   *
   * It wraps the WHOLE operation rather than just the request, because a body that
   * dies halfway through `arrayBuffer()` is the same failure as a socket that never
   * opened, and only `read` would be covered by the narrower seam.
   */
  const attempt = async <T>(run: () => Promise<T>): Promise<T> => {
    for (let n = 1; ; n += 1) {
      try {
        return await run();
      } catch (err: unknown) {
        if (n >= BYTE_OP_ATTEMPTS || !isTransient(err)) throw err;
        await sleep(retryDelay(n));
      }
    }
  };

  return {
    async put(key, body, options): Promise<number> {
      // Buffered for the reason `_upload-blobs-http.ts` gives — the far side stores
      // one object and needs its length — and bounded by the window, not the file.
      // OUTSIDE `attempt`, and it has to be: this drains the caller's stream, so a
      // second pass over it would send an empty body. The collected array is what
      // makes the re-send below possible at all.
      const bytes = await collectCapped(body, options?.limit);
      await attempt(async () => {
        const res = await send(
          key,
          {
            method: "PUT",
            headers: { "Content-Type": options?.type || "application/octet-stream" },
            body: bytes,
          },
          "write",
        );
        if (!res.ok) throw await brokerError("write", key, res);
      });
      return bytes.length;
    },

    async read(key, start, end): Promise<Uint8Array> {
      if (end <= start) return new Uint8Array(0);
      return await attempt(async () => {
        const res = await send(
          key,
          // `redirect` is left at its default: following the 302 to Storage IS the
          // mechanism — see the module doc.
          { method: "GET", headers: { Range: `bytes=${start}-${end - 1}` } },
          "read",
        );
        // Clamped rather than refused — see `UploadBackend.read`. The body is
        // CANCELLED rather than abandoned: undici keeps a connection with an
        // unread response unusable until it is GC'd, out of the 64 the blob pool
        // allows per origin, and probing for absent windows is what the resume
        // path does in bursts.
        if (res.status === 404 || res.status === 416) {
          await res.body?.cancel();
          return new Uint8Array(0);
        }
        if (!res.ok) throw await brokerError("read", key, res);
        // Inside the retry, so a body that dies mid-stream is re-read rather than
        // reported — the window is a range request and asking again is free.
        return new Uint8Array(await res.arrayBuffer());
      });
    },

    async size(key): Promise<number | undefined> {
      // `identity`, because the answer IS a header and a proxy that re-encodes the
      // response drops it — see {@link IDENTITY_ENCODING} for the one that did.
      return await attempt(async () => {
        const res = await send(key, { method: "HEAD", headers: { ...IDENTITY_ENCODING } }, "head");
        if (res.status === 404) return;
        if (!res.ok) throw await brokerError("head", key, res);
        // Never guessed: `UploadBackend.size` is what stops a part nobody uploaded being
        // recorded as present, so an unmeasurable answer has to read as absent — which
        // includes a response that stated no length at all. `contentLength` owns that
        // distinction, and carries what conflating the two cost.
        return contentLength(res);
      });
    },
  };
}

/**
 * A refusal the far side MEANT — re-issuing the request gets the same answer.
 *
 * The marker {@link isTransient} reads, and the polarity is deliberate: anything
 * NOT named as an answer is worth asking again. A transport failure carries no
 * status at all (`TypeError: fetch failed` is the whole error), so a list of
 * retryable conditions would have to guess at Node's wording, while the set of
 * definite answers is exactly what this module produces itself.
 */
class BrokerRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = BrokerRefusal.name;
  }
}

/**
 * Is this failure worth issuing the same request for again?
 *
 * Three things say no. A {@link BrokerRefusal} is the platform's answer. A
 * `TimeoutError` is {@link BYTE_OP_TIMEOUT_MS} already spent, and retrying it
 * would make the bound it exists to enforce three times what it says. An
 * `AbortError` is the caller having stopped asking, which is an answer of its own.
 *
 * Everything else — a reset, a refused connection, a DNS blip, a body that died
 * mid-stream — is the network, and this hop crosses a microVM boundary and the
 * platform's proxy to reach a bucket.
 */
function isTransient(err: unknown): boolean {
  if (err instanceof BrokerRefusal) return false;
  if (!isRecord(err)) return true;
  return err.name !== "TimeoutError" && err.name !== "AbortError";
}

/**
 * How long to wait before re-issuing — see {@link BYTE_OP_RETRY_BASE_MS}.
 *
 * No `maxMs`: {@link BYTE_OP_ATTEMPTS} is the bound here, so the doubling
 * cannot run away — three attempts off a 250ms base is ~750ms worst case.
 */
function retryDelay(attempt: number): number {
  return jitteredBackoff(attempt, { baseMs: BYTE_OP_RETRY_BASE_MS });
}

/**
 * One failure shape, carrying the status and whatever the platform said.
 *
 * A {@link RETRYABLE_STATUS} — the SDK's own set, so the two ends of this upload
 * cannot disagree about what "come back" means — stays a plain `Error` and is
 * re-issued; anything else is a {@link BrokerRefusal} this operation reports as
 * its answer.
 */
async function brokerError(op: string, key: string, res: Response): Promise<Error> {
  const detail = await res.text().catch((err: unknown) => errorMessage(err));
  const message = `upload blob ${op} failed for ${key}: ${res.status} ${detail.slice(0, 200)}`;
  return RETRYABLE_STATUS.has(res.status) ? new Error(message) : new BrokerRefusal(message);
}
