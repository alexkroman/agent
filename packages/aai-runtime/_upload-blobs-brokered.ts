// Copyright 2026 the AAI authors. MIT license.
/**
 * {@link UploadBlobs} for a DEPLOYED guest: every byte operation is one request to
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
 */

import { errorMessage } from "@alexkroman1/aai/utils";
import pTimeout from "p-timeout";
import type { UploadBlobs } from "./_upload-blobs.ts";
import { contentLength, IDENTITY_ENCODING } from "./_upload-blobs.ts";
import { collectCapped } from "./_upload-store.ts";

/**
 * How long one byte operation may take.
 *
 * Generous, because the thing being bounded is a window — megabytes over the
 * platform's own network — and a step reading ahead of an uplink is allowed to
 * wait. What it exists to stop is a hung socket parking a step forever: without a
 * bound, a run holds its worker slot until graphile-worker's four-hour job expiry.
 */
const BYTE_OP_TIMEOUT_MS = 120_000;

export type BrokeredUploadBlobsOptions = {
  /**
   * The agent's public base URL, slug included — `AAI_PUBLIC_BASE_URL`.
   *
   * A trailing slash is tolerated: this arrives from an operator-set env var, and
   * refusing one would be a boot failure over a character.
   */
  base: string;
  /** Test seam — production uses the global. */
  fetch?: typeof globalThis.fetch | undefined;
};

/** Path the platform's byte route hangs off the agent's public base. */
export const BROKERED_UPLOADS_PATH = "uploads";

/** {@link UploadBlobs} brokered through the platform's own byte route. */
export function createBrokeredUploadBlobs(opts: BrokeredUploadBlobsOptions): UploadBlobs {
  const base = opts.base.replace(/\/+$/, "");
  const call = opts.fetch ?? globalThis.fetch;
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

  return {
    async put(key, body, options): Promise<number> {
      // Buffered for the reason `_upload-blobs-http.ts` gives — the far side stores
      // one object and needs its length — and bounded by the window, not the file.
      const bytes = await collectCapped(body, options?.limit);
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
      return bytes.length;
    },

    async read(key, start, end): Promise<Uint8Array> {
      if (end <= start) return new Uint8Array(0);
      const res = await send(
        key,
        // `redirect` is left at its default: following the 302 to Storage IS the
        // mechanism — see the module doc.
        { method: "GET", headers: { Range: `bytes=${start}-${end - 1}` } },
        "read",
      );
      // Clamped rather than refused — see `UploadBlobs.read`.
      if (res.status === 404 || res.status === 416) return new Uint8Array(0);
      if (!res.ok) throw await brokerError("read", key, res);
      return new Uint8Array(await res.arrayBuffer());
    },

    async size(key): Promise<number | undefined> {
      // `identity`, because the answer IS a header and a proxy that re-encodes the
      // response drops it — see {@link IDENTITY_ENCODING} for the one that did.
      const res = await send(key, { method: "HEAD", headers: { ...IDENTITY_ENCODING } }, "head");
      if (res.status === 404) return undefined;
      if (!res.ok) throw await brokerError("head", key, res);
      // Never guessed: `UploadBlobs.size` is what stops a part nobody uploaded being
      // recorded as present, so an unmeasurable answer has to read as absent — which
      // includes a response that stated no length at all. `contentLength` owns that
      // distinction, and carries what conflating the two cost.
      return contentLength(res);
    },
  };
}

/** One failure shape, carrying the status and whatever the platform said. */
async function brokerError(op: string, key: string, res: Response): Promise<Error> {
  const detail = await res.text().catch((err: unknown) => errorMessage(err));
  return new Error(`upload blob ${op} failed for ${key}: ${res.status} ${detail.slice(0, 200)}`);
}
