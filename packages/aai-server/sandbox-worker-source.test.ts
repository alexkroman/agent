// Copyright 2026 the AAI authors. MIT license.
/**
 * Which way the worker bundle reaches a guest — the choice `loadWorkerSource`
 * makes inside sandbox resolution (sandbox-resolve.ts).
 *
 * Split from sandbox-resolve.test.ts, which is about the agents-row change
 * stream moving resident sandboxes; this is about what a spawn is HANDED.
 */

import { hash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryAgentRows } from "./agent-store.ts";
import { createMemoryBlobStorage } from "./blob-storage.ts";
import { createBundleStore } from "./bundle-store.ts";
import { resolveSandbox } from "./sandbox-resolve.ts";
import { createSlotCache } from "./sandbox-slots.ts";
import { createMemorySecretStore } from "./secret-store.ts";
import { createTestStore, spawnedAgent } from "./test-utils.ts";

const { mockSpawnAgentServer } = vi.hoisted(() => ({
  mockSpawnAgentServer: vi.fn(),
}));

vi.mock("./sandbox-vm.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./sandbox-vm.ts")>()),
  spawnAgentServer: mockSpawnAgentServer,
}));

// Armed here rather than in the `vi.hoisted` factory above — see `spawnedAgent`.
beforeEach(() => {
  mockSpawnAgentServer.mockReset().mockResolvedValue(spawnedAgent());
});

/**
 * Which way the worker bundle reaches the guest. The URL path is the reason
 * this choice exists: the ~8 MB bundle used to be read out of Storage into
 * this process and written straight back out into the sandbox, twice per cold
 * spawn, and the guest can fetch it itself because it hash-verifies before
 * loading either way.
 */
describe("worker source selection", () => {
  /** A blob store that CAN sign, wrapped so byte reads are observable. */
  function signingStore(slug: string) {
    const blobs = createMemoryBlobStorage();
    const getItem = vi.fn(blobs.getItem);
    const store = createBundleStore(
      {
        ...blobs,
        getItem,
        signedUrl: (key) => Promise.resolve(`https://blobs.test/${key}?token=t`),
      },
      { secrets: createMemorySecretStore(), agents: createMemoryAgentRows() },
    );
    const deploy = (worker: string) =>
      store.putAgent({
        slug,
        env: {},
        worker,
        clientFiles: {},
        credential_hashes: ["hash"],
      });
    return { store, getItem, deploy, slots: createSlotCache() };
  }

  it("hands the guest a signed URL and never reads the bytes", async () => {
    const worker = 'export default { name: "signed" };';
    const deps = signingStore("signed-agent");
    await deps.deploy(worker);
    deps.getItem.mockClear();

    const sandbox = await resolveSandbox("signed-agent", deps);

    expect(mockSpawnAgentServer).toHaveBeenLastCalledWith(
      expect.objectContaining({
        worker: {
          kind: "url",
          url: `https://blobs.test/blobs/${hash("sha256", worker)}?token=t`,
          // The agents row's own record of what the deploy published — which
          // is what makes the URL safe to trust nothing else about.
          sha256: hash("sha256", worker),
        },
      }),
    );
    // The whole point: the bundle never entered this process.
    expect(deps.getItem).not.toHaveBeenCalled();
    await sandbox?.shutdown();
  });

  it("ships the bytes when the blob backend cannot sign", async () => {
    // Local dev and tests: a Map has no URL to hand out. Not a fallback for a
    // failure — a signing failure fails the spawn (below).
    const store = createTestStore();
    await store.putAgent({
      slug: "unsigned-agent",
      env: {},
      worker: "export default {};",
      clientFiles: {},
      credential_hashes: ["hash"],
    });
    const sandbox = await resolveSandbox("unsigned-agent", {
      store,
      slots: createSlotCache(),
    });
    expect(mockSpawnAgentServer).toHaveBeenLastCalledWith(
      expect.objectContaining({ worker: expect.objectContaining({ kind: "inline" }) }),
    );
    await sandbox?.shutdown();
  });

  it("fails the spawn when signing fails, rather than quietly shipping bytes", async () => {
    const deps = signingStore("broken-signing");
    await deps.deploy("export default {};");
    deps.store.getWorkerUrl = () => Promise.reject(new Error("blob signing failed"));
    await expect(resolveSandbox("broken-signing", deps)).rejects.toThrow(/blob signing failed/);
  });
});
