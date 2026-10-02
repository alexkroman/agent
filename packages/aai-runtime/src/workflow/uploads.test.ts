// Copyright 2026 the AAI authors. MIT license.
/**
 * Specs for `createUploadStore`'s own decisions: which home an upload's record lives
 * in, and what a deployment with nowhere to put uploads answers.
 *
 * What the store then DOES with a body — when the row appears, how a body is cut
 * into windows, what a streamed upload publishes — is `../uploads/store-blobs.test.ts`,
 * and the byte contract it writes through has specs of its own in
 * `../uploads/blobs.test.ts`.
 */

import { describe, expect, test, vi } from "vitest";
import { fakeFetch } from "../_fetch-test-utils.ts";
import { body, memoryStore, ramp } from "../_upload-store-test-utils.ts";
import { resolveStorageHome } from "./storage-home.ts";
import {
  createMemoryUploadBackend,
  createUnavailableUploadStore,
  createUploadStore,
  uploadBytesAreRemote,
} from "./uploads.ts";

describe("a deployment with nowhere to put uploads", () => {
  test("refuses every operation, naming what is missing", async () => {
    // Nothing at all: no database, and no local directory to fall back into. Only a
    // caller that resolved neither reaches this — every host in this repo passes a
    // `localDir`, because `localWorkflowDataDir()` always answers one.
    const store = createUploadStore({ home: { kind: "local" } });
    await expect(store.create({}, body(ramp(4)))).rejects.toThrow(/DATABASE_URL/);
    await expect(store.create({}, body(ramp(4)))).rejects.toThrow(/AAI_UPLOAD_STORAGE_URL/);
  });

  test("a DATABASE with no bucket refuses, rather than downgrading to the local home", async () => {
    // The one combination that has no answer. The local home would store this
    // upload perfectly well and lose it by the time a run resumed in another
    // process — which is exactly the deleted file backend's failure, and a database
    // is the thing that makes such a resume possible. So it refuses, and the remedy
    // it names is a durable byte store.
    const { db } = memoryStore();
    const store = createUploadStore({
      home: { kind: "postgres", db },
      localDir: "/should/not/be/used",
    });
    const failed = await store
      .create({}, body(ramp(4)))
      .then(() => expect.fail("the store accepted an upload with nowhere durable to put it"))
      .catch((err: unknown) => err as Error);
    expect(failed.message).toContain("AAI_UPLOAD_STORAGE_URL");
    expect(failed.message).toContain("supabase status -o env");
  });

  test("DIAGNOSES only the half that is missing", async () => {
    const { db } = memoryStore();
    const store = createUploadStore({ home: { kind: "postgres", db } });
    const failed = await store
      .beginParts("abc", {}, 4)
      .then(() => expect.fail("the store accepted a claim it has nowhere to store"))
      .catch((err: unknown) => err as Error);
    // The first sentence is the diagnosis and names one half; the `.env` block after it
    // is deliberately COMPLETE, because a reader who has just found the first missing
    // variable is about to find the second.
    const [diagnosis = ""] = failed.message.split(".");
    expect(diagnosis).toContain("AAI_UPLOAD_STORAGE_URL");
    expect(diagnosis).not.toContain("DATABASE_URL");
    expect(failed.message).toContain("supabase status -o env");
  });

  test("refuses the READS too, so a misconfiguration cannot look like a missing id", async () => {
    // `info` answering undefined would make "this platform stores no uploads"
    // indistinguishable from "nobody uploaded that", which is the one confusion an
    // operator cannot debug from outside.
    const store = createUnavailableUploadStore("a bucket");
    await expect(store.info("upl_x")).rejects.toThrow(/a bucket/);
    await expect(store.read("upl_x", 0, 1)).rejects.toThrow(/a bucket/);
  });
});

/**
 * Which HOME an upload's record gets, and why the platform outranks a database.
 *
 * This tree used to start at `db`, on a premise it stated: "a database means
 * durable runs, so the bytes have to be durable too." The workflow queue moving to
 * the platform falsified it — a deployed app's runs are durable with no database of
 * the author's — so the choice keyed off a signal that had stopped meaning
 * durability, and a deployed guest with no `DATABASE_URL` got durable runs with
 * their uploads in a directory that recycles. One sandbox filled its filesystem
 * that way and `ENOSPC`'d every write.
 */
describe("where an upload's record lives", () => {
  /** A fetch that records the methods the platform backend sends. */
  function platformFetch(): { fetch: typeof globalThis.fetch; methods: () => string[] } {
    const methods: string[] = [];
    // `fakeFetch` is the one place a double is narrowed to `fetch` — see
    // `_fetch-test-utils.ts` on why a cast per call site is the wrong shape.
    const fetch = fakeFetch(async (_url, init) => {
      const body = JSON.parse(String(init.body ?? "{}")) as { method?: string };
      methods.push(String(body.method));
      // Enough for `create` to get through: a minted record, then a read of it.
      return new Response(JSON.stringify({ result: null }), { status: 200 });
    });
    return { fetch, methods: () => methods };
  }

  test("a deployed guest with a database still records on the PLATFORM", async () => {
    // The preference itself is `resolveStorageHome`'s (`storage-home.test.ts`); this
    // is the store honouring it: handed a platform home, the record goes there and
    // the database an author also set is never touched.
    const { db, sql } = memoryStore();
    vi.stubEnv("AAI_PLATFORM_BASE_URL", "https://aai.example/a");
    vi.stubEnv("AAI_GUEST_TOKEN", "t");
    const home = resolveStorageHome(db);
    vi.unstubAllEnvs();
    expect(home.kind).toBe("platform");
    const { fetch, methods } = platformFetch();
    const store = createUploadStore({
      home: { kind: "platform", platform: { base: "https://aai.example/a", token: "t", fetch } },
      blobs: createMemoryUploadBackend(),
    });
    await store.create({ name: "clip.wav" }, body(ramp(4))).catch(() => undefined);
    expect(methods().length).toBeGreaterThan(0);
    expect(sql).toEqual([]);
  });

  test("a deployed guest with NO database still gets a durable record home", async () => {
    // The bug this fixes: no `db`, so the old tree fell through to the local
    // directory even though the platform was right there.
    const { fetch, methods } = platformFetch();
    const store = createUploadStore({
      home: { kind: "platform", platform: { base: "https://aai.example/a", token: "t", fetch } },
      blobs: createMemoryUploadBackend(),
      localDir: "/should/not/be/used",
    });
    await store.create({ name: "clip.wav" }, body(ramp(4))).catch(() => undefined);
    expect(methods().length).toBeGreaterThan(0);
  });

  test("the platform arm still REFUSES without somewhere to put the bytes", async () => {
    // A durable record behind bytes that die with the container is the same failure
    // in reverse — and the record would then name an object nothing can produce.
    const store = createUploadStore({
      home: { kind: "platform", platform: { base: "https://aai.example/a", token: "t" } },
      localDir: "/should/not/be/used",
    });
    await expect(store.create({}, body(ramp(4)))).rejects.toThrow(/AAI_UPLOAD_STORAGE_URL/);
  });
});

describe("uploadBytesAreRemote — the `directParts` claim follows the store's HOME", () => {
  const platform = { base: "https://aai.example/a", token: "t" };
  const blobs = createMemoryUploadBackend();

  test("a durable home with a bucket reads remote bytes — platform and postgres alike", () => {
    // The platform arm with NO database is the case the old `db && blobs` predicate
    // refused: a deployed guest records on the platform and reads the brokered bucket.
    expect(uploadBytesAreRemote({ kind: "platform", platform }, blobs)).toBe(true);
    expect(uploadBytesAreRemote({ kind: "postgres", db: memoryStore().db }, blobs)).toBe(true);
  });

  test("a local home never does, even with a bucket resolved — the store ignores it", () => {
    expect(uploadBytesAreRemote({ kind: "local" }, blobs)).toBe(false);
  });

  test("no bucket, no remote bytes", () => {
    expect(uploadBytesAreRemote({ kind: "platform", platform }, undefined)).toBe(false);
  });
});
