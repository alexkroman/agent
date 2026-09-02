// Copyright 2026 the AAI authors. MIT license.
/**
 * Shared scaffolding for the workflow HTTP API suites.
 *
 * `workflow-api.test.ts` reached 697 lines against the 700-line test cap, so
 * the synchronous-mode block moved to `workflow-api-sync.test.ts`. Both drive
 * the API the same way — a real loopback `node:http` server, a spying
 * `WorkflowClient` as the engine — and a second copy of that harness is the
 * duplicated-fixture failure the root guide records: the copies diverge, and
 * the one that rots is the one nobody is looking at.
 *
 * No leading underscore, because `*-test-utils.ts` is what the shared coverage
 * excludes and `tsconfig.build.json` both key on; nothing outside this package
 * imports it.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { rejectingWorkflows, requestPath } from "@alexkroman1/aai/host-internal";
import { omitUndefined } from "@alexkroman1/aai/utils";
import type { WorkflowClient, WorkflowRunSnapshot } from "@alexkroman1/aai/workflow-api";
import { vi } from "vitest";
import { makeLogger } from "./_test-utils.ts";
import { createWorkflowApi } from "./workflow-api.ts";
import type { UploadStore } from "./workflow-uploads.ts";

/** One run snapshot, overridable field by field. */
export function run(over: Partial<WorkflowRunSnapshot> = {}): WorkflowRunSnapshot {
  return {
    runId: "wrun_1",
    workflow: "digest",
    createdAt: 1_700_000_000_000,
    status: "running",
    ...over,
  } as WorkflowRunSnapshot;
}

/**
 * A `ctx.workflows` whose every method is a spy, so a route's call is visible.
 *
 * The `rejectingWorkflows` base is load-bearing rather than tidy: this used to be
 * a literal cast with `as WorkflowClient`, and a cast keeps compiling when the
 * client GAINS a method — leaving it `undefined` here, so the route exercising it
 * fails on a `TypeError` that names nothing, or (worse) no test reaches it at all
 * and the route ships uncovered.
 */
export function fakeClient(over: Partial<WorkflowClient> = {}): WorkflowClient {
  return {
    ...rejectingWorkflows("not stubbed in this test"),
    start: vi.fn(async () => "wrun_1"),
    get: vi.fn(async () => run()),
    find: vi.fn(async () => [run({ key: "caller-1" })]),
    recent: vi.fn(async () => [run()]),
    cancel: vi.fn(async () => true),
    wakeUp: vi.fn(async () => 1),
    stream: vi.fn(async () => chunkStream([{ step: 1 }, "halfway"])),
    streamTail: vi.fn(async () => 1),
    listing: vi.fn(() => [{ name: "digest", description: "Research a topic" }]),
    ...over,
  };
}

/** A run's written stream, as `ctx.workflows.stream` resolves one. */
export function chunkStream(chunks: readonly unknown[]): ReadableStream<unknown> {
  return new ReadableStream<unknown>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

export type Harness = {
  url: string;
  /**
   * The logger the API was built with — FRESH per server, never a module
   * singleton. `restoreMocks` restores `vi.spyOn` mocks and clears neither the
   * history nor the implementation of a plain `vi.fn()`, so a shared one
   * accumulates across the whole file: "the infrastructure cause reaches the
   * LOG" was satisfied by the identical call the preceding test had made, and
   * deleting the log line left it green.
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
  const server = http.createServer((req, res) => {
    opts.onRequest?.();
    const url = requestPath(req.url);
    if (api(req, res, url, req.method ?? "GET")) return;
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    logger,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
