// Copyright 2026 the AAI authors. MIT license.
/**
 * Shared scaffolding for the workflow HTTP API suites: a real loopback
 * `node:http` server with a spying `WorkflowClient` as the engine.
 */

import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { requestPath } from "@alexkroman1/aai/internal";
import { createRunSnapshot, createStubWorkflows } from "@alexkroman1/aai/testing";
import { omitUndefined } from "@alexkroman1/aai/utils";
import type { WorkflowClient } from "@alexkroman1/aai/workflow-api";
import { vi } from "vitest";
import { makeLogger } from "../../_logger-test-utils.ts";
import { createWorkflowApi } from "../api.ts";
import type { UploadStore } from "../uploads.ts";

/**
 * A `ctx.workflows` whose every route-facing method is a spy, so a route's call is
 * visible. Built on `createStubWorkflows`, so a method the client GAINS rejects by
 * name here rather than arriving `undefined`.
 */
export function fakeClient(over: Partial<WorkflowClient> = {}): WorkflowClient {
  return createStubWorkflows({
    start: vi.fn(async () => "wrun_1"),
    get: vi.fn(async () => createRunSnapshot()),
    find: vi.fn(async () => [createRunSnapshot({ key: "caller-1" })]),
    recent: vi.fn(async () => [createRunSnapshot()]),
    cancel: vi.fn(async () => true),
    wakeUp: vi.fn(async () => 1),
    stream: vi.fn(async () => ReadableStream.from<unknown>([{ step: 1 }, "halfway"])),
    streamTail: vi.fn(async () => 1),
    listing: vi.fn(() => [{ name: "digest", description: "Research a topic" }]),
    ...over,
  });
}

export type Harness = {
  url: string;
  /**
   * The logger the API was built with — FRESH per server, never a module
   * singleton, so a log assertion can only be satisfied by this test's call.
   */
  logger: ReturnType<typeof makeLogger>;
  close: () => Promise<void>;
};

/** Mount the API on a real loopback server, so the tests speak HTTP. */
export async function serve(opts: {
  engine: () => WorkflowClient | undefined;
  token?: string;
  uploads?: UploadStore;
  /**
   * Called SYNCHRONOUSLY as each request arrives, before the route runs.
   *
   * The one thing a spec about CONCURRENT requests cannot get any other way. A
   * `fetch` resolves when its response does, so "all four have arrived" is not
   * observable from the client side — and over loopback against a fake that
   * resolves in a microtask, four requests issued together are still served one
   * after another, each finishing before the next is parsed. A spec that
   * needs them to overlap holds the first one's read open until this has
   * counted the rest, which is deterministic where a delay is a guess.
   */
  onRequest?: () => void;
}): Promise<Harness> {
  const logger = makeLogger();
  const api = createWorkflowApi({
    engine: opts.engine,
    ...omitUndefined({ token: opts.token, uploads: opts.uploads }),
    logger,
  });
  return { ...(await listenLoopback(api, opts.onRequest)), logger };
}

/**
 * Serve `api` on a real loopback port — anything it does not claim is a 404 —
 * and answer the base URL plus a close. Shared with the upload suites'
 * harness (`_uploads-test-utils.ts`), so the two drive the API identically.
 */
export async function listenLoopback(
  api: ReturnType<typeof createWorkflowApi>,
  onRequest?: () => void,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    onRequest?.();
    const url = requestPath(req.url);
    if (api(req, res, url, req.method ?? "GET")) return;
    res.writeHead(404).end();
  });
  await once(server.listen(0, "127.0.0.1"), "listening");
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
