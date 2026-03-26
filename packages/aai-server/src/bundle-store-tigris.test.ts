// Copyright 2025 the AAI authors. MIT license.
import { Readable } from "node:stream";
import type { SdkStream } from "@smithy/types";
import { describe, expect, test, vi } from "vitest";
import { createBundleStore, type createS3Client } from "./bundle-store-tigris.ts";
import { deriveCredentialKey } from "./credentials.ts";

function mockS3() {
  const objects = new Map<string, string>();

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: mock dispatches multiple S3 commands
  const send = vi.fn(async (cmd: unknown) => {
    const name = (cmd as { constructor: { name: string } }).constructor.name;
    const input = (cmd as { input: Record<string, unknown> }).input;

    if (name === "PutObjectCommand") {
      const key = input.Key as string;
      objects.set(key, input.Body as string);
      return { ETag: `"etag-${key}"` };
    }

    if (name === "GetObjectCommand") {
      const key = input.Key as string;
      const ifNoneMatch = input.IfNoneMatch as string | undefined;
      const data = objects.get(key);

      if (!data) {
        const err = new Error("NoSuchKey");
        (err as { name: string }).name = "NoSuchKey";
        throw err;
      }

      const etag = `"etag-${key}"`;
      if (ifNoneMatch === etag) {
        // Simulate AWS SDK v3 behavior: throws Unknown with status 304
        const err = new Error("Not Modified") as Error & {
          name: string;
          $metadata: { httpStatusCode: number };
        };
        err.name = "Unknown";
        err.$metadata = { httpStatusCode: 304 };
        throw err;
      }

      const stream = Readable.from([data]) as unknown as SdkStream<Readable>;
      (stream as unknown as { transformToString: () => Promise<string> }).transformToString =
        async () => data;
      return { Body: stream, ETag: etag };
    }

    if (name === "ListObjectsV2Command") {
      const prefix = input.Prefix as string;
      const contents = [...objects.keys()]
        .filter((k) => k.startsWith(prefix))
        .map((Key) => ({ Key }));
      return { Contents: contents };
    }

    if (name === "DeleteObjectsCommand") {
      const deleteInput = input.Delete as { Objects: { Key: string }[] };
      for (const { Key } of deleteInput.Objects) objects.delete(Key);
      return { Deleted: deleteInput.Objects };
    }

    return {};
  });

  return { send } as unknown as ReturnType<typeof createS3Client>;
}

describe("bundle store S3 304 handling", () => {
  test("getManifest returns cached data on 304 Not Modified", async () => {
    const s3 = mockS3();
    const credentialKey = await deriveCredentialKey("test-secret");
    const store = createBundleStore(s3, { bucket: "test", credentialKey });

    // Deploy an agent (writes to S3)
    await store.putAgent({
      slug: "test-agent",
      env: { ASSEMBLYAI_API_KEY: "key123" },
      worker: "console.log('w');",
      clientFiles: { "index.html": "<html></html>" },
      credential_hashes: ["hash1"],
    });

    // First read — populates cache
    const first = await store.getManifest("test-agent");
    expect(first).not.toBeNull();
    expect(first?.slug).toBe("test-agent");

    // Second read — S3 returns 304 (Unknown), should use cached data
    const second = await store.getManifest("test-agent");
    expect(second).not.toBeNull();
    expect(second?.slug).toBe("test-agent");
  });

  test("getManifest returns null for non-existent agent", async () => {
    const s3 = mockS3();
    const credentialKey = await deriveCredentialKey("test-secret");
    const store = createBundleStore(s3, { bucket: "test", credentialKey });

    const result = await store.getManifest("nonexistent");
    expect(result).toBeNull();
  });

  test("cache evicts least recently used entries when maxCacheSize is exceeded", async () => {
    const s3 = mockS3();
    const credentialKey = await deriveCredentialKey("test-secret");
    // Create store with a very small cache (2 entries)
    const store = createBundleStore(s3, { bucket: "test", credentialKey, maxCacheSize: 2 });

    // Deploy 3 agents to fill cache beyond limit
    for (const name of ["a", "b", "c"]) {
      await store.putAgent({
        slug: name,
        env: { KEY: "val" },
        worker: `console.log('${name}');`,
        clientFiles: {},
        credential_hashes: [],
      });
    }

    // Read worker code for agents a, b, c — each populates a cache entry
    await store.getWorkerCode("a"); // cache: [a]
    await store.getWorkerCode("b"); // cache: [a, b]
    await store.getWorkerCode("c"); // cache: [b, c] — a evicted

    // Agent "a" was evicted, so next fetch must hit S3 (no IfNoneMatch)
    const sendSpy = s3.send as ReturnType<typeof vi.fn>;
    const callsBefore = sendSpy.mock.calls.length;
    const resultA = await store.getWorkerCode("a");
    expect(resultA).toBe("console.log('a');");

    // The S3 call should NOT have IfNoneMatch (cache miss, not conditional GET)
    const getCall = sendSpy.mock.calls
      .slice(callsBefore)
      .find(
        (c) => (c[0] as { constructor: { name: string } }).constructor.name === "GetObjectCommand",
      );
    expect(getCall).toBeDefined();
    expect((getCall?.[0] as { input: Record<string, unknown> }).input.IfNoneMatch).toBeUndefined();
  });
});
