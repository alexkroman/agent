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

import { MAX_LIVE_STREAMS_PER_SCOPE } from "aai-server/constants";
import { reservedLiveStreams, reserveLiveStream, resetLiveStreams } from "aai-server/live-streams";
import { authHeaders, type TestFetch } from "aai-server/test-utils";
import { afterEach, expect, test, vi } from "vitest";
import { createTestCombined } from "./_test-combined.ts";
import {
  createWorkspace,
  getWorkspace,
  mutateWorkspace,
  stampWorkspaceMeta,
  studioScope,
} from "./studio-workspace.ts";

// The per-scope stream reservations are PROCESS-global, like the shutdown
// registry they live beside — so a stream this file leaves open would spend a
// slot every later test in the file has to share. Reset rather than relied upon:
// the cap is 50 and this suite opens well under it, which is exactly the kind of
// margin that quietly disappears as tests are added.
afterEach(() => {
  resetLiveStreams();
});

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

/**
 * An INCREMENTAL reader over one streamed response: `take(event, n)` resolves
 * once `n` frames of `event` have arrived, and the buffer survives the call, so
 * a test can await the initial frame, act, and then await the next one. The
 * one-shot `readFrames` below cancels the reader, which is why the read-sharing
 * test could not synchronize on its own initial frames and reached for a
 * wall-clock sleep instead.
 */
function frameReader(res: Response) {
  const body = res.body;
  if (!body) throw new Error("No response body");
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  return {
    async take(event: string, count: number): Promise<unknown[]> {
      const deadline = Date.now() + 5000;
      while (payloadsOf(buffer, event).length < count) {
        if (Date.now() > deadline) throw new Error("Timed out waiting for SSE frames");
        const { done, value } = await reader.read();
        if (done) break;
        buffer += value;
      }
      return payloadsOf(buffer, event);
    },
    close: () => reader.cancel().catch(() => undefined),
  };
}

/** Read SSE frames off a streamed response until `count` frames of `event`. */
async function readFrames(res: Response, event: string, count: number): Promise<unknown[]> {
  const reader = frameReader(res);
  const frames = await reader.take(event, count);
  await reader.close();
  return frames;
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
  const [initial] = (await readFrames(res, "project", 1)) as Record<string, unknown>[];
  // A fresh project: empty starter files, no preview yet (stale by design).
  //
  // `files` is asserted with `toEqual`, not folded into the `toMatchObject`:
  // an EMPTY expected object matches any object, so `toMatchObject({files:{}})`
  // said nothing at all about the file map and a populated (or wrong) one in
  // the first frame passed on `previewStale` alone.
  expect(initial?.files).toEqual({});
  expect(initial).toMatchObject({ previewStale: true, kind: "agent" });
});

test("a workspace write pushes the updated project state", async () => {
  const harness = await setupProject();
  const res = await openEvents(harness.fetch, "proj");
  const scope = studioScope("key1");

  // A preview deploy finishing elsewhere stamps the workspace row; the
  // change stream must push the new preview state without any client poll.
  //
  // Through `stampWorkspaceMeta` deliberately — the real writer. Modelled as
  // a `mutateWorkspace` read-modify-write, this passed while the dev-mode
  // event decorator emitted on `put` and `delete` but not on `patch`, so
  // under `pnpm dev:aai-server` every landed preview was silent and the pane
  // sat on its "Starting your preview" screen until a reload.
  const framesP = readFrames(res, "project", 2);
  const stored = await getWorkspace(harness.workspaces, scope, "proj");
  await stampWorkspaceMeta(harness.workspaces, scope, "proj", {
    previewSlug: "proj-preview",
    previewHash: stored?.hash ?? "",
  });

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

  // Drain every initial frame first, so no read is in flight when the change
  // lands — otherwise the count would depend on which reads happened to
  // overlap, and the assertion below would be about scheduling, not sharing.
  //
  // Awaited as the OBSERVABLE event, never as a `sleep(50)`: the count is this
  // test's whole subject, and a wall-clock gate on a loaded box resets the
  // counter mid-flight and charges a straggling initial read to the change.
  const streams = await Promise.all([
    openEvents(harness.fetch, "proj"),
    openEvents(harness.fetch, "proj"),
    openEvents(harness.fetch, "proj"),
  ]);
  const readers = streams.map(frameReader);
  await Promise.all(readers.map((reader) => reader.take("project", 1)));

  reads = 0;
  // Written straight to the underlying store — so `reads` counts what the
  // STREAMS did, not the write's own read-modify-write.
  await mutateWorkspace(base.workspaces, studioScope("key1"), "proj", (current) => ({
    ...current,
    previewSlug: "proj-preview",
  }));

  // Every stream sees the change...
  for (const reader of readers) {
    expect((await reader.take("project", 2)).at(-1)).toMatchObject({
      previewSlug: "proj-preview",
    });
  }
  // ...off two queries between the three of them, where they used to make
  // three — one each.
  expect(reads).toBe(2);
  await Promise.all(readers.map((reader) => reader.close()));
});

test("a scope at its stream cap is refused with 429, not served a stream", async () => {
  const { fetch } = await setupProject();
  const scope = studioScope("key1");
  // Fill the cap directly — opening 50 real streams would measure the test
  // harness rather than the route.
  for (let i = 0; i < MAX_LIVE_STREAMS_PER_SCOPE; i++) reserveLiveStream(scope);

  // Both routes, because each reserves its own slot and a cap enforced on one
  // of them is not a cap.
  const project = await openEvents(fetch, "proj");
  expect(project.status).toBe(429);
  expect(project.headers.get("Content-Type")).toContain("application/json");
  const list = await fetch("/studio/events", { headers: authHeaders("key1") });
  expect(list.status).toBe(429);

  // Another caller is unaffected — one abusive scope must not close the studio.
  expect((await fetch("/studio/events", { headers: authHeaders("key2") })).status).toBe(200);
});

test("closing a stream gives its slot back", async () => {
  const { fetch } = await setupProject();
  const scope = studioScope("key1");

  const res = await openEvents(fetch, "proj");
  const reader = frameReader(res);
  await reader.take("project", 1);
  expect(reservedLiveStreams(scope)).toBe(1);

  await reader.close();

  // The anti-leak property, and the reason the release sits in a `finally`: a
  // slot that outlives its stream is not a slow leak, it is one scope
  // permanently answered 429 until the replica restarts.
  await vi.waitFor(() => expect(reservedLiveStreams(scope)).toBe(0));
});
