// Copyright 2026 the AAI authors. MIT license.
/**
 * The loopback server the upload-route specs run against.
 *
 * Shared by `workflow/api/uploads.test.ts` (the whole-file writes and the reads) and
 * `workflow/api/uploads-parts.test.ts` (the `/parts` pair), so the two halves drive
 * one harness and cannot disagree about what a store does.
 *
 * The store is the REAL one over in-memory rows and objects (`memoryStore`), not a
 * route-shaped fake: a fake that accepted what production refuses would let a route's
 * 4xx be tested against a path production does not take.
 */

import { createStubWorkflows } from "@alexkroman1/aai/testing";
import { omitUndefined } from "@alexkroman1/aai/utils";
import { onTestFinished } from "vitest";
import { silentLogger } from "../../_logger-test-utils.ts";
import { memoryStore } from "../../_upload-store-test-utils.ts";
import { createWorkflowApi } from "../api.ts";
import type { UploadStore } from "../uploads.ts";
import { listenLoopback } from "./_test-utils.ts";

/**
 * Mount the API on a real loopback server, closed when the calling test finishes.
 *
 * The engine is `createStubWorkflows()`, which rejects every call: these routes must
 * not touch it. Pass `uploads` to hold the store yourself (a direct-path spec seeds
 * the bucket through `memoryStore().blobs`); `"uploads" in opts` rather than a
 * default, so an explicit `undefined` reaches the "no store" branch.
 */
export async function serve(
  opts: { uploads?: UploadStore | undefined; directParts?: boolean } = {},
): Promise<string> {
  const uploads = "uploads" in opts ? opts.uploads : memoryStore().store;
  const workflows = createStubWorkflows();
  const api = createWorkflowApi({
    engine: () => workflows,
    uploads,
    logger: silentLogger,
    ...omitUndefined({ directParts: opts.directParts }),
  });
  const server = await listenLoopback(api);
  onTestFinished(server.close);
  return server.url;
}

/** What `POST /workflows/uploads` answers with, as a spec reads it. */
type Stored = { id: string; name: string; type: string; size: number; url: string };

/** Store one file and answer with what the route said about it. */
export async function upload(
  base: string,
  bytes: Uint8Array,
  init: { name?: string; type?: string } = {},
): Promise<Stored> {
  const res = await fetch(`${base}/workflows/uploads?name=${encodeURIComponent(init.name ?? "")}`, {
    method: "POST",
    headers: { "Content-Type": init.type ?? "application/octet-stream" },
    body: bytes,
  });
  // Thrown rather than asserted: a failure here is setup that did not happen, not a
  // claim that did not hold.
  if (res.status !== 201) throw new Error(`upload failed: HTTP ${res.status}`);
  return (await res.json()) as Stored;
}
