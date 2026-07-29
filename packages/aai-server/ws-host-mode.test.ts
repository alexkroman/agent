// Copyright 2026 the AAI authors. MIT license.

import { describe, expect, test } from "vitest";
import { hashApiKey } from "./secrets.ts";
import { createTestStore, TEST_AGENT_CONFIG } from "./test-utils.ts";
import {
  authorizeHostMode,
  bearerToken,
  guardHostModeUpgrade,
  wantsHostMode,
} from "./ws-host-mode.ts";

async function storeOwnedBy(key: string) {
  const store = createTestStore();
  await store.putAgent({
    slug: "my-agent",
    env: {},
    worker: "w",
    clientFiles: {},
    credential_hashes: [await hashApiKey(key)],
    agentConfig: TEST_AGENT_CONFIG,
  });
  return store;
}

describe("wantsHostMode", () => {
  test("only ?host=1 opts in", () => {
    expect(wantsHostMode("/a/websocket?host=1")).toBe(true);
    expect(wantsHostMode("/a/websocket")).toBe(false);
    expect(wantsHostMode("/a/websocket?host=0")).toBe(false);
    // Truthiness games shouldn't unlock it.
    expect(wantsHostMode("/a/websocket?host=true")).toBe(false);
  });
});

describe("bearerToken", () => {
  test("reads a Bearer header", () => {
    expect(bearerToken({ authorization: "Bearer abc" })).toBe("abc");
  });

  test("ignores other schemes and missing headers", () => {
    expect(bearerToken({ authorization: "Basic abc" })).toBe("");
    expect(bearerToken({})).toBe("");
  });
});

describe("authorizeHostMode", () => {
  test("the owner is allowed", async () => {
    const store = await storeOwnedBy("key1");
    expect(await authorizeHostMode("my-agent", { authorization: "Bearer key1" }, store)).toEqual({
      allowed: true,
    });
  });

  test("no key is a 401 that says what to send", async () => {
    const store = await storeOwnedBy("key1");
    const result = await authorizeHostMode("my-agent", {}, store);
    expect(result).toMatchObject({ allowed: false, code: 401 });
    expect(result.allowed === false && result.reason).toContain("Authorization: Bearer");
  });

  test("another user's key is refused", async () => {
    // The whole reason this gate exists: an agent's WebSocket is otherwise
    // unauthenticated, and host mode spends the owner's provider credentials.
    const store = await storeOwnedBy("key1");
    expect(
      await authorizeHostMode("my-agent", { authorization: "Bearer key2" }, store),
    ).toMatchObject({ allowed: false, code: 403 });
  });

  test("an unknown slug looks identical to a forbidden one", async () => {
    // No existence oracle for a caller who does not own the slug.
    const store = await storeOwnedBy("key1");
    const unknown = await authorizeHostMode("nope", { authorization: "Bearer key1" }, store);
    const forbidden = await authorizeHostMode("my-agent", { authorization: "Bearer key2" }, store);
    expect(unknown).toEqual(forbidden);
  });
});

describe("guardHostModeUpgrade", () => {
  function fakeSocket() {
    const writes: string[] = [];
    let destroyed = false;
    return {
      socket: {
        write: (data: string) => writes.push(data),
        destroy: () => {
          destroyed = true;
        },
      },
      writes,
      isDestroyed: () => destroyed,
    };
  }

  test("a plain (non-host) upgrade passes without touching the store", async () => {
    const { socket, writes } = fakeSocket();
    const ok = await guardHostModeUpgrade({
      rawUrl: "/my-agent/websocket",
      slug: "my-agent",
      headers: {},
      store: createTestStore(),
      socket,
    });
    expect(ok).toBe(true);
    expect(writes).toEqual([]);
  });

  test("the owner's host-mode upgrade proceeds", async () => {
    const { socket, writes } = fakeSocket();
    const ok = await guardHostModeUpgrade({
      rawUrl: "/my-agent/websocket?host=1",
      slug: "my-agent",
      headers: { authorization: "Bearer key1" },
      store: await storeOwnedBy("key1"),
      socket,
    });
    expect(ok).toBe(true);
    expect(writes).toEqual([]);
  });

  test("a refused upgrade answers the handshake with a real status, then closes", async () => {
    // A bare RST is indistinguishable from a network fault to the caller.
    const { socket, writes, isDestroyed } = fakeSocket();
    const ok = await guardHostModeUpgrade({
      rawUrl: "/my-agent/websocket?host=1",
      slug: "my-agent",
      headers: { authorization: "Bearer not-the-owner" },
      store: await storeOwnedBy("key1"),
      socket,
    });
    expect(ok).toBe(false);
    expect(writes.join("")).toMatch(/^HTTP\/1\.1 403 Forbidden\r\n/);
    expect(isDestroyed()).toBe(true);
  });

  test("a keyless host-mode upgrade gets a 401 that says what to send", async () => {
    const { socket, writes } = fakeSocket();
    const ok = await guardHostModeUpgrade({
      rawUrl: "/my-agent/websocket?host=1",
      slug: "my-agent",
      headers: {},
      store: await storeOwnedBy("key1"),
      socket,
    });
    expect(ok).toBe(false);
    expect(writes.join("")).toMatch(/^HTTP\/1\.1 401 Unauthorized\r\n/);
    expect(writes.join("")).toContain("Authorization: Bearer");
  });
});
