// Copyright 2026 the AAI authors. MIT license.
/**
 * Where an uploaded file lives between the form that sent it and the step that
 * reads it — the factory, and the one import path for the store.
 *
 * The problem it solves is the one `MAX_WORKFLOW_INPUT_BYTES` states: a run's input
 * is journaled and replayed on every resume, so bytes may not travel in it. Before
 * this the only answer was "put the file somewhere else and pass a URL", which is
 * fine for a recording that is already hosted and useless for a person with a file
 * on their laptop.
 *
 * **`_upload-store.ts` is the contract** — the types, the chunking, and the
 * invariants every reader depends on (an ordinary upload does not exist until it is
 * finished; a STREAMED one exists from its first byte and says so with `complete`;
 * a PARTS one arrives over several connections at once and publishes only its
 * contiguous prefix as `size`). Read it before changing the store.
 *
 * ## One store, two things it needs, and neither is optional
 *
 * `_upload-store-blobs.ts` is the only store: the RECORD is a row in the app's own
 * database, and the BYTES are objects reached through {@link UploadBlobs}. There
 * used to be two backends — chunk rows in Postgres, files in a dev directory — and
 * `_upload-blobs.ts` carries why the bytes left the database.
 *
 * So an upload needs a database AND a bucket, and a deployment with either one
 * missing has no uploads at all. That case is answered by
 * {@link createUnavailableUploadStore} rather than by a third backend: every method
 * throws, and the message NAMES what is missing. The alternative — quietly falling
 * back to a directory, or to memory — is what the old file backend was, and it is
 * the shape this repo keeps paying for: an upload that stores perfectly well and is
 * gone by the time a resumed run reads it, with nothing reporting a thing.
 *
 * This module re-exports the contract's names so it stays the ONE import path for
 * the store: `runtime-barrel.ts` and six call sites already name it.
 */

import { MAX_WORKFLOW_UPLOAD_BYTES } from "../sdk/constants.ts";
import type { Db } from "../sdk/db.ts";
import { omitUndefined } from "../sdk/omit-undefined.ts";
import type { UploadInfo } from "../sdk/step-uploads.ts";
import type { UploadBlobs } from "./_upload-blobs.ts";
import { createBrokeredUploadBlobs } from "./_upload-blobs-brokered.ts";
import { createHttpUploadBlobs } from "./_upload-blobs-http.ts";
import {
  UPLOAD_STORAGE_BUCKET_ENV,
  UPLOAD_STORAGE_KEY_ENV,
  UPLOAD_STORAGE_URL_ENV,
} from "./_upload-env.ts";
import { type UploadStore, UploadsUnavailableError } from "./_upload-store.ts";
import { createBlobUploadStore } from "./_upload-store-blobs.ts";

export {
  createMemoryUploadBlobs,
  partKey,
  partsCovering,
  partsOf,
  rangesOf,
  type UploadBlobs,
  type UploadPart,
} from "./_upload-blobs.ts";
export { createHttpUploadBlobs, type HttpUploadBlobsOptions } from "./_upload-blobs-http.ts";
export {
  UPLOAD_STORAGE_BUCKET_ENV,
  UPLOAD_STORAGE_KEY_ENV,
  UPLOAD_STORAGE_URL_ENV,
} from "./_upload-env.ts";
export {
  assertPartOffset,
  assertPartTotal,
  type ByteRange,
  contiguousBytes,
  UnknownUploadError,
  UPLOADS_TABLE,
  UploadIdTakenError,
  type UploadMeta,
  UploadPartError,
  type UploadStore,
  UploadsUnavailableError,
  UploadTooLargeError,
} from "./_upload-store.ts";

/** Where one deployment's upload objects live, under whichever bucket it uses. */
export const UPLOAD_KEY_PREFIX = "uploads";

/**
 * The `.env` block a local project needs, spelled out in the refusal.
 *
 * A message that names three variables and leaves the reader to work out the shape is
 * how "configure it" turns into a search; this is copy-pasteable. `DATABASE_URL` is in
 * it because uploads need BOTH halves and a reader who has only just discovered the
 * first is about to discover the second.
 *
 * The bucket is `blobs` rather than `uploads`, which is not a typo and cost a real
 * confusion: `blobs` is the one bucket the local stack DECLARES
 * (`supabase/config.toml`, applied by `supabase start`), and an upload lands under an
 * `uploads/` PREFIX inside it — the same layout production uses beside its
 * `blobs/<sha256>` deploy artifacts. Nothing creates a bucket, here or there.
 */
const UPLOAD_ENV_EXAMPLE = [
  // COMPOSED rather than written as one literal: biome's `noSecrets` reads a
  // `user:password@host` URL as a password in a URL, and it is right to — the
  // alternative is a suppression comment, which would spend escape-hatch budget on a
  // local default. Same trade `store-conformance.ts` makes for a function name and
  // `with-test-pg.mjs` for its own candidate URL.
  `DATABASE_URL=postgresql://${["postgres", "postgres"].join(":")}@127.0.0.1:54322/postgres`,
  `${UPLOAD_STORAGE_URL_ENV}=http://127.0.0.1:54321`,
  `${UPLOAD_STORAGE_KEY_ENV}=<SERVICE_ROLE_KEY>`,
  // `blobs`, not `uploads`: it is the one bucket the local stack declares, and an
  // upload lands under an `uploads/` PREFIX inside it — see `UPLOAD_KEY_PREFIX`.
  `${UPLOAD_STORAGE_BUCKET_ENV}=blobs`,
].join("\n");

/**
 * Build the store for one server.
 *
 * Both `db` and `blobs` are required for a working store, and passing neither is a
 * legitimate call: a `createServer` with no `DATABASE_URL` and no bucket still has
 * to answer the upload routes, and what it answers is a refusal naming what it
 * lacks.
 *
 * @internal
 */
export function createUploadStore(opts: {
  db?: Db | undefined;
  blobs?: UploadBlobs | undefined;
  /** Key prefix for this deployment's objects. Defaults to {@link UPLOAD_KEY_PREFIX}. */
  prefix?: string | undefined;
  /** Cap for a body that names none. Defaults to `MAX_WORKFLOW_UPLOAD_BYTES`. */
  maxBytes?: number | undefined;
}): UploadStore {
  const missing = [
    ...(opts.db ? [] : ["a database (`DATABASE_URL`)"]),
    ...(opts.blobs ? [] : [`somewhere to put the bytes (\`${UPLOAD_STORAGE_URL_ENV}\`)`]),
  ];
  if (!(opts.db && opts.blobs)) return createUnavailableUploadStore(missing.join(" and "));
  return createBlobUploadStore({
    db: opts.db,
    blobs: opts.blobs,
    prefix: opts.prefix ?? UPLOAD_KEY_PREFIX,
    maxBytes: opts.maxBytes ?? MAX_WORKFLOW_UPLOAD_BYTES,
  });
}

/**
 * Resolve where bytes go from an agent's environment, or `undefined`.
 *
 * Two shapes, and which one applies is decided by whether a PLATFORM said it serves
 * this agent's bytes — see `_upload-blobs.ts` for why that split is the security
 * boundary rather than a preference:
 *
 * - **`broker` set** → brokered. A deployed guest sends every byte operation to the
 *   platform surface holding the bucket credential. Checked FIRST, so a stray service
 *   key in a deployed agent's env cannot take precedence over the boundary — an agent
 *   author may set any env var they like.
 * - **the three `AAI_UPLOAD_STORAGE_*` keys set** → direct. `aai dev` and a
 *   self-hosted server talk to the operator's own bucket with the operator's own
 *   key, which is theirs to hold.
 *
 * Neither → `undefined`, and {@link createUploadStore} refuses by name.
 *
 * @internal
 */
export function resolveUploadBlobs(opts: {
  env?: Record<string, string> | undefined;
  /** See `ServerOptions.uploadBroker` — a claim about the deployment, not a URL. */
  broker?: string | undefined;
  fetch?: typeof globalThis.fetch | undefined;
}): UploadBlobs | undefined {
  const base = opts.broker?.trim();
  if (base) {
    return createBrokeredUploadBlobs({ base, ...omitUndefined({ fetch: opts.fetch }) });
  }
  const url = opts.env?.[UPLOAD_STORAGE_URL_ENV]?.trim();
  const serviceKey = opts.env?.[UPLOAD_STORAGE_KEY_ENV]?.trim();
  const bucket = opts.env?.[UPLOAD_STORAGE_BUCKET_ENV]?.trim();
  // All three or none: two of three is a half-configured store, and letting that
  // resolve would turn a typo into a 500 on the first upload instead of a refusal
  // that names the key.
  if (!(url && serviceKey && bucket)) return undefined;
  return createHttpUploadBlobs({
    url,
    serviceKey,
    bucket,
    ...omitUndefined({ fetch: opts.fetch }),
  });
}

/**
 * A store that refuses everything, naming what this deployment is missing.
 *
 * Every method throws the same message, including {@link UploadStore.info} and
 * {@link UploadStore.read} — a reader that answered "no such upload" would make a
 * misconfiguration indistinguishable from an id nobody uploaded, which is exactly
 * the confusion an operator cannot debug from the outside.
 *
 * **The deployed remedy names BOTH ways to switch a database on, and naming only
 * the CLI cost real time.** This message reaches a browser (`UploadsUnavailableError`
 * is a 501 with its body, precisely so the remedy is not thrown away), and the reader
 * is usually in the STUDIO — a workflow app's page is where an upload happens — where
 * there is no terminal to run `aai storage enable` in and the switch is Settings →
 * Database. Worse, "a DEPLOYED agent gets both from the platform" reads as "the
 * platform will supply this", so the message's own advice was to deploy again: a
 * database is OFF until the app asks for one (aai-studio-server/studio-database.ts),
 * so no number of redeploys adds a `DATABASE_URL`, and the observed report is exactly
 * that — "still getting this after project redeploys". The other three enablement
 * messages in the repo (`STORAGE_DISABLED_MESSAGE` in `sdk/db.ts` and its pinned
 * duplicate in `aai-guest/limits.ts`, `WORKFLOWS_UNAVAILABLE_MESSAGE`) all name both
 * paths already; this one was the odd one out, and the only one whose reader has no
 * CLI. Phrasing mirrors them rather than inventing a fourth voice for one remedy.
 *
 * It also says that provisioning REBUILDS the running agent, because that is the
 * question a reader asks next and the answer changed: enabling a database bumps the
 * agents row so the resident guest is respawned with the new env
 * (aai-server/storage-handler.ts), so the switch is the whole fix and a deploy is not
 * part of it.
 *
 * @internal
 */
export function createUnavailableUploadStore(missing: string): UploadStore {
  // REJECTS rather than throwing synchronously. Every method here is declared async,
  // and a caller that composes one into a `Promise.all` or attaches a `.catch` gets
  // an unhandled throw instead of the failure it asked for — a difference the route's
  // own `try` hides and a step's does not.
  const refuse = <T>(): Promise<T> =>
    Promise.reject(
      new UploadsUnavailableError(
        `Workflow uploads need ${missing}.\n\n` +
          "A DEPLOYED agent gets both from the platform, and its env comes from Vault rather " +
          "than from your project's `.env` — so deploying your files again does not add a " +
          "`DATABASE_URL`. A database is off until the app asks for one: enable it with " +
          "`aai storage enable` (CLI) or Settings → Database in the studio. Provisioning " +
          "rebuilds the running agent, so that is the whole fix — no redeploy needed.\n\n" +
          "Running LOCALLY, both come from the project's `.env`. `supabase start`, then " +
          "`supabase status -o env` for API_URL and SERVICE_ROLE_KEY:\n\n" +
          `${UPLOAD_ENV_EXAMPLE}\n`,
      ),
    );
  return {
    create: refuse<UploadInfo>,
    stream: refuse<UploadInfo>,
    beginParts: refuse<UploadInfo>,
    writePart: refuse<UploadInfo>,
    recordPart: refuse<UploadInfo>,
    info: refuse<UploadInfo | undefined>,
    read: refuse<Uint8Array>,
  };
}
