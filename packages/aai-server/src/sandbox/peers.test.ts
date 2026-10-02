// Copyright 2026 the AAI authors. MIT license.

import { describe, expect, test } from "vitest";
import { captureLogs } from "../_logger-test-utils.ts";
import { createTestStore } from "../_orchestrator-test-utils.ts";
import type { BundleStore } from "../store-types.ts";
import { createMemorySandboxDirectory } from "./directory.ts";
import { findPeerSession } from "./peers.ts";
import { createSlotCache } from "./slots.ts";

const PEER = { sessionUrl: "wss://peer.test/websocket", guestOrigin: "wss://peer.test" };

/** The real memory store with its version read replaced. */
function storeAtVersion(read: () => Promise<number | null>): BundleStore {
  return { ...createTestStore(), getAgentVersion: read };
}

describe("findPeerSession", () => {
  const logs = captureLogs();

  test("no directory means no peer", async () => {
    const store = storeAtVersion(() => Promise.resolve(1));
    await expect(findPeerSession("a", { slots: createSlotCache(), store })).resolves.toBeNull();
  });

  test("routes to the peer running the CURRENT version, tagged with it", async () => {
    const directory = createMemorySandboxDirectory();
    directory.setPeer("a", 2, PEER);
    const store = storeAtVersion(() => Promise.resolve(2));
    await expect(
      findPeerSession("a", { slots: createSlotCache(), store, directory }),
    ).resolves.toEqual({ ok: true, ...PEER, version: 2 });
  });

  test("a peer on a superseded version is not a match", async () => {
    const directory = createMemorySandboxDirectory();
    directory.setPeer("a", 1, PEER);
    const store = storeAtVersion(() => Promise.resolve(2));
    await expect(
      findPeerSession("a", { slots: createSlotCache(), store, directory }),
    ).resolves.toBeNull();
  });

  test("a deleted agent (no version) never routes to a draining peer", async () => {
    const directory = createMemorySandboxDirectory();
    directory.setPeer("a", 1, PEER);
    const store = storeAtVersion(() => Promise.resolve(null));
    await expect(
      findPeerSession("a", { slots: createSlotCache(), store, directory }),
    ).resolves.toBeNull();
  });

  test("a failing lookup reads as no peer, and is logged", async () => {
    const directory = createMemorySandboxDirectory();
    const store = storeAtVersion(() => Promise.reject(new Error("db down")));
    await expect(
      findPeerSession("a", { slots: createSlotCache(), store, directory }),
    ).resolves.toBeNull();
    expect(logs.warns()).toHaveLength(1);
  });
});
