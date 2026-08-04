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
import { mutateWorkspace, studioScope } from "./studio-workspace.ts";

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
