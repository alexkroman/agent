// Copyright 2026 the AAI authors. MIT license.
/**
 * The workflow HTTP API's SYNCHRONOUS mode (`?wait=`).
 *
 * Split from `workflow-api.test.ts`, which sat at 697 lines against the 700-line
 * test cap, on the seam the file already had — the `describe("wait")` block. The
 * shared harness is in `workflow-api-test-utils.ts`.
 *
 * The property under test is the one a caller branches on: a wait that PRODUCED
 * a finished run is a 200, and a wait that ran out is a 202 carrying the run id
 * — never an error, and never a cancel. `workflow-api-wait.test.ts` owns the
 * loop itself; these assert what the routes do with its answer.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { fakeClient, type Harness, run, serve } from "./workflow-api-test-utils.ts";

let harness: Harness | undefined;

beforeEach(() => {
  harness = undefined;
});

afterEach(async () => {
  await harness?.close();
});

describe("wait", () => {
  /** A `get` that answers `running` until the nth read, then `completed`. */
  function settlesOnRead(nth: number) {
    let reads = 0;
    return vi.fn(async () => {
      reads += 1;
      return reads >= nth ? run({ status: "completed", output: 7 }) : run({ status: "running" });
    });
  }

  test("POST answers 200 with the finished run", async () => {
    const engine = fakeClient({ start: vi.fn(async () => "wrun_9"), get: settlesOnRead(2) });
    harness = await serve({ engine: () => engine });

    const res = await fetch(`${harness.url}/workflows/runs`, {
      method: "POST",
      body: JSON.stringify({ workflow: "digest", wait: 5000 }),
    });

    expect(res.status).toBe(200);
    // `run` rides ALONGSIDE `runId`, so a caller that only reads the id behaves
    // the same whether or not it asked to wait.
    expect(await res.json()).toEqual({
      runId: "wrun_9",
      run: expect.objectContaining({ status: "completed", output: 7 }),
    });
  });

  test("POST with no wait still answers 202 and the id alone", async () => {
    const get = vi.fn(async () => run({ status: "running" }));
    harness = await serve({ engine: () => fakeClient({ get }) });

    const res = await fetch(`${harness.url}/workflows/runs`, {
      method: "POST",
      body: JSON.stringify({ workflow: "digest" }),
    });

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ runId: "wrun_1" });
    // The asynchronous path must not read the run at all — that read is what
    // waiting IS, and paying for it unasked would make every start slower.
    expect(get).not.toHaveBeenCalled();
  });

  test("a wait that runs out is a 202 carrying the running run, not an error", async () => {
    const engine = fakeClient({
      start: vi.fn(async () => "wrun_9"),
      get: vi.fn(async () => run({ status: "running" })),
    });
    harness = await serve({ engine: () => engine });

    const res = await fetch(`${harness.url}/workflows/runs`, {
      method: "POST",
      body: JSON.stringify({ workflow: "digest", wait: 1 }),
    });

    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ runId: "wrun_9", run: { status: "running" } });
    // The run is real and the caller holds its id; nothing was cancelled.
    expect(engine.cancel).not.toHaveBeenCalled();
  });

  test("GET ?wait= holds the read open until the run settles", async () => {
    const get = settlesOnRead(3);
    harness = await serve({ engine: () => fakeClient({ get }) });

    const res = await fetch(`${harness.url}/workflows/runs/wrun_1?wait=5000`);

    expect(res.status).toBe(200);
    // The BODY is a snapshot either way, so waiting is invisible to a parser.
    expect(await res.json()).toMatchObject({ status: "completed" });
    expect(get.mock.calls.length).toBeGreaterThan(1);
  });

  test("GET with no wait reads once", async () => {
    const get = vi.fn(async () => run({ status: "running" }));
    harness = await serve({ engine: () => fakeClient({ get }) });

    const res = await fetch(`${harness.url}/workflows/runs/wrun_1`);

    expect(res.status).toBe(200);
    expect(get).toHaveBeenCalledTimes(1);
  });

  test("a waited read of an unknown run 404s without spending the budget", async () => {
    // A run the agent does not know will not start being known.
    const get = vi.fn(async () => undefined);
    harness = await serve({ engine: () => fakeClient({ get }) });

    const started = Date.now();
    const res = await fetch(`${harness.url}/workflows/runs/wrun_gone?wait=30000`);

    expect(res.status).toBe(404);
    expect(get).toHaveBeenCalledTimes(1);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});
