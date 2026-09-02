// Copyright 2026 the AAI authors. MIT license.
/**
 * The run routes' QUERY PARAMETERS, at the RUNTIME edge.
 *
 * The rest of these routes is covered from `workflow-api.test.ts`, which drives
 * the whole surface through the same loopback harness. What is only visible here
 * is what a caller's own strings and numbers are allowed to be, on a surface that
 * is unauthenticated unless the operator sets `AAI_WORKFLOW_API_TOKEN` — the
 * `limit` that decides how much WORK an answer is, the `wait` that decides how
 * long a socket is held, and the `correlationId` bound the SDK client has to
 * agree with.
 *
 * One split runs through all three blocks: **a value with no truthful reading is
 * REFUSED, and a value that merely needs bounding is bounded.** `limit` used to
 * check `Number.isFinite` and nothing else, so `?limit=2.5` and `?limit=-5` were
 * both forwarded — the negative one all the way to a platform `LIMIT -1`, which
 * comes back as a retryable 503 rather than the 400 it is — while a limit that is
 * merely too big is clamped and SAID to be, because a page asking for five
 * hundred wants as many as it can have and a silent hundred is an answer that
 * looks complete.
 *
 * The platform half of the `limit` bound is
 * `aai-server/workflow-journal-handler.ts`, and it is deliberately not this one:
 * a guest is not trusted, so the ceiling has to hold with this edge bypassed
 * entirely.
 */

import { createWorkflowApiClient } from "@alexkroman1/aai/workflow-api";
import { afterEach, describe, expect, test, vi } from "vitest";
import { MAX_WORKFLOW_KEY_LENGTH } from "./workflow-api-runs.ts";
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

/**
 * `GET /runs/:id`'s `?wait=`, which had the defect `?startIndex=` just had.
 *
 * `Number(query.get("wait"))` reads a BLANK parameter as `0` and a non-numeric
 * one as `NaN`, and `clampWorkflowWait` maps both to "do not wait" — so both were
 * answered 200 with a running snapshot, immediately. Benign in outcome and the
 * same class of defect as the `?startIndex=` one that was NOT: a caller that
 * meant to send a value and computed nothing was served a different request from
 * the one it asked for, with no way to see it.
 *
 * The decision, stated because leniency was the live behaviour and had to be
 * chosen or dropped rather than left: a value with NO reading is REFUSED, and a
 * value `clampWorkflowWait` already documents a reading FOR is left alone. So
 * `?wait=` and `?wait=abc` are 400s — nobody asks for those on purpose — while
 * `0`, a negative and an infinity keep meaning "do not wait", which is that
 * function's own published contract and shared by both ends. Refusing those too
 * would be this route re-deriving the clamp, and `api.get(runId, { wait: -1 })`
 * would then fail against a rule the SDK does not state.
 */
describe("GET /runs/:id — the `wait` a caller supplies", () => {
  async function readRun(query: string) {
    const get = vi.fn(async () => run());
    harness = await serve({ engine: () => fakeClient({ get }) });
    const res = await fetch(`${harness.url}/workflows/runs/wrun_1${query}`);
    return { res, get };
  }

  test.each([
    ["blank", "?wait="],
    ["not a number", "?wait=abc"],
    ["a number with a typo in it", "?wait=30_000"],
  ])("refuses a wait that is %s", async (_label, query) => {
    const { res, get } = await readRun(query);
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "`wait` must be a number" });
    // Refused rather than silently read as "do not wait": the run is not looked
    // up at all, so the caller cannot mistake the answer for the one it asked for.
    expect(get).not.toHaveBeenCalled();
  });

  test.each([
    ["no parameter at all", ""],
    ["zero", "?wait=0"],
    ["a negative", "?wait=-5"],
  ])("reads %s as `do not wait`, which is the clamp's own contract", async (_label, query) => {
    const { res, get } = await readRun(query);
    expect(res.status).toBe(200);
    expect(get).toHaveBeenCalledWith("wrun_1");
  });
});

/**
 * The one place the SDK client's refusals and this route's can be compared.
 *
 * `createWorkflowApiClient` refuses a blank or over-long `correlationId` before
 * it sends anything, and it has to restate the cap: `@alexkroman1/aai` may not
 * import this package, and `MAX_WORKFLOW_KEY_LENGTH` is a bound the SERVER
 * enforces rather than a name a caller should have to know. Two copies of a
 * number need a test rather than a comment, so the boundary is driven from BOTH
 * sides here — this package legitimately depends on both halves.
 */
describe("POST /runs/:id/wake — the SDK client and this route agree", () => {
  /** The real route on a loopback server, with the real SDK client aimed at it. */
  async function wakeHarness() {
    const wakeUp = vi.fn(async () => 1);
    harness = await serve({ engine: () => fakeClient({ wakeUp }) });
    return { api: createWorkflowApiClient({ baseUrl: harness.url }), wakeUp };
  }

  test("the longest id the route accepts is one the client will send", async () => {
    const id = "a".repeat(MAX_WORKFLOW_KEY_LENGTH);
    const { api, wakeUp } = await wakeHarness();
    await expect(api.wake("wrun_1", { correlationIds: [id] })).resolves.toBe(1);
    expect(wakeUp).toHaveBeenCalledWith("wrun_1", { correlationIds: [id] });
  });

  test("one character more is refused by the client, so the route never sees it", async () => {
    const { api, wakeUp } = await wakeHarness();
    await expect(
      api.wake("wrun_1", { correlationIds: ["a".repeat(MAX_WORKFLOW_KEY_LENGTH + 1)] }),
    ).rejects.toThrow(new RegExp(`at most ${MAX_WORKFLOW_KEY_LENGTH} characters`));
    expect(wakeUp).not.toHaveBeenCalled();
  });

  test("a blank id is refused by the client on the same terms the route uses", async () => {
    const { api, wakeUp } = await wakeHarness();
    await expect(api.wake("wrun_1", { correlationIds: [""] })).rejects.toThrow(/must not be empty/);
    // And the route still refuses it for a caller that is not this client — the
    // agreement is two independent checks, not one delegating to the other.
    const res = await fetch(`${harness?.url}/workflows/runs/wrun_1/wake?correlationId=`, {
      method: "POST",
    });
    expect(res.status).toBe(400);
    expect(wakeUp).not.toHaveBeenCalled();
  });

  /**
   * The plural spelling is the mistake this route invites, and it used to
   * degrade to the BLUNT wake.
   *
   * The parameter is singular and repeatable; the SDK field it fills is
   * `WakeUpOptions.correlationIds`. Found by hand against a dev server:
   * `?correlationIds=nope` answered `200 {woken: 1}` and ended a sleep whose
   * correlation id was `long` — the handler read no ids, so it called
   * `wakeUp(runId)`, which ends EVERY outstanding sleep on the run. A caller
   * asking to cut one wait short cut all of them, permanently, on a 200.
   */
  test("an unknown query key is refused rather than read as no ids", async () => {
    const { wakeUp } = await wakeHarness();
    const res = await fetch(
      `${harness?.url}/workflows/runs/wrun_1/wake?correlationIds=review-window`,
      { method: "POST" },
    );
    expect(res.status).toBe(400);
    // The caller's own misspelling is echoed back, which is the half that makes
    // the refusal actionable — a 400 that does not name the key it rejected
    // leaves the caller comparing two spellings by eye.
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringContaining("correlationIds"),
    });
    expect(wakeUp).not.toHaveBeenCalled();
  });

  /** And the bare form still works — the refusal is about UNKNOWN keys only. */
  test("naming no ids at all is still the blunt wake", async () => {
    const { wakeUp } = await wakeHarness();
    const res = await fetch(`${harness?.url}/workflows/runs/wrun_1/wake`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(wakeUp).toHaveBeenCalledWith("wrun_1", undefined);
  });
});
