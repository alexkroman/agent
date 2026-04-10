// Copyright 2025 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { decryptEnv, deriveCredentialKey, encryptEnv } from "./secrets.ts";

describe("credentials", () => {
  test("encrypt and decrypt round-trip", async () => {
    const key = await deriveCredentialKey("test-secret");
    const env = { ASSEMBLYAI_API_KEY: "sk-123", MY_SECRET: "hunter2" };
    const jwe = await encryptEnv(key, { env, slug: "my-agent" });
    expect(typeof jwe).toBe("string");
    expect(jwe).not.toContain("sk-123");
    expect(await decryptEnv(key, { encrypted: jwe, slug: "my-agent" })).toEqual(env);
  });

  test("different secrets cannot decrypt", async () => {
    const key1 = await deriveCredentialKey("secret-a");
    const key2 = await deriveCredentialKey("secret-b");
    const jwe = await encryptEnv(key1, { env: { KEY: "val" }, slug: "my-agent" });
    await expect(decryptEnv(key2, { encrypted: jwe, slug: "my-agent" })).rejects.toThrow();
  });

  test("wrong slug cannot decrypt", async () => {
    const key = await deriveCredentialKey("test-secret");
    const jwe = await encryptEnv(key, { env: { KEY: "val" }, slug: "agent-a" });
    await expect(decryptEnv(key, { encrypted: jwe, slug: "agent-b" })).rejects.toThrow();
  });

  test("empty env round-trips", async () => {
    const key = await deriveCredentialKey("test-secret");
    const jwe = await encryptEnv(key, { env: {}, slug: "my-agent" });
    expect(await decryptEnv(key, { encrypted: jwe, slug: "my-agent" })).toEqual({});
  });

  test("same input produces different JWEs (unique IVs)", async () => {
    const key = await deriveCredentialKey("test-secret");
    const env = { KEY: "value" };
    const jwe1 = await encryptEnv(key, { env, slug: "my-agent" });
    const jwe2 = await encryptEnv(key, { env, slug: "my-agent" });
    expect(jwe1).not.toBe(jwe2);
  });
});
