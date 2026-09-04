// Copyright 2026 the AAI authors. MIT license.
/**
 * The four slots a process must publish before a step can do its job: somewhere
 * to read uploads from, somewhere to report to, something to speak with, and the
 * HTTP/1.1-pinned fetch a step's outbound call goes through.
 *
 * All four are `Symbol.for` slots rather than imports, for the reason
 * `sdk/step-env.ts` states — the step artifact bundles its own copy of the SDK,
 * so the publisher and the reader are two module instances in one realm — and
 * all four are published HERE, in one call, because they have one correct wiring
 * point: `createRuntimeServer`. That is the front door `aai dev`, a self-hosted server
 * and every deployed guest all go through, which is what makes a step behave
 * identically in all three.
 *
 * Publishing at the SERVER rather than at the runtime is deliberate. A guest
 * builds its runtime lazily, on the first request that needs one, while the
 * platform's queue can deliver a run the moment the process boots — a run that
 * was mid-flight when the last container went away resumes exactly then. A
 * reader published from the runtime would therefore be missing for precisely
 * the steps that matter most.
 */

import {
  MAX_UPLOAD_BYTES_ENV,
  publishSpeechSynthesizer,
  publishStepFetch,
  publishStepInfoReader,
  publishStepReporter,
  publishUploadReader,
} from "@alexkroman1/aai/host-internal";
import { omitUndefined } from "@alexkroman1/aai/utils";
import { closeEgressFetch } from "./_egress-fetch.ts";
import { openAppDb } from "./app-db.ts";
import { closePlatformSockets, ensurePlatformSocket } from "./platform-socket-registry.ts";
import type { CloseableDb } from "./postgres-db.ts";
import type { Logger } from "./runtime-config.ts";
import { createStepFetch } from "./step-fetch.ts";
import { speakOverWebSocket } from "./step-speak.ts";
import { isPerProcessDataDir, localWorkflowDataDir } from "./workflow-data-dir.ts";
import { platformGuestOptions } from "./workflow-platform-world.ts";
import { createStepInfoReader, createStepReporter } from "./workflow-report.ts";
import {
  createUploadStore,
  resolveUploadBlobs,
  type UploadStore,
  uploadBytesAreRemote,
} from "./workflow-uploads.ts";

/**
 * What one server's workflow support OWNS, so it can give it back.
 *
 * The `close` half is the whole reason this is an object rather than the store
 * on its own. `aai dev` re-runs `createRuntimeServer` on every file save and
 * `AgentServer.close()` closed the runtime and the sockets and nothing else, so
 * each rebuild stranded a Postgres pool (2 connections, against a role limit of
 * 4 at the time — two saves that touched uploads exhausted it) and an undici
 * keep-alive pool. `runtime.ts` fixed exactly this shape for `ownedDb`, with a
 * comment naming the same cause; the same rule applies here, and for the same
 * reason it is stated as OWNERSHIP: what this call opened is what it closes, and
 * a caller-injected handle would stay the caller's. What it opens is now a LEASE
 * on a shared pool (`host/app-db.ts`), which is what makes that rule survive the
 * sharing: releasing this one closes the pool only if nobody else holds one.
 *
 * Not exported from `/runtime`: `createRuntimeServer` is the only caller and takes it
 * by inference.
 *
 * @internal
 */
type WorkflowSupport = {
  /** Where uploaded files go — what `createWorkflowApi` mounts. */
  uploads: UploadStore;
  /**
   * Whether {@link uploads} reads the bytes the PLATFORM stored, i.e. whether the
   * `directParts` claim may be made. Reported from here rather than re-derived by
   * the caller, because only this call sees both halves the arm is chosen from —
   * see {@link uploadBytesAreRemote} for what deriving it from the broker alone
   * cost.
   */
  directParts: boolean;
  /** Release what this call opened — its database lease and its fetch pool. Never rejects. */
  close(): Promise<void>;
};

/**
 * Build the upload store for one server and publish all three step slots.
 *
 * **The store's home follows the RUNS', off the same input.** `selectJournal`
 * (`workflow-runtime.ts`) reads `DATABASE_URL` to choose between a Postgres
 * journal and an in-memory one; this reads it to choose where an upload lives, so
 * the two can only ever agree — which is the invariant `workflow-uploads.ts`
 * states and the one
 * the deleted file backend broke. With a database the record goes in it and the
 * bytes need a bucket (no bucket, no store: a refusal naming it). Without one, both
 * live in the local world's own data directory, so a databaseless agent has working
 * uploads that are exactly as durable as its runs — which is what a workflow app in
 * the studio is, where a database is opt-in.
 *
 * @internal
 */
export function installWorkflowSupport(opts: {
  /**
   * The agent's env. Read for `DATABASE_URL`, the upload cap, and the three
   * `AAI_UPLOAD_STORAGE_*` keys — nothing else. Taking the RECORD rather than the
   * values keeps the key names in one module; the caller would otherwise spell them
   * at the call site, which is where they drift.
   */
  env?: Record<string, string> | undefined;
  /**
   * Base URL of a platform serving this agent's upload bytes, when there is one.
   *
   * Its PRESENCE selects the brokered byte path, which is the security boundary rather
   * than a preference — see `resolveUploadBlobs`, and `RuntimeServerOptions.uploadBroker` for
   * why this is not `publicUrl`.
   */
  uploadBroker?: string | undefined;
  logger: Logger;
}): WorkflowSupport {
  // A LEASE on the process's one pool for this URL rather than a pool of its
  // own. It cannot be the runtime's handle — the runtime is built lazily and may
  // not exist yet (see the module doc) — but it can be, and now is, the same
  // CONNECTIONS: the app role's `connection limit` counts pools, not intentions,
  // and this one used to be two of the guest's ten (`sdk/app-db-budget.ts`).
  // Connections open on first query, so an agent that never uploads anything
  // still pays nothing for holding the lease.
  //
  // Sharing `ctx.db`'s connections would have been WRONG before the bytes left
  // the database: a part was a `bytea` row held for a megabyte, and it was
  // measured slowing every non-upload query on the guest to p50 1.34s against
  // 0.43s (`_upload-blobs.ts`, "The pool"). What is left here is one small
  // `update` naming a window that landed — a round trip, like every other
  // statement on this pool.
  const databaseUrl = opts.env?.DATABASE_URL;
  const db: CloseableDb | undefined = databaseUrl ? openAppDb(databaseUrl) : undefined;
  // A value that is not a positive number is IGNORED rather than treated as zero: a
  // typo'd env var must not make every upload fail as "too large". An operator knob
  // rather than a tuning one: what it bounds is how much of their storage one upload
  // may take, and only they know that.
  const maxBytes = positiveBytes(opts.env?.[MAX_UPLOAD_BYTES_ENV]);
  // The local directory is resolved WHETHER OR NOT it is used, because asking for it
  // is free and the alternative is a conditional whose two arms drift. `db` is what
  // decides: `createUploadStore` ignores `localDir` when there is a database, and a
  // bucket when there is not (its own doc carries why each is right).
  const localDir = localWorkflowDataDir();
  const blobs = resolveUploadBlobs(omitUndefined({ env: opts.env, broker: opts.uploadBroker }));
  // The PLATFORM's record home, when there is one. Resolved from the same two env
  // keys the workflow world uses, so an upload's record and a run's queue can never
  // disagree about whether this guest is deployed — which they DID, because this
  // read `opts.env` (the agent's own) where those keys never appear, so a deployed
  // guest announced "workflow uploads are LOCAL … no platform" one line after the
  // harness announced the platform world. See `platformGuestOptions`.
  const platform = platformGuestOptions();
  // ONE socket per process, opened here because this is the one composition root
  // that runs once per `AgentServer` and already owns the egress pools' lifetime
  // (see `close()` below). Every platform client prefers it and falls back to
  // HTTP until it is open, so this is a latency decision rather than a
  // durability one — `platform-socket.ts` carries the argument.
  if (platform) ensurePlatformSocket(platform, { logger: opts.logger });
  const store = createUploadStore({
    db,
    localDir,
    ...omitUndefined({ blobs, maxBytes, platform }),
  });
  if (!(db || platform)) {
    // ANNOUNCED, once, at construction. A store that quietly loses an upload with
    // its container is the shape this repo keeps paying for; a store that says which
    // directory it is using is a documented tradeoff. `buildWorkflowClient`'s
    // "Workflows resolved" line reports the matching run store.
    //
    // It has been wrong THREE times, which is why it is worth reading before
    // editing. It first said an upload lives "exactly as long as the runs that read
    // it" and recommended `aai storage enable` — a command that no longer exists,
    // and a claim that stopped being true when a DEPLOYED app's runs became the
    // platform's. Then it branched on `resolvePlatformQueue` to say the right thing
    // in each case. Then, a deployed guest's uploads having become the platform's
    // too, it was made UNCONDITIONAL on the reasoning that the only branch left was
    // "`aai dev` on a project that configured neither" — and it asserted, of that
    // branch, that an upload "does not outlive this process".
    //
    // Both halves of that were wrong, and measurably. The branch is reachable from
    // TWO compositions, and they differ in exactly the property the sentence
    // claimed: `aai dev` passes the PROJECT's `.workflow-data` — "where a restart is
    // a save rather than a new deployment", `defaultLocalDataDir`'s own words — so
    // an upload's bytes come back byte-identical across a restart and so does its
    // run, while the scaffold's `server.mjs` takes the per-process default and gets
    // a fresh `tmpdir()/aai-workflow-data-<pid>`. Both measured directly.
    //
    // So it is conditional again, on the one thing that actually decides it, and
    // the predicate is DERIVED from the default rather than sniffed — see
    // `isPerProcessDataDir`. What stays unconditional is the recommendation: a
    // directory beside the project is a save, not durability.
    opts.logger.info(
      `workflow uploads are LOCAL (${localDir}): no platform and no DATABASE_URL. ` +
        (isPerProcessDataDir(localDir)
          ? "That directory belongs to this process, so an upload does not outlive it — " +
            "and neither do the runs that read it, since the world is local too. "
          : "They live in that directory, so they survive a restart of this process — " +
            "but nothing replicates or prunes them, and an agent started elsewhere " +
            "sees none of them. ") +
        "Set DATABASE_URL in this project's .env for durable runs and uploads.",
    );
  }
  publishUploadReader(store);
  publishStepReporter(createStepReporter(opts.logger));
  // The reader behind `stepInfo()`, published beside the reporter because both
  // read the same `AsyncLocalStorage` and both are filled once per server. An
  // unpublished one answers `undefined`, which a body reads as "not retrying" —
  // see `sdk/step-attempt.ts`.
  publishStepInfoReader(createStepInfoReader());
  // The speech slot. Nothing to close and nothing to pool: `stepSpeak` opens
  // one socket per utterance and drops it — see `host/step-speak.ts` for why a
  // step has nothing for a connection to be reused by.
  publishSpeechSynthesizer(speakOverWebSocket);
  // The third step slot, and the one whose absence is silent: an unpublished
  // `stepFetch` degrades to `globalThis.fetch`, which WORKS and speaks HTTP/2 —
  // so a fan-out that lost this line would collect stream resets rather than an
  // error naming the gap. See `sdk/step-fetch.ts`.
  const stepFetch = createStepFetch();
  publishStepFetch(stepFetch.fetch);
  return {
    uploads: store,
    // The BROKER is still required — a self-hosted agent with its own bucket holds
    // the credential itself, and no platform route serves its windows — but it is no
    // longer sufficient: the store has to be the arm that reads that bucket.
    directParts: Boolean(opts.uploadBroker?.trim()) && uploadBytesAreRemote({ db, blobs }),
    async close(): Promise<void> {
      // Settled rather than awaited in sequence, and never rejecting: this runs
      // inside `AgentServer.close()`, where one pool refusing to drain must not
      // leave the other one open — nor turn an orderly shutdown into a throw.
      // The socket close is synchronous, and goes with the pools for the reason
      // they are here: `aai dev` builds a new server on every save, and a socket
      // the old one left connected holds one of the platform's Modal inputs.
      closePlatformSockets();
      await Promise.allSettled([db?.close(), stepFetch.close(), closeEgressFetch()]);
    },
  };
}

/** A byte count out of an env value, or `undefined` for anything unusable. */
function positiveBytes(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}
