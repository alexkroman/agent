// Copyright 2026 the AAI authors. MIT license.
/**
 * Shared fakes for the studio session suites — `studio-session-broker.test.ts`
 * (boot/reuse/adopt/evict) and `studio-session-publish.test.ts` (the
 * `workspace/deploy` path). Both drive the broker's public surface against a
 * fake guest, so the guest and the broker factory live here rather than in
 * whichever suite happened to be written first.
 */

import { createMemoryChatStore } from "aai-server/chat-store";
import type { GuestConnection } from "aai-server/rpc-schemas";
import type { spawnWarmHarness, WarmHarness } from "aai-server/sandbox-vm";
import { createMemoryWorkspaceStore } from "aai-server/workspace-store";
import { type Mock, vi } from "vitest";
import { createMemoryPreviewQueue, type PreviewJob } from "./studio-preview-queue.ts";
import { createStudioSessionBroker } from "./studio-session-broker.ts";
import { createWorkspace } from "./studio-workspace.ts";

export const SCOPE = "scope";
export const PROJECT = "proj";

export type FakeGuest = {
  warm: WarmHarness;
  requests: { method: string; params: unknown }[];
  handlers: Map<string, (params: unknown) => unknown>;
  disposed: () => boolean;
};

export function fakeGuest(
  guestOrigin = "wss://tunnel.example:443",
  /**
   * Hold `workspace/deploy` open until this resolves — a build in flight, for
   * the specs that assert what may happen to a sandbox WHILE one is running.
   */
  holdDeploy?: Promise<void>,
): FakeGuest {
  const requests: FakeGuest["requests"] = [];
  const handlers = new Map<string, (params: unknown) => unknown>();
  let disposed = false;
  const conn = {
    sendRequest: async (method: string, params?: unknown) => {
      if (disposed) throw new Error("Connection disposed");
      requests.push({ method, params });
      if (method === "workspace/deploy") {
        if (holdDeploy !== undefined) await holdDeploy;
        if (disposed) throw new Error("Connection disposed");
        return {
          ok: true,
          slug: "proj",
          url: "https://platform.example/proj",
          output: "Deployed https://platform.example/proj",
        };
      }
      return { ok: true };
    },
    sendNotification: () => undefined,
    onRequest: (method: string, handler: (params: unknown) => unknown) => {
      handlers.set(method, handler);
    },
    onNotification: () => undefined,
    listen: () => undefined,
    dispose: () => {
      disposed = true;
    },
  } as unknown as GuestConnection;
  const warm = {
    conn,
    guestOrigin,
    token: "sandbox-token",
    sessionUrl: `${guestOrigin}/websocket`,
    [Symbol.asyncDispose]: async () => {
      disposed = true;
    },
  } as unknown as WarmHarness;
  return { warm, requests, handlers, disposed: () => disposed };
}

/**
 * The spawner a broker is wired with: hands out `guests` in order, so a test
 * that expects a REPLACEMENT sandbox says so by supplying a second guest.
 *
 * Typed as `spawnWarmHarness` itself rather than cast in at each call site: the
 * fake ignores the options, and a cast at that seam is one that stops reporting
 * the day the real spawner's signature moves. Shared because both this file's
 * `makeBroker` and the broker suite's own cross-replica `makeReplica` need the
 * same hand-out-in-order queue.
 */
export function fakeSpawn(guests: FakeGuest[]): Mock<typeof spawnWarmHarness> {
  let spawned = 0;
  return vi.fn<typeof spawnWarmHarness>(async () => {
    const guest = guests[spawned];
    spawned += 1;
    if (!guest) throw new Error("no more fake guests");
    return guest.warm;
  });
}

export async function makeBroker(
  guests: FakeGuest[],
  extra: Partial<Parameters<typeof createStudioSessionBroker>[0]> = {},
) {
  const workspaces = createMemoryWorkspaceStore();
  const chats = createMemoryChatStore();
  await createWorkspace(workspaces, SCOPE, PROJECT, { files: { "agent.ts": "// v1" } });
  const spawn = fakeSpawn(guests);
  // Every preview job enqueued: the ROW is what a redelivery elsewhere sees.
  const enqueued: PreviewJob[] = [];
  const inner = createMemoryPreviewQueue();
  const broker = createStudioSessionBroker({
    workspaces,
    chats,
    spawn,
    harnessPath: "/fake/harness.mjs",
    previewQueue: {
      ...inner,
      enqueue: (job) => {
        enqueued.push(job);
        return inner.enqueue(job);
      },
    },
    ...extra,
  });
  return { broker, workspaces, chats, spawn, enqueued };
}
