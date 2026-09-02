// Copyright 2026 the AAI authors. MIT license.
/**
 * `GET /workflows/runs`' `limit`, at the RUNTIME edge.
 *
 * The rest of this route is covered from `workflow-api.test.ts`, which drives the
 * whole surface through the same loopback harness. What is only visible here is
 * the one parameter a caller controls that decides how much WORK the answer is,
 * on a surface that is unauthenticated unless the operator sets
 * `AAI_WORKFLOW_API_TOKEN`.
 *
 * It used to check `Number.isFinite` and nothing else, so `?limit=2.5` and
 * `?limit=-5` were both forwarded — the negative one all the way to a platform
 * `LIMIT -1`, which comes back as a retryable 503 rather than the 400 it is. The
 * split these cases pin: a value that has no truthful reading is REFUSED, and a
 * value that is merely too large is clamped and SAID to be, because a page asking
 * for five hundred wants as many as it can have and a silent hundred is an answer
 * that looks complete.
 *
 * The platform half of the same bound is `aai-server/workflow-journal-handler.ts`,
 * and it is deliberately not this one: a guest is not trusted, so the ceiling has
 * to hold with this edge bypassed entirely.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { fakeClient, type Harness, run, serve } from "./workflow-api-test-utils.ts";
import { MAX_WORKFLOW_FIND_LIMIT } from "./workflow-keys.ts";

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

async function listRuns(query: string, over: Parameters<typeof fakeClient>[0] = {}) {
  harness = await serve({ engine: () => fakeClient(over) });
  const res = await fetch(`${harness.url}/workflows/runs?${query}`);
  return { res, body: (await res.json()) as Record<string, unknown> };
}

describe("GET /runs — the `limit` a caller supplies", () => {
  test.each([
    ["negative", "-5"],
    ["zero", "0"],
    ["a non-integer", "2.5"],
    ["empty", ""],
  ])("refuses a limit that is %s", async (_label, limit) => {
    const recent = vi.fn(async () => [run()]);
    const { res } = await listRuns(`workflow=digest&limit=${limit}`, { recent });
    expect(res.status).toBe(400);
    // The point of refusing rather than coercing: nothing downstream is asked to
    // guess what `-5` or `2.5` of a page means.
    expect(recent).not.toHaveBeenCalled();
  });

  test("clamps a limit above the ceiling, and SAYS that it did", async () => {
    const recent = vi.fn(async () => [run()]);
    const { res, body } = await listRuns("workflow=digest&limit=100000", { recent });
    expect(res.status).toBe(200);
    expect(recent).toHaveBeenCalledWith("digest", { limit: MAX_WORKFLOW_FIND_LIMIT });
    // Visible in the REPLY, because a truncated page is otherwise indistinguishable
    // from a complete one — the caller asked for 100,000 and got at most 100.
    expect(body.truncatedTo).toBe(MAX_WORKFLOW_FIND_LIMIT);
  });

  test("serves the LARGEST legitimate limit unclamped and unannounced", async () => {
    // The bound has to be somewhere a real caller reaches, or nothing proves it
    // works: `MAX_WORKFLOW_FIND_LIMIT` is what `resolveFindLimit` hands the client
    // for any bigger ask, so this exact value is the busiest honest request.
    const recent = vi.fn(async () => [run()]);
    const { res, body } = await listRuns(`workflow=digest&limit=${MAX_WORKFLOW_FIND_LIMIT}`, {
      recent,
    });
    expect(res.status).toBe(200);
    expect(recent).toHaveBeenCalledWith("digest", { limit: MAX_WORKFLOW_FIND_LIMIT });
    expect(body).not.toHaveProperty("truncatedTo");
  });

  test("the keyed read is bounded by the same ceiling", async () => {
    // `find` and `recent` are one route and one clamp; a bound on half of it is
    // no bound at all.
    const find = vi.fn(async () => [run({ key: "caller-1" })]);
    const { res, body } = await listRuns("workflow=digest&key=caller-1&limit=999", { find });
    expect(res.status).toBe(200);
    expect(find).toHaveBeenCalledWith("digest", "caller-1", { limit: MAX_WORKFLOW_FIND_LIMIT });
    expect(body.truncatedTo).toBe(MAX_WORKFLOW_FIND_LIMIT);
  });

  test("no limit at all is left to the client's own default", async () => {
    // `DEFAULT_WORKFLOW_FIND_LIMIT` lives in `workflow-keys.ts` and is applied by
    // `resolveFindLimit`. Restating it here would be a second copy that can
    // disagree, and the answer would then report a page size the client did not use.
    const recent = vi.fn(async () => [run()]);
    const { res, body } = await listRuns("workflow=digest", { recent });
    expect(res.status).toBe(200);
    expect(recent).toHaveBeenCalledWith("digest", undefined);
    expect(body).not.toHaveProperty("truncatedTo");
  });
});
