// Copyright 2026 the AAI authors. MIT license.
/**
 * The project events SSE route (`GET /studio/projects/:project/events`):
 * the server-side push that replaced the client's preview polling loop.
 * Fed by the workspace row's change stream — here the memory event bus
 * paired with the harness's workspace store, standing in for production's
 * Supabase Realtime postgres_changes.
 */

import { authHeaders, type TestFetch } from "aai-server/test-utils";
import { expect, test } from "vitest";
import { createTestCombined } from "./_test-combined.ts";
import { mutateWorkspace, studioScope } from "./studio-workspace.ts";

/** Parse the `project` payloads out of complete frames in `buffer`. */
function projectPayloads(buffer: string): Record<string, unknown>[] {
  const payloads: Record<string, unknown>[] = [];
  for (const raw of buffer.split("\n\n")) {
    if (!/^event: *project$/m.test(raw)) continue;
    const data = raw
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("");
    if (data) payloads.push(JSON.parse(data) as Record<string, unknown>);
  }
  return payloads;
}

/** Read SSE frames off a streamed response until `count` project frames. */
async function readProjectFrames(res: Response, count: number): Promise<Record<string, unknown>[]> {
  const body = res.body;
  if (!body) throw new Error("No response body");
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  const deadline = Date.now() + 5000;
  while (projectPayloads(buffer).length < count) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for SSE frames");
    const { done, value } = await reader.read();
    if (done) break;
    buffer += value;
  }
  await reader.cancel().catch(() => undefined);
  return projectPayloads(buffer);
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
  const res = await fetch("/studio/projects/proj/events");
  expect(res.status).toBe(401);
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
  const [initial] = await readProjectFrames(res, 1);
  // A fresh project: empty starter files, no preview yet (stale by design).
  expect(initial).toMatchObject({ files: {}, previewStale: true });
});

test("a workspace write pushes the updated project state", async () => {
  const harness = await setupProject();
  const res = await openEvents(harness.fetch, "proj");
  const scope = studioScope("key1");

  // A preview deploy finishing elsewhere stamps the workspace row; the
  // change stream must push the new preview state without any client poll.
  const framesP = readProjectFrames(res, 2);
  await mutateWorkspace(harness.workspaces, scope, "proj", (current) => ({
    ...current,
    previewSlug: "proj-preview",
    previewHash: current.hash ?? "",
  }));

  const [, updated] = await framesP;
  expect(updated).toMatchObject({
    previewSlug: "proj-preview",
    previewStale: false,
  });
  expect(updated?.previewVersion).toBeTruthy();
});
