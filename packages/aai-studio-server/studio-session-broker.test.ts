// Copyright 2026 the AAI authors. MIT license.

import { createMemoryChatStore } from "aai-server/chat-store";
import type { GuestConnection } from "aai-server/rpc-schemas";
import type { WarmHarness } from "aai-server/sandbox-vm";
import { createMemoryWorkspaceStore } from "aai-server/workspace-store";
import { describe, expect, test, vi } from "vitest";
import { chatUrlFromSessionUrl, createStudioSessionBroker } from "./studio-session-broker.ts";
import { createWorkspace, getWorkspace } from "./studio-workspace.ts";

const SCOPE = "scope";
const PROJECT = "proj";

type FakeGuest = {
  warm: WarmHarness;
  requests: { method: string; params: unknown }[];
  handlers: Map<string, (params: unknown) => unknown>;
  disposed: () => boolean;
};

function fakeGuest(sessionUrl = "wss://tunnel.example:443/websocket"): FakeGuest {
  const requests: FakeGuest["requests"] = [];
  const handlers = new Map<string, (params: unknown) => unknown>();
  let disposed = false;
  const conn = {
    sendRequest: async (method: string, params?: unknown) => {
      if (disposed) throw new Error("Connection disposed");
      requests.push({ method, params });
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
    sessionUrl,
    [Symbol.asyncDispose]: async () => {
      disposed = true;
    },
  } as unknown as WarmHarness;
  return { warm, requests, handlers, disposed: () => disposed };
}

async function makeBroker(guests: FakeGuest[]) {
  const workspaces = createMemoryWorkspaceStore();
  const chats = createMemoryChatStore();
  await createWorkspace(workspaces, SCOPE, PROJECT, { files: { "agent.ts": "// v1" } });
  let spawned = 0;
  const spawn = vi.fn(async () => {
    const guest = guests[spawned];
    spawned += 1;
    if (!guest) throw new Error("no more fake guests");
    return guest.warm;
  });
  const broker = createStudioSessionBroker({
    workspaces,
    chats,
    spawn: spawn as never,
    harnessPath: "/fake/harness.mjs",
    build: async () => ({ worker: "export default {}" }),
  });
  return { broker, workspaces, chats, spawn };
}

describe("studio session broker", () => {
  test("boots a sandbox, installs the session, and returns the public chat URL", async () => {
    const guest = fakeGuest();
    const { broker } = await makeBroker([guest]);
    const session = await broker.ensureSession(SCOPE, PROJECT, "caller-key");
    expect(session).toEqual({ url: "https://tunnel.example/studio/chat" });
    const init = guest.requests.find((r) => r.method === "studio/session-init");
    const params = init?.params as { apiKey: string; files: Record<string, string> };
    // The CALLER'S key rides to the guest — LLM credential + chat bearer.
    expect(params.apiKey).toBe("caller-key");
    expect(params.files["agent.ts"]).toBe("// v1");
    await broker.dispose();
  });

  test("returns null for a missing project without leaking a sandbox", async () => {
    const guest = fakeGuest();
    const { broker } = await makeBroker([guest]);
    expect(await broker.ensureSession(SCOPE, "ghost", "k")).toBeNull();
    expect(guest.disposed()).toBe(true);
    await broker.dispose();
  });

  test("reuses the live sandbox and re-inits with the store's current files", async () => {
    const guest = fakeGuest();
    const { broker, workspaces, spawn } = await makeBroker([guest]);
    await broker.ensureSession(SCOPE, PROJECT, "k");
    // The editor writes a file between page sessions…
    const { mutateWorkspace } = await import("./studio-workspace.ts");
    await mutateWorkspace(workspaces, SCOPE, PROJECT, (ws) => ({
      ...ws,
      files: { "agent.ts": "// v2" },
    }));
    await broker.ensureSession(SCOPE, PROJECT, "k");
    expect(spawn).toHaveBeenCalledTimes(1);
    const inits = guest.requests.filter((r) => r.method === "studio/session-init");
    expect(inits).toHaveLength(2);
    // …and the re-init must never serve a stale tree.
    const reinit = (inits[1]?.params ?? {}) as { files?: Record<string, string> };
    expect(reinit.files?.["agent.ts"]).toBe("// v2");
    await broker.dispose();
  });

  test("a dead sandbox is replaced on the next broker call", async () => {
    const first = fakeGuest();
    const second = fakeGuest("wss://tunnel2.example:443/websocket");
    const { broker, spawn } = await makeBroker([first, second]);
    await broker.ensureSession(SCOPE, PROJECT, "k");
    // Kill the first sandbox (idle eviction / crash) — re-init will reject.
    await first.warm[Symbol.asyncDispose]();
    const session = await broker.ensureSession(SCOPE, PROJECT, "k");
    expect(session?.url).toBe("https://tunnel2.example/studio/chat");
    expect(spawn).toHaveBeenCalledTimes(2);
    await broker.dispose();
  });

  test("guest sync-workspace writes through to the project store, validated", async () => {
    const guest = fakeGuest();
    const { broker, workspaces } = await makeBroker([guest]);
    await broker.ensureSession(SCOPE, PROJECT, "k");
    const sync = guest.handlers.get("studio/sync-workspace");
    await sync?.({ files: { "agent.ts": "// agent-edited" } });
    expect((await getWorkspace(workspaces, SCOPE, PROJECT))?.files["agent.ts"]).toBe(
      "// agent-edited",
    );
    // Traversal paths are refused exactly like a client file PUT.
    await expect(Promise.resolve(sync?.({ files: { "../evil.ts": "x" } }))).rejects.toThrow(
      /Invalid workspace sync/,
    );
    await broker.dispose();
  });

  test("guest persist-chat writes the conversation row", async () => {
    const guest = fakeGuest();
    const { broker, chats } = await makeBroker([guest]);
    await broker.ensureSession(SCOPE, PROJECT, "k");
    const persist = guest.handlers.get("studio/persist-chat");
    const history = [{ id: "m1", role: "user", parts: [] }];
    await persist?.({ messages: history });
    expect(await chats.getChat(SCOPE, PROJECT)).toEqual(history);
    await broker.dispose();
  });

  test("guest build requests run the build runner and classify failures", async () => {
    const guest = fakeGuest();
    const { broker } = await makeBroker([guest]);
    await broker.ensureSession(SCOPE, PROJECT, "k");
    const build = guest.handlers.get("studio/build");
    expect(await build?.({ files: { "agent.ts": "x" } })).toEqual({
      worker: "export default {}",
    });
    expect(await build?.({ files: "nope" })).toMatchObject({
      buildError: expect.stringContaining("Invalid build request"),
    });
    await broker.dispose();
  });
});

describe("chatUrlFromSessionUrl", () => {
  test("maps the voice endpoint to the https chat endpoint", () => {
    expect(chatUrlFromSessionUrl("wss://h.modal.host:12345/websocket")).toBe(
      "https://h.modal.host:12345/studio/chat",
    );
    expect(chatUrlFromSessionUrl("ws://127.0.0.1:8080/websocket")).toBe(
      "http://127.0.0.1:8080/studio/chat",
    );
  });
});
