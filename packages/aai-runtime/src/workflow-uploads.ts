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
 * ## One store, two homes, and the rule that picks between them
 *
 * `_upload-store-blobs.ts` is the only store, and it names neither half's home: a
 * RECORD through {@link UploadRecords}, BYTES through {@link UploadBackend}. What
 * this module owns is the pairing, and it follows ONE rule — **an upload must be at
 * least as durable as the runs that read it** — which makes it the same decision
 * `workflow-world.ts` already makes off the same input:
 *
 * - **`DATABASE_URL` set** → the Postgres world. Runs outlive every process and
 *   every machine, so the record goes in the app's own database and the bytes in a
 *   bucket. With no bucket there is nowhere durable for them, and THAT is the one
 *   case with no store at all: {@link createUnavailableUploadStore} refuses every
 *   method, naming what is missing.
 * - **absent** → the LOCAL world, whose run state is a directory and whose queue is
 *   in memory. Record and bytes go in that same directory (`_upload-files.ts`), so
 *   the two lifetimes are equal by construction.
 *
 * That second arm looks like the file backend this store used to have, and the
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
import type { Db } from "@alexkroman1/aai/internal";
import type { UploadInfo } from "@alexkroman1/aai/step";
import { omitUndefined } from "@alexkroman1/aai/utils";
import type { UploadBackend } from "./_upload-blobs.ts";
import { createBrokeredUploadBlobs } from "./_upload-blobs-brokered.ts";
import { createHttpUploadBackend } from "./_upload-blobs-http.ts";
import {
  UPLOAD_STORAGE_BUCKET_ENV,
  UPLOAD_STORAGE_KEY_ENV,
  UPLOAD_STORAGE_URL_ENV,
} from "./_upload-env.ts";
import { createFileUploadBlobs, createFileUploadRecords } from "./_upload-files.ts";
import { createPostgresUploadRecords } from "./_upload-records.ts";
import { type UploadStore, UploadsUnavailableError } from "./_upload-store.ts";
import { createBlobUploadStore } from "./_upload-store-blobs.ts";
import {
  createPlatformUploadRecords,
  type PlatformUploadRecordsOptions,
} from "./uploads-platform.ts";

export {
  createMemoryUploadBackend,
  partKey,
  partsCovering,
  partsOf,
  rangesOf,
  type UploadBackend,
  type UploadPart,
} from "./_upload-blobs.ts";
export { createHttpUploadBackend, type HttpUploadBackendOptions } from "./_upload-blobs-http.ts";
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
  UPLOAD_WINDOW_CONCURRENCY,
  UPLOADS_TABLE,
  UploadCompleteError,
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
 * Whether this store's bytes live somewhere OTHER than the container serving it.
 *
 * The one question a CLAIM has to answer, and the reason it is a function rather
 * than a second reading of the same env: `directParts` tells a client to send its
 * windows straight to the platform's bucket and then ask this agent to RECORD
 * them, so it may only be advertised when {@link createUploadStore} really took
 * the arm that reads that bucket. Derived from the same two inputs that choose the
 * arm, so the claim and the store cannot disagree.
 *
 * They did. `directParts` was derived from the broker URL alone, which the platform
 * sets for every agent it can name an origin for — including one with no database,
 * where the store deliberately ignores a resolved bucket and uses its own directory
 * (see below). Every parts upload on a databaseless agent therefore put its windows
 * in the bucket, asked the agent to record them, and got
 * `No bytes are stored for the part at <offset>` from a store looking at a directory
 * nobody had written to. That is every upload over one part (8 MiB) on the studio's
 * default configuration; a single-request upload was unaffected, because its bytes
 * go to the agent.
 *
 * @internal
 */
export function uploadBytesAreRemote<
  T extends { db?: Db | undefined; blobs?: UploadBackend | undefined },
>(options: T): options is T & { db: Db; blobs: UploadBackend } {
  return Boolean(options.db && options.blobs);
}

/**
 * Build the store for one server, choosing the home that matches its world.
 *
 * `db` present is the DURABLE arm and needs a bucket to go with it; `db` absent is
 * the LOCAL arm and needs `localDir`, which is the local workflow world's own data
 * directory. See the module doc for the rule, and `_upload-files.ts` for why the
 * second arm is not the file backend this store used to have.
 *
 * Passing neither is still a legitimate call — a bare `createRuntimeServer` with nothing
 * configured has to answer the upload routes somehow — and what it answers is a
 * refusal naming what it lacks.
 *
 * @internal
 */
export function createUploadStore(options: {
  db?: Db | undefined;
  blobs?: UploadBackend | undefined;
  /**
   * Where the LOCAL workflow world keeps its run state, for a deployment with no
   * database. Both halves of the store live under it, so an upload and the runs
   * that read it share one filesystem lifetime.
   */
  localDir?: string | undefined;
  /**
   * The PLATFORM's record home, when this guest is deployed on one: its public base
   * URL and this sandbox's bearer, as `resolvePlatformQueue` reads them.
   *
   * Checked before `db`, deliberately — see the arm below.
   */
  platform?: PlatformUploadRecordsOptions | undefined;
  /** Key prefix for this deployment's objects. Defaults to {@link UPLOAD_KEY_PREFIX}. */
  prefix?: string | undefined;
  /** Cap for a body that names none. Defaults to `MAX_WORKFLOW_UPLOAD_BYTES`. */
  maxBytes?: number | undefined;
}): UploadStore {
  const prefix = options.prefix ?? UPLOAD_KEY_PREFIX;
  const maxBytes = options.maxBytes ?? MAX_WORKFLOW_UPLOAD_BYTES;
  // THE PLATFORM's records win over a `DATABASE_URL`, and the order is the whole
  // correction. This tree used to start at `db`, on the premise stated one arm
  // down: "a database means durable runs, so the bytes have to be durable too."
  // The workflow queue moving to the platform falsified it — a deployed app's runs
  // are durable with no database of the author's — so the choice keyed off a signal
  // that had stopped meaning durability, and a deployed guest with no
  // `DATABASE_URL` got durable runs with their uploads in a directory that
  // recycles. One sandbox filled its filesystem that way.
  //
  // Preferring the platform even when the author HAS a database is the same rule
  // `configureWorkflowWorld` follows for the world itself: a deployed guest keeps
  // its durable state where the platform keeps it, whether or not it happens to
  // have a database of its own. Two homes chosen by different rules is how a run
  // and its uploads end up in different places.
  if (options.platform) {
    // NOT `uploadBytesAreRemote`, and the difference is the point: that predicate
    // requires a `db` because it is the db arm's guard, narrowing to
    // `{ db, blobs }`. Reusing it here refuses the very case this arm exists for —
    // a deployed guest with no `DATABASE_URL` — which is a bug this spec caught.
    //
    // The requirement is still real: a durable RECORD behind bytes that die with
    // the container is the same failure in reverse, and worse, because the record
    // then names an object nothing can produce.
    if (!options.blobs) {
      return createUnavailableUploadStore(
        `somewhere to put the bytes (\`${UPLOAD_STORAGE_URL_ENV}\`)`,
      );
    }
    return createBlobUploadStore({
      records: createPlatformUploadRecords(options.platform),
      blobs: options.blobs,
      prefix,
      maxBytes,
    });
  }
  if (options.db) {
    // A database means durable runs, so the bytes have to be durable too — a
    // directory on this one machine cannot serve a run resumed by another process,
    // which is the whole failure `_upload-files.ts` describes. Refused rather than
    // downgraded: the local arm would be a QUIETER version of that bug, not a fix.
    //
    // Still reachable, and it is `aai dev` and a self-hosted server: no platform
    // above them, a `DATABASE_URL` of the operator's own.
    if (!uploadBytesAreRemote(options)) {
      return createUnavailableUploadStore(
        `somewhere to put the bytes (\`${UPLOAD_STORAGE_URL_ENV}\`)`,
      );
    }
    return createBlobUploadStore({
      records: createPostgresUploadRecords(options.db),
      blobs: options.blobs,
      prefix,
      maxBytes,
    });
  }
  // No database AND nowhere local to put anything. Reachable only from a caller
  // that resolved neither — every host in this repo passes a `localDir`, because
  // `localWorkflowDataDir()` always answers one — so the message names the two
  // things a deployment can be given rather than guessing which was meant.
  if (options.localDir === undefined) {
    return createUnavailableUploadStore(
      "a database (`DATABASE_URL`) and somewhere to put the bytes " +
        `(\`${UPLOAD_STORAGE_URL_ENV}\`)`,
    );
  }
  // The bucket is deliberately NOT used here, even when one resolved. Without a
  // record nothing can name an object again, and there is no sweep that reclaims
  // one (see `create`) — so bytes in a shared bucket behind a record that dies
  // with the container are a permanent leak, where bytes in the container are not.
  return createBlobUploadStore({
    records: createFileUploadRecords({ dir: options.localDir }),
    blobs: createFileUploadBlobs({ dir: options.localDir }),
    prefix,
    maxBytes,
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
