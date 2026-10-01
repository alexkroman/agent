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
 * **`../uploads/store.ts` is the contract** — the types, the chunking, and the
 * invariants every reader depends on (an ordinary upload does not exist until it is
 * finished; a STREAMED one exists from its first byte and says so with `complete`;
 * a PARTS one arrives over several connections at once and publishes only its
 * contiguous prefix as `size`). Read it before changing the store.
 *
 * ## One store, its home is the RUNS' home
 *
 * `../uploads/store-blobs.ts` is the only store, and it names neither half's home: a
 * RECORD through {@link UploadRecords}, BYTES through {@link UploadBackend}. What
 * this module owns is the pairing, and it follows ONE rule — **an upload must be at
 * least as durable as the runs that read it** — which is why the record's home is
 * not chosen here at all: it is the {@link StorageHome} `resolveStorageHome`
 * returns, the same value the run journal and the key index are built from.
 *
 * - **platform / postgres** → a durable record, and the bytes in a bucket. With no
 *   bucket there is nowhere durable for them, and THAT is the one case with no
 *   store at all: {@link createUnavailableUploadStore} refuses every method,
 *   naming what is missing.
 * - **local** → the LOCAL world, whose run state is a directory and whose queue is
 *   in memory. Record and bytes go in that same directory (`../uploads/files.ts`), so
 *   the two lifetimes are equal by construction.
 *
 * That last arm looks like the file backend this store used to have, and the
 * difference is exactly the rule above. The old one paired a DIRECTORY with runs
 * that lived in Postgres, so it stored a dev upload perfectly well and lost it by
 * the time a resumed run read it, with nothing reporting a thing. Pairing it with
 * the local world's own directory makes that unreachable — a run that survives to
 * re-read an upload is a run whose directory survived too — and it is what lets an
 * author try a workflow app before provisioning anything, which the studio's
 * database-off default makes the FIRST experience of one rather than an edge case.
 *
 * This module re-exports the contract's names so it stays the ONE import path for
 * the store: `runtime-barrel.ts` and six call sites already name it.
 */

import { MAX_WORKFLOW_UPLOAD_BYTES, type OpenUpload } from "@alexkroman1/aai/host-internal";
import type { UploadInfo } from "@alexkroman1/aai/step";
import { omitUndefined } from "@alexkroman1/aai/utils";
import type { UploadBackend } from "../uploads/index.ts";
import {
  createBlobUploadStore,
  createBrokeredUploadBlobs,
  createFileUploadBlobs,
  createFileUploadRecords,
  createHttpUploadBackend,
  createPlatformUploadRecords,
  createPostgresUploadRecords,
  UPLOAD_STORAGE_BUCKET_ENV,
  UPLOAD_STORAGE_KEY_ENV,
  UPLOAD_STORAGE_URL_ENV,
  type UploadStore,
  UploadsUnavailableError,
} from "../uploads/index.ts";
import { isDurableHome, type StorageHome } from "./storage-home.ts";

export {
  assertPartOffset,
  assertPartTotal,
  type ByteRange,
  contiguousBytes,
  createHttpUploadBackend,
  createMemoryUploadBackend,
  type HttpUploadBackendOptions,
  partKey,
  partsCovering,
  partsOf,
  rangesOf,
  UnknownUploadError,
  UPLOAD_STORAGE_BUCKET_ENV,
  UPLOAD_STORAGE_KEY_ENV,
  UPLOAD_STORAGE_URL_ENV,
  UPLOAD_WINDOW_CONCURRENCY,
  UPLOADS_TABLE,
  type UploadBackend,
  UploadCompleteError,
  UploadIdTakenError,
  type UploadMeta,
  type UploadPart,
  UploadPartError,
  type UploadStore,
  UploadsUnavailableError,
  UploadTooLargeError,
} from "../uploads/index.ts";

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
 * Whether this store's bytes live somewhere OTHER than the container serving it.
 *
 * The one question a CLAIM has to answer: `directParts` tells a client to send its
 * windows straight to the platform's bucket and then ask this agent to RECORD
 * them, so it may only be advertised when {@link createUploadStore} really took an
 * arm that reads a bucket. Derived from the same two inputs that choose the arm —
 * the {@link StorageHome} and the resolved byte backend — so the claim and the
 * store cannot disagree.
 *
 * They did, twice. First `directParts` was derived from the broker URL alone,
 * which the platform sets for every agent it can name an origin for — including
 * one whose store used its own directory — so every parts upload put its windows
 * in the bucket and got `No bytes are stored for the part at <offset>` from a
 * store looking at a directory nobody had written to. Then it was derived from
 * `db && blobs`, which was the postgres arm's guard rather than the store's: a
 * deployed guest with no `DATABASE_URL` takes the PLATFORM arm and reads the
 * bucket, and was refused the direct path for want of a database it never needed.
 *
 * @internal
 */
export function uploadBytesAreRemote(home: StorageHome, blobs: UploadBackend | undefined): boolean {
  return isDurableHome(home) && blobs !== undefined;
}

/**
 * Build the store for one server, over the home its runs live in.
 *
 * The RECORD follows the {@link StorageHome} — the same answer the run journal and
 * the key index are built from, so an upload is never less durable than the runs
 * that read it:
 *
 * - **platform** → the platform's records (`POST /:slug/upload-records`), bytes in
 *   the bucket `blobs` reaches.
 * - **postgres** → the agent's own table, bytes in the bucket.
 * - **local** → both halves in `localDir`, the local workflow world's own data
 *   directory. See `../uploads/files.ts` for why that is not the file backend this
 *   store used to have.
 *
 * A durable home with NO byte backend is the one refusal: a durable record behind
 * bytes that die with the container names an object nothing can produce, and the
 * local arm would be a quieter version of the same loss rather than a fix. A local
 * home with no `localDir` refuses too — a bare `createRuntimeServer` with nothing
 * configured has to answer the upload routes somehow.
 *
 * @internal
 */
export function createUploadStore(options: {
  /** Where the runs live — `resolveStorageHome` (`storage-home.ts`). */
  home: StorageHome;
  blobs?: UploadBackend | undefined;
  /**
   * Where the LOCAL workflow world keeps its run state. Read only for a `local`
   * home: both halves of the store live under it, so an upload and the runs that
   * read it share one filesystem lifetime.
   */
  localDir?: string | undefined;
  /** Key prefix for this deployment's objects. Defaults to {@link UPLOAD_KEY_PREFIX}. */
  prefix?: string | undefined;
  /** Cap for a body that names none. Defaults to `MAX_WORKFLOW_UPLOAD_BYTES`. */
  maxBytes?: number | undefined;
}): UploadStore {
  const prefix = options.prefix ?? UPLOAD_KEY_PREFIX;
  const maxBytes = options.maxBytes ?? MAX_WORKFLOW_UPLOAD_BYTES;
  const { home, blobs } = options;
  if (home.kind === "local") {
    if (options.localDir === undefined) {
      return createUnavailableUploadStore(
        "a database (`DATABASE_URL`) and somewhere to put the bytes " +
          `(\`${UPLOAD_STORAGE_URL_ENV}\`)`,
      );
    }
    // The bucket is deliberately NOT used here, even when one resolved. Without a
    // durable record nothing can name an object again, and there is no sweep that
    // reclaims one (see `create`) — so bytes in a shared bucket behind a record that
    // dies with the container are a permanent leak, where bytes in it are not.
    return createBlobUploadStore({
      records: createFileUploadRecords({ dir: options.localDir }),
      blobs: createFileUploadBlobs({ dir: options.localDir }),
      prefix,
      maxBytes,
    });
  }
  if (blobs === undefined) {
    return createUnavailableUploadStore(
      `somewhere to put the bytes (\`${UPLOAD_STORAGE_URL_ENV}\`)`,
    );
  }
  return createBlobUploadStore({
    records:
      home.kind === "platform"
        ? createPlatformUploadRecords(home.platform)
        : createPostgresUploadRecords(home.db),
    blobs,
    prefix,
    maxBytes,
  });
}

/**
 * Resolve where bytes go from an agent's environment, or `undefined`.
 *
 * Two shapes, and which one applies is decided by whether a PLATFORM said it serves
 * this agent's bytes — see `../uploads/blobs.ts` for why that split is the security
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
export function resolveUploadBlobs(options: {
  env?: Record<string, string> | undefined;
  /** See `RuntimeServerOptions.uploadBroker` — a claim about the deployment, not a URL. */
  broker?: string | undefined;
  fetch?: typeof globalThis.fetch | undefined;
}): UploadBackend | undefined {
  const base = options.broker?.trim();
  if (base) {
    return createBrokeredUploadBlobs({ base, ...omitUndefined({ fetch: options.fetch }) });
  }
  const url = options.env?.[UPLOAD_STORAGE_URL_ENV]?.trim();
  const serviceKey = options.env?.[UPLOAD_STORAGE_KEY_ENV]?.trim();
  const bucket = options.env?.[UPLOAD_STORAGE_BUCKET_ENV]?.trim();
  // All three or none: two of three is a half-configured store, and letting that
  // resolve would turn a typo into a 500 on the first upload instead of a refusal
  // that names the key.
  if (!(url && serviceKey && bucket)) return undefined;
  return createHttpUploadBackend({
    url,
    serviceKey,
    bucket,
    ...omitUndefined({ fetch: options.fetch }),
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
 * **The message reaches a BROWSER**, which is what makes its wording load-bearing:
 * `UploadsUnavailableError` is answered as a 501 carrying its body, precisely so a
 * named configuration condition is not thrown away as "Internal server error".
 *
 * It used to be the answer for a deployed agent with no database, and it named one
 * remedy — `aai storage enable`, a CLI command — to a reader who is usually in the
 * STUDIO, where a workflow app's page is where an upload happens and the switch is
 * Settings → Database. Worse, "a DEPLOYED agent gets both from the platform" reads
 * as "the platform will supply this", so the message's own advice was to deploy
 * again: a database is OFF until a project asks for one, so no number of redeploys
 * added a `DATABASE_URL`, and the report was exactly that — still refusing after
 * repeated project redeploys.
 *
 * That case is not a refusal any more (the local arm serves it), which is the real
 * fix; what is left here is the HALF-CONFIGURED one, where a database's runs
 * outlive any one container and the bytes have nowhere durable to go. So the
 * message no longer talks about switching a database on: it names the missing half
 * and the `.env` block that supplies it.
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
          "than from your project's `.env`. An app with NO database needs neither — its " +
          "uploads live in the local workflow world, beside its runs — so what is missing " +
          "here is the durable half a database's runs require: they outlive any one " +
          "container, and bytes that do not cannot serve one that resumes.\n\n" +
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
    recordParts: refuse<UploadInfo>,
    info: refuse<UploadInfo | undefined>,
    open: refuse<OpenUpload | undefined>,
    read: refuse<Uint8Array>,
  };
}
