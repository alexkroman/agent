// Copyright 2026 the AAI authors. MIT license.

import type { SqlExec } from "aai-server/secret-store";
import { describe, expect, test, vi } from "vitest";
import {
  createMemoryPreviewQueue,
  createPgPreviewQueue,
  PREVIEW_JOB_VISIBILITY_MS,
  PREVIEW_QUEUE,
} from "./studio-preview-queue.ts";

const JOB = {
  scope: "scope",
  project: "contact-form-x7k2mq",
  serverUrl: "https://platform.example",
};

describe("createMemoryPreviewQueue", () => {
  test("claims an enqueued job once, then hides it for the visibility timeout", async () => {
    const clock = { now: 1000 };
    const queue = createMemoryPreviewQueue({ now: () => clock.now });
    await queue.enqueue(JOB);

    const first = await queue.claim(5);
    expect(first).toHaveLength(1);
    expect(first[0]?.job).toEqual(JOB);
    expect(first[0]?.attempts).toBe(1);

    // Still invisible: this is what stops two replicas deploying at once.
    expect(await queue.claim(5)).toEqual([]);

    // A replica that died mid-deploy consumed nothing — the job comes back.
    clock.now += PREVIEW_JOB_VISIBILITY_MS + 1;
    const redelivered = await queue.claim(5);
    expect(redelivered).toHaveLength(1);
    expect(redelivered[0]?.attempts).toBe(2);
  });

  test("an acked job never comes back", async () => {
    const clock = { now: 1000 };
    const queue = createMemoryPreviewQueue({ now: () => clock.now });
    await queue.enqueue(JOB);
    const [claimed] = await queue.claim(5);
    await queue.ack(claimed?.id ?? "");
    clock.now += PREVIEW_JOB_VISIBILITY_MS + 1;
    expect(await queue.claim(5)).toEqual([]);
  });

  test("an archived job leaves the queue but stays inspectable", async () => {
    const queue = createMemoryPreviewQueue();
    await queue.enqueue(JOB);
    const [claimed] = await queue.claim(5);
    await queue.archive(claimed?.id ?? "");
    expect(await queue.claim(5)).toEqual([]);
    expect(queue.archived.map((entry) => entry.job)).toEqual([JOB]);
  });

  test("respects the batch size", async () => {
    const queue = createMemoryPreviewQueue();
    await queue.enqueue(JOB);
    await queue.enqueue(JOB);
    await queue.enqueue(JOB);
    expect(await queue.claim(2)).toHaveLength(2);
  });
});

describe("createPgPreviewQueue", () => {
  function fakeSql() {
    const calls: { query: string; params?: unknown[] }[] = [];
    let rows: Record<string, unknown>[] = [];
    const sql: SqlExec = (query, params) => {
      calls.push({ query, ...(params && { params }) });
      return Promise.resolve(query.includes("pgmq.read") ? rows : []);
    };
    const setRows = (next: Record<string, unknown>[]): void => {
      rows = next;
    };
    return { sql, calls, setRows };
  }

  test("creates the extension and queue once, tolerating an existing queue", async () => {
    const { sql, calls } = fakeSql();
    const queue = createPgPreviewQueue(sql);
    await queue.enqueue(JOB);
    await queue.enqueue(JOB);

    expect(calls[0]?.query).toBe("create extension if not exists pgmq");
    // pgmq.create is not `if not exists`, so the duplicate has to be caught.
    expect(calls[1]?.query).toContain("when duplicate_table or duplicate_object then null");
    expect(calls[1]?.query).toContain(PREVIEW_QUEUE);
    // Memoized: the second enqueue does not re-run the DDL.
    expect(calls.filter((c) => c.query.includes("create extension"))).toHaveLength(1);
    expect(calls.filter((c) => c.query.includes("pgmq.send"))).toHaveLength(2);
  });

  test("sends the job as jsonb and reads it back with its delivery count", async () => {
    const { sql, calls, setRows } = fakeSql();
    const queue = createPgPreviewQueue(sql);
    await queue.enqueue({ ...JOB, userId: "user-1" });
    const send = calls.find((c) => c.query.includes("pgmq.send"));
    expect(send?.params?.[0]).toBe(PREVIEW_QUEUE);
    expect(JSON.parse(String(send?.params?.[1]))).toEqual({ ...JOB, userId: "user-1" });

    setRows([{ msg_id: 42n, read_ct: 3, message: { ...JOB, userId: "user-1" } }]);
    const claimed = await queue.claim(5);
    expect(claimed).toEqual([{ id: "42", job: { ...JOB, userId: "user-1" }, attempts: 3 }]);
    const read = calls.find((c) => c.query.includes("pgmq.read"));
    // Visibility timeout is passed in whole seconds, as pgmq expects.
    expect(read?.params?.[1]).toBe(PREVIEW_JOB_VISIBILITY_MS / 1000);
  });

  /**
   * A payload written by a different shape must not cost a redelivery every
   * visibility timeout forever.
   */
  test("archives an unreadable payload instead of redelivering it", async () => {
    const { sql, calls, setRows } = fakeSql();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const queue = createPgPreviewQueue(sql);
    setRows([{ msg_id: 7n, read_ct: 1, message: { project: "no-scope" } }]);
    expect(await queue.claim(5)).toEqual([]);
    const archive = calls.find((c) => c.query.includes("pgmq.archive"));
    expect(archive?.params).toEqual([PREVIEW_QUEUE, "7"]);
  });

  test("acks by message id", async () => {
    const { sql, calls } = fakeSql();
    const queue = createPgPreviewQueue(sql);
    await queue.ack("99");
    const del = calls.find((c) => c.query.includes("pgmq.delete"));
    expect(del?.params).toEqual([PREVIEW_QUEUE, "99"]);
  });
});
