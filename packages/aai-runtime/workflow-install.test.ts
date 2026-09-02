// Copyright 2026 the AAI authors. MIT license.
/**
 * `installWorkflowSupport` publishes THREE step slots, and this asserts all
 * three, because each one's absence is silent in a different way.
 *
 * An unpublished upload reader at least names itself
 * (`UPLOADS_UNAVAILABLE_MESSAGE`). An unpublished reporter degrades to the
 * console. An unpublished `stepFetch` degrades to `globalThis.fetch`, which
 * WORKS — over HTTP/2 — so a fan-out that lost that line would collect stream
 * resets against a live provider and nothing else, with no error naming the gap.
 * That is the failure this file exists for; the module had no spec at all.
 */

import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  publishStepFetch,
  publishStepReporter,
  publishUploadReader,
  UPLOADS_UNAVAILABLE_MESSAGE,
} from "@alexkroman1/aai/host-internal";
import { readUpload, report, stepFetch } from "@alexkroman1/aai/step";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { installWorkflowSupport } from "./workflow-install.ts";

/**
 * Where the LOCAL world would keep its run state, and so where a databaseless
 * store puts its uploads.
 *
 * Stubbed rather than left to the default, because the default is a real directory
 * under `tmpdir()` keyed by pid — every spec here that installs without a database
 * would create one and leave it behind. Stubbing the same key
 * `configureWorkflowWorld` writes is also the claim under test: the store reads the
 * world's own directory rather than one of its own.
 */
let dataDir: string;

beforeEach(async () => {
  // Every slot is process-global, so a test has to start from nothing published
  // or it cannot tell "installed it" from "a previous test left it".
  publishUploadReader(undefined);
  publishStepReporter(undefined);
  publishStepFetch(undefined);
  dataDir = await mkdtemp(join(tmpdir(), "aai-install-data-"));
  // `AAI_WORKFLOW_DATA_DIR`, ours — it was `WORKFLOW_LOCAL_DATA_DIR`, the
  // DevKit's own key, written by `configureWorkflowWorld`. With that writer gone
  // the old name would have been a key nothing sets, read by a fallback: a value
  // silently always the default, which is what this case exists to catch.
  vi.stubEnv("AAI_WORKFLOW_DATA_DIR", dataDir);
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
  publishUploadReader(undefined);
  publishStepReporter(undefined);
  publishStepFetch(undefined);
  // `vitest.shared.ts` sets `unstubEnvs` but there is no `unstubGlobals`
  // counterpart, so a `vi.stubGlobal("fetch", …)` outlives its test: the two
  // specs below the stubbed ones ran `install()` against a `fetch` answering
  // every request with `Response("global")`.
  vi.unstubAllGlobals();
});

/** Four bytes, as the routes hand a body over: an async iterable of chunks. */
async function* oneChunk(): AsyncGenerator<Uint8Array> {
  yield new Uint8Array([1, 2, 3, 4]);
}

/** A logger that records nothing anybody asserts on — see the `report` test for one that does. */
function quietLogger() {
  return { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() };
}

function install() {
  return installWorkflowSupport({ logger: quietLogger() });
}

describe("installWorkflowSupport", () => {
  test("publishes the upload reader, so a step's readUpload reaches a store", async () => {
    await expect(readUpload("upl_missing")).rejects.toThrow(UPLOADS_UNAVAILABLE_MESSAGE);
    install();
    // A DIFFERENT failure, which is the point: the slot is filled and the store is
    // the thing that answered. With no database that store is the LOCAL one, so what
    // it answers for an id nobody uploaded is "no such upload" — the honest answer,
    // where the unpublished slot's message is about this process's wiring.
    await expect(readUpload("upl_missing")).rejects.not.toThrow(UPLOADS_UNAVAILABLE_MESSAGE);
    await expect(readUpload("upl_missing")).rejects.toThrow(/No upload with id upl_missing/);
  });

  test("with no database, uploads WORK and live under the declared data directory", async () => {
    // A databaseless agent used to have no uploads at all. The directory used to
    // be the DevKit local world's, paired automatically because both were chosen
    // off `DATABASE_URL`; the world is gone and the directory is ours, so the
    // pairing is now simply that this is where a deployment with no database puts
    // things. `AAI_WORKFLOW_DATA_DIR` is what a host declares it with.
    const local = install();
    const created = await local.uploads.create({ name: "a.wav" }, oneChunk());
    expect(created).toMatchObject({ name: "a.wav", size: 4, complete: true });
    // Compared as VALUES: `concat` answers whatever its pieces are, and Node's
    // `Buffer.concat` makes that a Buffer for every multi-piece read in every home.
    expect(Array.from(await local.uploads.read(created.id, 0, 4))).toEqual([1, 2, 3, 4]);
    // Under the STUBBED directory, which is what says it took the world's rather
    // than minting one of its own.
    expect((await readdir(dataDir)).toSorted()).toEqual(["objects", "records"]);
    await local.close();
  });

  test("the boot line reports a DECLARED directory as surviving a restart", async () => {
    // The arm nothing reached until `aai dev` gained a writer for
    // `AAI_WORKFLOW_DATA_DIR`. Its wording is the whole tradeoff an operator has
    // to know, and while every deployment took the per-process default this
    // branch was unreachable in production — so the sentence a developer under
    // `aai dev` actually gets was asserted by nothing.
    const logger = quietLogger();
    const local = installWorkflowSupport({ logger });
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining(`workflow uploads are LOCAL (${dataDir})`),
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("they survive a restart of this process"),
    );
    await local.close();
  });

  test("and an UNDECLARED one as belonging to this process", async () => {
    // The other arm, which is what a scaffold `server.mjs` and a deployed guest
    // with neither a platform nor a database get: `tmpdir()/aai-workflow-data-<pid>`,
    // gone with the process. Nothing is written here, so no directory is created.
    vi.stubEnv("AAI_WORKFLOW_DATA_DIR", undefined);
    const logger = quietLogger();
    const perProcess = installWorkflowSupport({ logger });
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining(`aai-workflow-data-${process.pid}`),
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("an upload does not outlive it"),
    );
    await perProcess.close();
  });

  test("a database with no bucket REFUSES, naming the durable half", async () => {
    // The one combination with no answer: a database's runs outlive this container,
    // and the local directory cannot serve one that resumes elsewhere.
    const half = installWorkflowSupport({
      env: { DATABASE_URL: "postgres://user:pw@127.0.0.1:1/db" },
      logger: quietLogger(),
    });
    await expect(half.uploads.info("upl_x")).rejects.toThrow(/AAI_UPLOAD_STORAGE_URL/);
    await half.close();
  });

  test("brokers the bytes when a PLATFORM says it serves them, ignoring the env", async () => {
    // The boundary, and it is checked first: an agent author may set any env var they
    // like, and a stray service key in a deployed agent's env must not take precedence
    // over the platform holding the credential instead of the guest.
    const brokered = installWorkflowSupport({
      env: {
        DATABASE_URL: "postgres://user:pw@127.0.0.1:1/db",
        AAI_UPLOAD_STORAGE_URL: "https://attacker.example",
        AAI_UPLOAD_STORAGE_KEY: "k",
        AAI_UPLOAD_STORAGE_BUCKET: "b",
      },
      uploadBroker: "https://platform.test/digest-desk",
      logger: quietLogger(),
    });
    // A real store either way, so the observable difference is WHERE a read goes. The
    // database is what fails here (nothing is listening), which is enough to say the
    // store was built rather than refused.
    await expect(brokered.uploads.info("upl_x")).rejects.not.toThrow(/AAI_UPLOAD_STORAGE/);
    await brokered.close();
  });

  test("a broker with NO database does not claim `directParts`", async () => {
    // The regression this pair exists for. The platform sets `AAI_UPLOAD_BROKER_URL`
    // for every agent it can name an origin for, database or not — and with no
    // database the store deliberately uses its own directory rather than the bucket
    // (`uploadBytesAreRemote`). Claiming the direct path there sent every window over
    // 8 MiB into the platform's bucket and then asked THIS store to record bytes it
    // had never been given, which it correctly refused: `No bytes are stored for the
    // part at 8388608`. Measured against a real deploy before the fix.
    const local = installWorkflowSupport({
      uploadBroker: "https://platform.test/digest-desk",
      logger: quietLogger(),
    });
    expect(local.directParts).toBe(false);
    await local.close();
  });

  test("a broker WITH a database claims it, because the store reads that bucket", async () => {
    const durable = installWorkflowSupport({
      env: { DATABASE_URL: "postgres://user:pw@127.0.0.1:1/db" },
      uploadBroker: "https://platform.test/digest-desk",
      logger: quietLogger(),
    });
    expect(durable.directParts).toBe(true);
    await durable.close();
  });

  test("an agent's OWN bucket never claims `directParts` — no platform serves it", async () => {
    // `aai dev` and a self-hosted server hold the credential themselves, so there is
    // no platform byte route to send a window to. The broker is still NECESSARY, which
    // is the half the fix had to keep.
    const own = installWorkflowSupport({
      env: {
        DATABASE_URL: "postgres://user:pw@127.0.0.1:1/db",
        AAI_UPLOAD_STORAGE_URL: "https://s.example",
        AAI_UPLOAD_STORAGE_KEY: "k",
        AAI_UPLOAD_STORAGE_BUCKET: "b",
      },
      logger: quietLogger(),
    });
    expect(own.directParts).toBe(false);
    await own.close();
  });

  test("reads the bucket out of the env, so `aai dev` gets a real store", async () => {
    // The three keys together — two of three resolves nothing, deliberately, so a
    // typo cannot half-configure a bucket. With a DATABASE_URL beside them that is a
    // refusal naming the key; the arm below is the configured one.
    const half = installWorkflowSupport({
      env: {
        DATABASE_URL: "postgres://user:pw@127.0.0.1:1/db",
        AAI_UPLOAD_STORAGE_URL: "https://s.example",
        AAI_UPLOAD_STORAGE_KEY: "k",
      },
      logger: quietLogger(),
    });
    await expect(half.uploads.info("upl_x")).rejects.toThrow(/AAI_UPLOAD_STORAGE_URL/);
    await half.close();

    const whole = installWorkflowSupport({
      env: {
        DATABASE_URL: "postgres://user:pw@127.0.0.1:1/db",
        AAI_UPLOAD_STORAGE_URL: "https://s.example",
        AAI_UPLOAD_STORAGE_KEY: "k",
        AAI_UPLOAD_STORAGE_BUCKET: "b",
      },
      logger: quietLogger(),
    });
    // A real store, so the failure is a CONNECTION rather than a configuration one —
    // `createPostgresDb` connects on first query, and nothing is listening.
    await expect(whole.uploads.info("upl_x")).rejects.not.toThrow(/AAI_UPLOAD_STORAGE/);
    await whole.close();
  });

  test("publishes the reporter, so a step's report reaches the logger", async () => {
    const info = vi.fn();
    installWorkflowSupport({ logger: { ...quietLogger(), info } });
    await report("halfway");
    expect(info).toHaveBeenCalledWith("Workflow: halfway", expect.anything());
  });

  test("publishes stepFetch, so a step's HTTP does NOT go through the global", async () => {
    const global = vi.fn(async () => new Response("global"));
    vi.stubGlobal("fetch", global);
    install();
    // The published fetch is a real undici dispatcher, so this request is
    // expected to fail — what matters is that the GLOBAL was not what tried it.
    await stepFetch("http://127.0.0.1:1/never").catch(() => undefined);
    expect(global).not.toHaveBeenCalled();
  });

  test("without it, stepFetch silently falls back to the global — the regression to catch", async () => {
    const global = vi.fn(async () => new Response("global"));
    vi.stubGlobal("fetch", global);
    await stepFetch("http://127.0.0.1:1/never").catch(() => undefined);
    // Green here and green above is what makes the assertion above meaningful:
    // the fallback is real, works, and speaks HTTP/2.
    expect(global).toHaveBeenCalledOnce();
  });

  test("returns the store it published, so a server can serve the upload routes", () => {
    const { uploads } = install();
    expect(uploads.create).toBeTypeOf("function");
    expect(uploads.info).toBeTypeOf("function");
    expect(uploads.read).toBeTypeOf("function");
  });

  test("hands back a close, because the pools it opens are the SERVER's to release", async () => {
    // `aai dev` re-runs `createServer` on every save. Before this, each rebuild
    // stranded an upload pool and an undici keep-alive pool — nothing anywhere
    // held a reference to close. Idempotent, since a server may close twice.
    const support = install();
    await expect(support.close()).resolves.toBeUndefined();
    await expect(support.close()).resolves.toBeUndefined();
  });
});
