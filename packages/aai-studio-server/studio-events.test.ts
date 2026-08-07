// Copyright 2026 the AAI authors. MIT license.
/**
 * The studio's SSE event routes — the server-side pushes that replaced
 * client polling. Fed by the platform change streams — here the memory
 * event bus paired with the harness's stores, standing in for production's
 * Supabase Realtime postgres_changes:
 *
 * - `GET /studio/projects/:project/events` — project state (`project`
 *   frames) + settled chat history (`chat` frames)
 * - `GET /studio/events` — the caller's project list (`projects` frames)
 */

import { authHeaders, type TestFetch } from "aai-server/test-utils";
import { expect, test } from "vitest";
import { createTestCombined } from "./_test-combined.ts";
import { createWorkspace, mutateWorkspace, studioScope } from "./studio-workspace.ts";

/** Parse the payloads of `event` out of complete frames in `buffer`. */
function payloadsOf(buffer: string, event: string): unknown[] {
  const payloads: unknown[] = [];
  const matcher = new RegExp(`^event: *${event}$`, "m");
  for (const raw of buffer.split("\n\n")) {
    if (!matcher.test(raw)) continue;
    const data = raw
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("");
    if (data) payloads.push(JSON.parse(data));
  }
  return payloads;
}

/** Read SSE frames off a streamed response until `count` frames of `event`. */
async function readFrames(res: Response, event: string, count: number): Promise<unknown[]> {
  const body = res.body;
  if (!body) throw new Error("No response body");
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  const deadline = Date.now() + 5000;
  while (payloadsOf(buffer, event).length < count) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for SSE frames");
    const { done, value } = await reader.read();
    if (done) break;
    buffer += value;
  }
  await reader.cancel().catch(() => undefined);
  return payloadsOf(buffer, event);
}

function openEvents(fetch: TestFetch, project: string, key = "key1"): Promise<Response> {
  return fetch(`/studio/projects/${project}/events`, { headers: authHeaders(key) });
}

async function setupProject() {
  const harness = await createTestCombined();
  const res = await harness.fetch("/studio/projects", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ name: "proj" }),
  });
  if (res.status !== 201) throw new Error(`Project create failed (${res.status})`);
  return harness;
}

test("requires auth", async () => {
  const { fetch } = await setupProject();
  expect((await fetch("/studio/projects/proj/events")).status).toBe(401);
  expect((await fetch("/studio/events")).status).toBe(401);
});

test("404 for a project the caller does not have", async () => {
  const { fetch } = await setupProject();
  expect((await openEvents(fetch, "ghost")).status).toBe(404);
  // Another caller's key scopes to a different namespace — same 404.
  expect((await openEvents(fetch, "proj", "other-key")).status).toBe(404);
});

test("the first event is the project's current state", async () => {
  const { fetch } = await setupProject();
  const res = await openEvents(fetch, "proj");
  expect(res.status).toBe(200);
  expect(res.headers.get("Content-Type")).toContain("text/event-stream");
  const [initial] = await readFrames(res, "project", 1);
  // A fresh project: empty starter files, no preview yet (stale by design).
  expect(initial).toMatchObject({ files: {}, previewStale: true });
});

test("a workspace write pushes the updated project state", async () => {
  const harness = await setupProject();
  const res = await openEvents(harness.fetch, "proj");
  const scope = studioScope("key1");

  // A preview deploy finishing elsewhere stamps the workspace row; the
  // change stream must push the new preview state without any client poll.
  const framesP = readFrames(res, "project", 2);
  await mutateWorkspace(harness.workspaces, scope, "proj", (current) => ({
    ...current,
    previewSlug: "proj-preview",
    previewHash: current.hash ?? "",
  }));

  const [, updated] = (await framesP) as Record<string, unknown>[];
  expect(updated).toMatchObject({
    previewSlug: "proj-preview",
    previewStale: false,
  });
  expect(updated?.previewVersion).toBeTruthy();
});

/**
 * The route must SUBSCRIBE before it READS, and its initial frame must be
 * produced by a read taken after that subscribe.
 *
 * Read-then-subscribe loses every change that lands in the gap, permanently:
 * these streams are the only push mechanism left (the client's polling loop is
 * gone), so the pane keeps showing the pre-change snapshot until something
 * else happens to touch the row. The gap is microtask-sized in this harness
 * and much wider in production — a real socket write on one side and a
 * Supabase Realtime channel JOIN round trip on the other. Opening a project at
 * the moment its preview deploy stamps the workspace is the collision, and it
 * strands the Preview pane on "Updating preview…" with a finished preview
 * behind it.
 *
 * Modelled by committing a change from INSIDE the subscribe and making the
 * store's reads wait for it: whatever the initial frame reports, it either was
 * read after the subscribe or it was not. Under read-then-subscribe the read
 * happens before the subscribe exists, so it reports the pre-change row and
 * nothing ever corrects it.
 */
test("a change landing between subscribe and the first read still reaches the client", async () => {
  const base = await createTestCombined();
  let raced: Promise<unknown> | undefined;
  const harness = await createTestCombined({
    // Reads made after the injected change has been committed must observe it.
    workspaces: {
      ...base.workspaces,
      get: async (s, p) => {
        await raced;
        return base.workspaces.get(s, p);
      },
    },
    chats: base.chats,
    events: {
      ...base.events,
      watchWorkspace: (s, p, cb) => {
        // A preview deploy stamping the row exactly as the stream subscribes.
        raced ??= mutateWorkspace(base.workspaces, s, p, (current) => ({
          ...current,
          previewSlug: "proj-preview",
          previewHash: current.hash ?? "",
        }));
        return base.events.watchWorkspace(s, p, cb);
      },
    },
  });
  await harness.fetch("/studio/projects", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ name: "proj" }),
  });

  const stream = await openEvents(harness.fetch, "proj");
  const [initial] = (await readFrames(stream, "project", 1)) as Record<string, unknown>[];
  expect(initial).toMatchObject({ previewSlug: "proj-preview", previewStale: false });
});

test("the project list stream subscribes before its first read", async () => {
  const base = await createTestCombined();
  let raced: Promise<unknown> | undefined;
  const harness = await createTestCombined({
    workspaces: {
      ...base.workspaces,
      list: async (s) => {
        await raced;
        return base.workspaces.list(s);
      },
    },
    chats: base.chats,
    events: {
      ...base.events,
      watchScopeProjects: (s, cb) => {
        // A project created on another device as this stream subscribes.
        raced ??= createWorkspace(base.workspaces, s, "raced", { files: {} });
        return base.events.watchScopeProjects(s, cb);
      },
    },
  });
  const res = await harness.fetch("/studio/events", { headers: authHeaders() });
  const [initial] = (await readFrames(res, "projects", 1)) as string[][];
  expect(initial).toEqual(["raced"]);
});

test("a settled chat turn pushes the conversation as a chat frame", async () => {
  const harness = await setupProject();
  const res = await openEvents(harness.fetch, "proj");
  const scope = studioScope("key1");

  const framesP = readFrames(res, "chat", 1);
  // The guest's end-of-turn studio/persist-chat writes the chats store.
  const messages = [{ id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] }];
  await harness.chats.putChat(scope, "proj", messages);

  const [chat] = await framesP;
  expect(chat).toEqual(messages);
});

test("GET /studio/events streams the project list, updated on create and delete", async () => {
  const harness = await setupProject();
  const res = await harness.fetch("/studio/events", { headers: authHeaders() });
  expect(res.status).toBe(200);

  const framesP = readFrames(res, "projects", 2);
  // A project created on another device...
  const created = await harness.fetch("/studio/projects", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ name: "second" }),
  });
  expect(created.status).toBe(201);

  const frames = (await framesP) as string[][];
  expect(frames[0]).toEqual(["proj"]);
  expect(frames.at(-1)).toEqual(["proj", "second"]);
});

test("another caller's projects never leak into the list stream", async () => {
  const harness = await setupProject();
  const res = await harness.fetch("/studio/events", { headers: authHeaders("other-key") });
  const [initial] = await readFrames(res, "projects", 1);
  expect(initial).toEqual([]);
});

/**
 * Tabs on one project cost a FIXED number of reads per change, not one each.
 *
 * Every frame re-reads the row (events are signals), and a `project` frame's
 * row is the whole workspace document — file map included. Per stream that is
 * correct; per TAB it is pure duplication, and tabs are what multiply: a
 * laptop and a phone on the same project, two windows side by side, a reload
 * racing its predecessor's still-open stream. A change burst multiplies it
 * again.
 *
 * The fixed number is TWO, and the second one is the coalescing runner's
 * correctness rule rather than a miss: a run that started before a trigger
 * cannot vouch for that trigger's change, and the runner cannot tell that
 * these triggers all came from the one event dispatch it is already reading
 * for. So the first watcher's read runs, every other watcher coalesces into a
 * single trailing read, and the total stays 2 whether 2 tabs are open or 20.
 * Asserting the constant with THREE streams is what makes that a claim about
 * growth rather than a coincidence of the two-stream case.
 */
test("streams on one project share a fixed number of reads per change", async () => {
  const base = await createTestCombined();
  let reads = 0;
  const harness = await createTestCombined({
    workspaces: {
      ...base.workspaces,
      get: (s, p) => {
        reads += 1;
        return base.workspaces.get(s, p);
      },
    },
    chats: base.chats,
    events: base.events,
  });
  await harness.fetch("/studio/projects", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ name: "proj" }),
  });

  // Drain both initial frames first, so no read is in flight when the change
  // lands — otherwise the count would depend on which reads happened to
  // overlap, and the assertion below would be about scheduling, not sharing.
  const streams = await Promise.all([
    openEvents(harness.fetch, "proj"),
    openEvents(harness.fetch, "proj"),
    openEvents(harness.fetch, "proj"),
  ]);
  const pending = streams.map((res) => readFrames(res, "project", 2));
  await new Promise((resolve) => setTimeout(resolve, 50));

  reads = 0;
  // Written straight to the underlying store — so `reads` counts what the
  // STREAMS did, not the write's own read-modify-write.
  await mutateWorkspace(base.workspaces, studioScope("key1"), "proj", (current) => ({
    ...current,
    previewSlug: "proj-preview",
  }));

  // Every stream sees the change...
  for (const frames of await Promise.all(pending)) {
    expect(frames.at(-1)).toMatchObject({ previewSlug: "proj-preview" });
  }
  // ...off two queries between the three of them, where they used to make
  // three — one each.
  expect(reads).toBe(2);
});
