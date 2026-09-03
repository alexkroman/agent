// Copyright 2026 the AAI authors. MIT license.
/**
 * {@link UploadBlobs} against a Supabase Storage bucket, with a service key.
 *
 * The implementation for `aai dev` and for a self-hosted server: the bucket is the
 * OPERATOR's, and the operator and the agent author are the same person, so there
 * is no boundary between the credential and the code. A deployed guest gets
 * `_upload-blobs-brokered.ts` instead — see `_upload-blobs.ts`, "Signing is NOT
 * here", for why that split is the security model rather than a configuration
 * choice.
 *
 * ## Plain `fetch`, not `@supabase/storage-js`
 *
 * `aai-server` uses the client for deploy blobs and is right to; here it would be a
 * new RUNTIME dependency of the published `aai` package, which the artifact-size
 * budget fails on its own terms — a dependency lands in every consumer's tree, and
 * a 4 kB wrapper can pull megabytes behind it. What it would buy is nothing this
 * needs: `download()` reads a whole object with no way to ask for a window, which is
 * the one operation the fan-out is built on, so the interesting call would be
 * hand-written either way.
 *
 * Storage's REST surface is four requests and one header:
 *
 * ```text
 * PUT    /object/<bucket>/<key>   x-upsert: true      → store
 * GET    /object/<bucket>/<key>   Range: bytes=a-b    → a window
 * HEAD   /object/<bucket>/<key>                       → Content-Length
 * ```
 *
 * ## `x-upsert`, because a part is RETRIED
 *
 * A window is keyed by the byte it starts at, so a repeat carries the same bytes to
 * the same name. Without upsert Storage answers 409 on the second attempt and the
 * ordinary failure the parts path exists to survive — a connection dying
 * mid-flight — would be permanent.
 */

import { errorMessage } from "@alexkroman1/aai/utils";
import { blobFetch } from "./_egress-fetch.ts";
import { contentLength, IDENTITY_ENCODING, type UploadBlobs } from "./_upload-blobs.ts";
import { collectCapped } from "./_upload-byte-util.ts";
import { UPLOAD_STORAGE_BUCKET_ENV, UPLOAD_STORAGE_URL_ENV } from "./_upload-env.ts";

export type HttpUploadBlobsOptions = {
  /** Project URL (`https://<ref>.supabase.co`), or any Storage-compatible origin. */
  url: string;
  /** Service key. Reaches the bucket, so it never leaves the process holding it. */
  serviceKey: string;
  bucket: string;
  /**
   * Test seam — production takes the pooled HTTP/1.1 `blobFetch`, NEVER
   * `globalThis.fetch`: see `_egress-fetch.ts`.
   */
  fetch?: typeof globalThis.fetch | undefined;
};

/** `https://<ref>.supabase.co` → `https://<ref>.supabase.co/storage/v1`. */
export function storageEndpoint(url: string): string {
  return `${url.replace(/\/+$/, "")}/storage/v1`;
}

/** {@link UploadBlobs} over Supabase Storage's REST API. */
export function createHttpUploadBlobs(opts: HttpUploadBlobsOptions): UploadBlobs {
  const endpoint = storageEndpoint(opts.url);
  // See `_egress-fetch.ts`: the operator's own bucket is reached the same way the
  // platform is, several windows at a time, so it takes the same HTTP/1.1 pool.
  const call = opts.fetch ?? blobFetch;
  const auth = {
    apikey: opts.serviceKey,
    Authorization: `Bearer ${opts.serviceKey}`,
  };
  // Every segment is encoded: an upload id is `UPLOAD_TOKEN_RE`-checked and a
  // prefix is ours, so nothing here needs escaping today — and a key is composed
  // from three separately-validated pieces, which is exactly the shape where a
  // later fourth piece arrives unvalidated.
  const objectUrl = (key: string): string =>
    `${endpoint}/object/${encodeURIComponent(opts.bucket)}/${key
      .split("/")
      .map(encodeURIComponent)
      .join("/")}`;

  return {
    async put(key, body, options): Promise<number> {
      // Buffered, and this is the one place that is unavoidable: Storage has no
      // append and no streaming PUT of unknown length, so an object's bytes have to
      // be in hand to write them. It is bounded by the WINDOW rather than by the
      // file — `UPLOAD_PART_BYTES`, i.e. megabytes, not the two gigabytes
      // `MAX_WORKFLOW_UPLOAD_BYTES` allows — which is the whole reason the store
      // cuts a body into windows before it reaches here.
      const bytes = await collectCapped(body, options?.limit);
      const res = await call(objectUrl(key), {
        method: "PUT",
        headers: {
          ...auth,
          "Content-Type": options?.type || "application/octet-stream",
          // See the module doc: a retried part must be the same object.
          "x-upsert": "true",
        },
        body: bytes,
      });
      if (!res.ok) throw await storageError("write", key, res);
      return bytes.length;
    },

    async read(key, start, end): Promise<Uint8Array> {
      if (end <= start) return new Uint8Array(0);
      const res = await call(objectUrl(key), {
        method: "GET",
        // Inclusive of its last byte, unlike every offset in this codebase.
        headers: { ...auth, Range: `bytes=${start}-${end - 1}` },
      });
      // Clamped rather than refused — see `UploadBlobs.read`. 416 is what Storage
      // answers for a window starting past the object, which is the same "there is
      // less here than you asked for" a short 206 reports.
      if (res.status === 404 || res.status === 416) return new Uint8Array(0);
      if (!res.ok) throw await storageError("read", key, res);
      return new Uint8Array(await res.arrayBuffer());
    },

    async size(key): Promise<number | undefined> {
      // `identity` for the reason the brokered client does it: the answer is a header,
      // and a hop that re-encodes the response takes it away. Storage itself does not,
      // but nothing here guarantees Storage is the only hop.
      const res = await call(objectUrl(key), {
        method: "HEAD",
        headers: { ...auth, ...IDENTITY_ENCODING },
      });
      if (res.status === 404) return undefined;
      if (!res.ok) throw await storageError("head", key, res);
      // A HEAD that answers 200 with no usable length is a store this cannot measure,
      // and measuring is the whole point of the call — see `UploadBlobs.size`, whose
      // contract is that it never over-reports. `contentLength` is what keeps "stated
      // no length" out of the zero case; this used to read the header itself and got
      // that wrong.
      return contentLength(res);
    },
  };
}

/**
 * One failure shape, carrying the status and whatever the body said.
 *
 * A MISSING BUCKET gets its own sentence, because it is the first thing a developer
 * meets and the raw answer does not help: Storage replies `404 {"error":"Bucket not
 * found"}`, which reads as "that object is not there" — indistinguishable from an
 * ordinary miss, and the whole point of setting three env vars was to say where things
 * go. The bucket is the one piece of Supabase state that lives in the dashboard rather
 * than in a migration (`supabase/config.toml` declares no storage settings on purpose),
 * so nothing creates it and nothing else would ever mention it.
 */
async function storageError(op: string, key: string, res: Response): Promise<Error> {
  const detail = await res.text().catch((err: unknown) => errorMessage(err));
  if (res.status === 404 && detail.includes("Bucket not found")) {
    return new Error(
      `No storage bucket named in ${UPLOAD_STORAGE_BUCKET_ENV} exists at ` +
        `${UPLOAD_STORAGE_URL_ENV}. Create it as a PRIVATE bucket — locally that is the ` +
        "Supabase Studio's Storage tab — and note nothing creates it for you: a bucket " +
        "is dashboard state, not a migration.",
    );
  }
  return new Error(`upload blob ${op} failed for ${key}: ${res.status} ${detail.slice(0, 200)}`);
}
