// Copyright 2026 the AAI authors. MIT license.
// POST /:slug/sync and POST /studio/projects/:project/sync: routing, body
// validation, error-status mapping, and guest-state cleanup — exercised
// through the full orchestrator with a fake sandbox attached to the slot
// cache (no VM).

import { SyncTurnError } from "@alexkroman1/aai/runtime";
import { describe, expect, test, vi } from "vitest";
import { createOrchestrator } from "./orchestrator.ts";
import { createSlotCache, type Sandbox } from "./sandbox.ts";
import { attachSandbox, setSlot } from "./sandbox-slots.ts";
import { createMemoryChatStore } from "./studio/chat-store.ts";
import { createWorkspace, studioScope } from "./studio/studio-workspace.ts";
import { createMemoryWorkspaceStore } from "./studio/workspace-store.ts";
import { authHeaders, createTestStore, type TestFetch } from "./test-utils.ts";

function createFakeSandbox(
  runSyncTurn: Sandbox["runSyncTurn"] = vi.fn(async () => ({ transcript: "hi", reply: "hello" })),
): Sandbox {
  return {
    readyConfig: { audioFormat: "pcm16", sampleRate: 16_000, ttsSampleRate: 24_000 },
    startSession: vi.fn(),
    runSyncTurn,
    shutdown: vi.fn(async () => undefined),
  };
}

async function createSyncOrchestrator(sandbox?: Sandbox): Promise<{ fetch: TestFetch }> {
  const { createMemoryVector } = await import("@alexkroman1/aai/runtime");
  const slots = createSlotCache();
  const workspaces = createMemoryWorkspaceStore();
  if (sandbox) {
    const slot = { slug: "my-agent", keyHash: "h" };
    setSlot(slots, slot);
    attachSandbox(slots, slot, sandbox);
    // The studio route resolves the project's published slug to the same slot.
    await createWorkspace(workspaces, studioScope("key1"), "proj", {
      files: { "agent.ts": "export default {}" },
      deployedSlug: "my-agent",
    });
  }
  const { app } = createOrchestrator({
    slots,
    store: createTestStore(),
    workspaces,
    chats: createMemoryChatStore(),
    defaultVector: (slug) => createMemoryVector({ namespace: slug }),
  });
  return { fetch: async (input, init) => app.request(input, init) };
}

function postSync(fetch: TestFetch, path: string, body: unknown): Promise<Response> {
  return fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("POST /:slug/sync", () => {
  test("runs a turn against the resident sandbox, unauthenticated", async () => {
    const runSyncTurn = vi.fn(async () => ({ transcript: "hi", reply: "hello from sandbox" }));
    const { fetch } = await createSyncOrchestrator(createFakeSandbox(runSyncTurn));
    const res = await postSync(fetch, "/my-agent/sync", { text: "hi" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ transcript: "hi", reply: "hello from sandbox" });
    // The schema-parsed request (history defaulted) is what reaches the sandbox.
    expect(runSyncTurn).toHaveBeenCalledWith({ text: "hi", history: [] });
  });

  test("unknown slug answers 404", async () => {
    const { fetch } = await createSyncOrchestrator();
    const res = await postSync(fetch, "/no-such-agent/sync", { text: "hi" });
    expect(res.status).toBe(404);
  });

  test("malformed JSON answers 400", async () => {
    const { fetch } = await createSyncOrchestrator(createFakeSandbox());
    const res = await postSync(fetch, "/my-agent/sync", "{nope");
    expect(res.status).toBe(400);
  });

  test("schema violation answers 400 before touching the sandbox", async () => {
    const runSyncTurn = vi.fn();
    const { fetch } = await createSyncOrchestrator(createFakeSandbox(runSyncTurn));
    const res = await postSync(fetch, "/my-agent/sync", { history: [] });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain(
      "exactly one of text or audio",
    );
    expect(runSyncTurn).not.toHaveBeenCalled();
  });

  test("SyncTurnError from the sandbox maps to its status", async () => {
    const { fetch } = await createSyncOrchestrator(
      createFakeSandbox(
        vi.fn(async () => {
          throw new SyncTurnError("sync turns require pipeline mode (stt, llm, and tts all set)", {
            status: 409,
          });
        }),
      ),
    );
    const res = await postSync(fetch, "/my-agent/sync", { text: "hi" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain("pipeline mode");
  });

  test("non-SyncTurnError failures answer 500 via the error handler", async () => {
    const { fetch } = await createSyncOrchestrator(
      createFakeSandbox(
        vi.fn(async () => {
          throw new Error("sandbox exploded");
        }),
      ),
    );
    const res = await postSync(fetch, "/my-agent/sync", { text: "hi" });
    expect(res.status).toBe(500);
  });
});

describe("POST /studio/projects/:project/sync", () => {
  function studioSync(fetch: TestFetch, project: string, body: unknown): Promise<Response> {
    return fetch(`/studio/projects/${project}/sync`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(body),
    });
  }

  test("runs a turn against the project's published agent", async () => {
    const runSyncTurn = vi.fn(async () => ({ transcript: "hi", reply: "from studio" }));
    const { fetch } = await createSyncOrchestrator(createFakeSandbox(runSyncTurn));
    const res = await studioSync(fetch, "proj", { text: "hi" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ transcript: "hi", reply: "from studio" });
  });

  test("requires auth", async () => {
    const { fetch } = await createSyncOrchestrator(createFakeSandbox());
    const res = await postSync(fetch, "/studio/projects/proj/sync", { text: "hi" });
    expect(res.status).toBe(401);
  });

  test("unknown project answers 404", async () => {
    const { fetch } = await createSyncOrchestrator(createFakeSandbox());
    const res = await studioSync(fetch, "nope", { text: "hi" });
    expect(res.status).toBe(404);
  });

  test("unpublished project answers 409", async () => {
    const { fetch } = await createSyncOrchestrator(createFakeSandbox());
    const workspaces = createMemoryWorkspaceStore();
    // A fresh orchestrator whose workspace has no deployedSlug.
    const { createMemoryVector } = await import("@alexkroman1/aai/runtime");
    await createWorkspace(workspaces, studioScope("key1"), "draft", { files: {} });
    const { app } = createOrchestrator({
      slots: createSlotCache(),
      store: createTestStore(),
      workspaces,
      chats: createMemoryChatStore(),
      defaultVector: (slug) => createMemoryVector({ namespace: slug }),
    });
    const res = await app.request("/studio/projects/draft/sync", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ text: "hi" }),
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain("published");
    void fetch;
  });

  test("another key's project is invisible (scope isolation)", async () => {
    const { fetch } = await createSyncOrchestrator(createFakeSandbox());
    const res = await fetch("/studio/projects/proj/sync", {
      method: "POST",
      headers: authHeaders("other-key"),
      body: JSON.stringify({ text: "hi" }),
    });
    expect(res.status).toBe(404);
  });
});
