// Copyright 2026 the AAI authors. MIT license.

import { captureLogs, createRecordingSql } from "aai-server/test-utils";
import { describe, expect, test } from "vitest";
import {
  createMemoryPreviewQueue,
  createPgPreviewQueue,
  PREVIEW_JOB_VISIBILITY_MS,
  PREVIEW_QUEUE,
} from "./studio-preview-queue.ts";
import { previewQueueConformance } from "./studio-store-conformance.ts";

const JOB = {
  scope: "scope",
  project: "contact-form-x7k2mq",
  serverUrl: "https://platform.example",
};

// ── The CONTRACT, over the arm that runs everywhere ─────────────────────────
//
// One case list in `studio-store-conformance.ts`, shared with the stack arm in
// `aai-server/store-conformance.scenario.test.ts`. Unconditional here, so the
// module stays covered on every machine.

describe("PreviewQueue conformance: memory", () => {
  previewQueueConformance(() => createMemoryPreviewQueue());
});

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
  // Expected "unreadable payload" warnings, kept out of the output via the log
  // seam rather than a console spy.
  captureLogs();

  function fakeSql() {
    let rows: Record<string, unknown>[] = [];
    const { sql, calls } = createRecordingSql((query) => (query.includes("pgmq.read") ? rows : []));
    const setRows = (next: Record<string, unknown>[]): void => {
      rows = next;
    };
    return { sql, calls, setRows };
  }

  /**
   * The extension and the queue are declared in supabase/migrations. A lazy
   * `pgmq.create` here would create the queue under whatever connection first
   * noticed, and hide a missed migration.
   */
  test("issues no DDL — the extension and queue come from migrations", async () => {
    const { sql, calls } = fakeSql();
    const queue = createPgPreviewQueue(sql);
    await queue.enqueue(JOB);
    await queue.enqueue(JOB);
    expect(calls.filter((c) => /^\s*(create|do)\b/i.test(c.query))).toEqual([]);
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
   * The shape production actually stores. Binding the job as JSON TEXT with a
   * `::jsonb` cast — what every platform store does — lands a jsonb *string*
   * rather than an object (`jsonb_typeof` = `string` for every jsonb column
   * on the platform), so the driver reads it back as a string. Treating that
   * as unreadable archived every preview job on its first claim, which reads
   * as "previews silently stopped deploying".
   *
   * Its siblings all carry this tolerance and say so — see `parseDoc` in
   * aai-server/workspace-store.ts and the notes in agent-store.ts /
   * chat-store.ts. The memory queue hands back the original object, so this
   * is the one branch dev and tests never exercise.
   */
  test("reads a job back when the driver returns jsonb as a string", async () => {
    const { sql, setRows } = fakeSql();
    const queue = createPgPreviewQueue(sql);
    setRows([{ msg_id: 9n, read_ct: 1, message: JSON.stringify(JOB) }]);
    expect(await queue.claim(5)).toEqual([{ id: "9", job: JOB, attempts: 1 }]);
  });

  /** A string that is not JSON at all is still unreadable, not a crash. */
  test("archives a string payload that is not JSON", async () => {
    const { sql, calls, setRows } = fakeSql();
    const queue = createPgPreviewQueue(sql);
    setRows([{ msg_id: 8n, read_ct: 1, message: "not json" }]);
    expect(await queue.claim(5)).toEqual([]);
    expect(calls.find((c) => c.query.includes("pgmq.archive"))?.params).toEqual([
      PREVIEW_QUEUE,
      "8",
    ]);
  });

  /**
   * A payload written by a different shape must not cost a redelivery every
   * visibility timeout forever.
   */
  test("archives an unreadable payload instead of redelivering it", async () => {
    const { sql, calls, setRows } = fakeSql();
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
