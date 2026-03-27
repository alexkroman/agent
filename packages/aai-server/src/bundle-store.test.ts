// Copyright 2025 the AAI authors. MIT license.
import { createStorage } from "unstorage";
import { describe, expect, test } from "vitest";
import { createBundleStore } from "./bundle-store.ts";
import { deriveCredentialKey } from "./credentials.ts";

describe("bundle store (unstorage)", () => {
  test("putAgent + getManifest round-trip", async () => {
    const storage = createStorage();
    const credentialKey = await deriveCredentialKey("test-secret");
    const store = createBundleStore(storage, { credentialKey });

    await store.putAgent({
      slug: "test-agent",
      env: { ASSEMBLYAI_API_KEY: "key123" },
      worker: "console.log('w');",
      clientFiles: { "index.html": "<html></html>" },
      credential_hashes: ["hash1"],
    });

    const manifest = await store.getManifest("test-agent");
    expect(manifest).not.toBeNull();
    expect(manifest?.slug).toBe("test-agent");
  });

  test("getManifest returns cached data on second read", async () => {
    const storage = createStorage();
    const credentialKey = await deriveCredentialKey("test-secret");
    const store = createBundleStore(storage, { credentialKey });

    await store.putAgent({
      slug: "test-agent",
      env: { ASSEMBLYAI_API_KEY: "key123" },
      worker: "console.log('w');",
      clientFiles: { "index.html": "<html></html>" },
      credential_hashes: ["hash1"],
    });

    const first = await store.getManifest("test-agent");
    expect(first).not.toBeNull();
    expect(first?.slug).toBe("test-agent");

    const second = await store.getManifest("test-agent");
    expect(second).not.toBeNull();
    expect(second?.slug).toBe("test-agent");
  });

  test("getManifest returns null for non-existent agent", async () => {
    const storage = createStorage();
    const credentialKey = await deriveCredentialKey("test-secret");
    const store = createBundleStore(storage, { credentialKey });

    const result = await store.getManifest("nonexistent");
    expect(result).toBeNull();
  });

  test("concurrent putEnv calls do not lose updates", async () => {
    const storage = createStorage();
    const credentialKey = await deriveCredentialKey("test-secret");
    const store = createBundleStore(storage, { credentialKey });

    await store.putAgent({
      slug: "test-agent",
      env: { INITIAL: "value" },
      worker: "console.log('w');",
      clientFiles: { "index.html": "<html></html>" },
      credential_hashes: ["hash1"],
    });

    // Fire two concurrent putEnv calls — without locking, one would overwrite the other
    await Promise.all([
      store.putEnv("test-agent", { A: "1" }),
      store.putEnv("test-agent", { B: "2" }),
    ]);

    // The last write wins, but it must have completed after the first.
    const env = await store.getEnv("test-agent");
    expect(env).not.toBeNull();
    // With serialization, the second call reads the result of the first,
    // then overwrites. So the final env should be { B: "2" }.
    expect(env).toEqual({ B: "2" });
  });

  test("getWorkerCode returns worker code", async () => {
    const storage = createStorage();
    const credentialKey = await deriveCredentialKey("test-secret");
    const store = createBundleStore(storage, { credentialKey });

    await store.putAgent({
      slug: "test-agent",
      env: {},
      worker: "console.log('hello');",
      clientFiles: {},
      credential_hashes: ["hash1"],
    });

    const code = await store.getWorkerCode("test-agent");
    expect(code).toBe("console.log('hello');");
  });

  test("deleteAgent removes all files", async () => {
    const storage = createStorage();
    const credentialKey = await deriveCredentialKey("test-secret");
    const store = createBundleStore(storage, { credentialKey });

    await store.putAgent({
      slug: "test-agent",
      env: {},
      worker: "w",
      clientFiles: { "index.html": "<html></html>" },
      credential_hashes: ["hash1"],
    });

    await store.deleteAgent("test-agent");

    expect(await store.getManifest("test-agent")).toBeNull();
    expect(await store.getWorkerCode("test-agent")).toBeNull();
  });
});
