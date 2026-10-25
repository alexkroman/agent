// Copyright 2026 the AAI authors. MIT license.
/**
 * The scripted step fetch a case is handed as `ctx.steps`: the hold, the
 * release, and the drain the harness does for it.
 *
 * Driven through the published slot (`stepFetch`), which is the path a step
 * really takes; no engine, because the hold and the drain are properties of
 * the gate and of the order the harness calls things in, not of a run.
 */

import { stepFetch } from "@alexkroman1/aai/step";
import { describe, expect, onTestFinished, test, vi } from "vitest";
import { drainCaseSteps, installCaseSteps } from "./_case-steps.ts";
import type { EvalWorkflows } from "./workflows.ts";

const ROUTES = {
  "https://provider.test/poll": { body: { status: "done" } },
  "https://provider.test/submit": { body: { id: "job_1" } },
} as const;

describe("installCaseSteps", () => {
  test("holds the FIRST answered request until released, and logs it while held", async () => {
    const steps = installCaseSteps({ routes: ROUTES, hold: "first" });
    onTestFinished(steps.restore);
    const pending = stepFetch("https://provider.test/poll");
    await vi.waitFor(() => expect(steps.held).toBe(true));
    // Logged as it ARRIVED: "the run is waiting on the provider" is a claim
    // about `requests`; `hits` records a request once it has been answered.
    expect(steps.requests.map((request) => request.pathname)).toEqual(["/poll"]);
    expect(steps.hits).toHaveLength(0);
    steps.release();
    await expect(pending.then((res) => res.json())).resolves.toEqual({ status: "done" });
    expect(steps.held).toBe(false);
    expect(steps.hits.map((hit) => hit.outcome)).toEqual(["routed"]);
    // Only the first: the next request answers at once.
    const next = await stepFetch("https://provider.test/submit");
    expect(await next.json()).toEqual({ id: "job_1" });
  });

  test("a predicate holds the first request it matches, not the first request", async () => {
    const steps = installCaseSteps({
      routes: ROUTES,
      hold: (request) => request.pathname === "/poll",
    });
    onTestFinished(steps.restore);
    await stepFetch("https://provider.test/submit");
    expect(steps.held).toBe(false);
    const pending = stepFetch("https://provider.test/poll");
    await vi.waitFor(() => expect(steps.held).toBe(true));
    steps.release();
    await pending;
  });

  test("the default holds nothing, and a handler list composes like a table", async () => {
    const steps = installCaseSteps({
      routes: [(request) => (request.pathname === "/poll" ? { body: { ok: true } } : undefined)],
    });
    onTestFinished(steps.restore);
    expect(await (await stepFetch("https://provider.test/poll")).json()).toEqual({ ok: true });
    expect(steps.held).toBe(false);
    // A request no route answers is a finding, never an empty 200.
    await expect(stepFetch("https://provider.test/other")).rejects.toThrow(
      /no fetch route for GET https:\/\/provider.test\/other/,
    );
  });

  test("release is idempotent, and restore unpublishes the step fetch", async () => {
    const steps = installCaseSteps({ routes: ROUTES, hold: "first" });
    steps.release();
    steps.release();
    // Released before anything was held: the first request answers at once.
    await stepFetch("https://provider.test/poll");
    steps.restore();
    // Back to the real fetch, which an unreachable test host refuses.
    await expect(stepFetch("https://provider.test/poll")).rejects.toThrow();
  });
});

describe("drainCaseSteps", () => {
  const app = (settleAll: EvalWorkflows["settleAll"]): EvalWorkflows =>
    ({ settleAll }) as unknown as EvalWorkflows;

  test("releases the gate, then settles every run", async () => {
    const steps = installCaseSteps({ routes: ROUTES, hold: "first" });
    onTestFinished(steps.restore);
    const pending = stepFetch("https://provider.test/poll");
    await vi.waitFor(() => expect(steps.held).toBe(true));
    const settleAll = vi.fn(async () => []);
    await drainCaseSteps(steps, app(settleAll), false);
    expect(settleAll).toHaveBeenCalledOnce();
    await pending;
  });

  test("a drain that fails after the BODY failed is swallowed — the body's error is the finding", async () => {
    const steps = installCaseSteps({ routes: ROUTES });
    onTestFinished(steps.restore);
    const failing = app(async () => {
      throw new Error("run timed out");
    });
    await expect(drainCaseSteps(steps, failing, true)).resolves.toBeUndefined();
    await expect(drainCaseSteps(steps, failing, false)).rejects.toThrow("run timed out");
  });

  test("`drain: false` releases and settles nothing; no app settles nothing", async () => {
    const steps = installCaseSteps({ routes: ROUTES, drain: false });
    onTestFinished(steps.restore);
    const settleAll = vi.fn(async () => []);
    await drainCaseSteps(steps, app(settleAll), false);
    expect(settleAll).not.toHaveBeenCalled();
    const alone = installCaseSteps({ routes: ROUTES });
    onTestFinished(alone.restore);
    await drainCaseSteps(alone, undefined, false);
  });
});
