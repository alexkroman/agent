// Copyright 2026 the AAI authors. MIT license.
/**
 * The tenant boundary's decision half, tested exhaustively.
 *
 * These are cheap, pure and complete on purpose: the failure mode being guarded
 * against is one agent reading another's run, and the cause would be a single
 * method whose scope nobody decided. So every method is asserted to HAVE a scope,
 * every required run id is asserted to be REQUIRED, and the specific argument
 * shapes their signatures allow — an optional first parameter, an optional params
 * field — are asserted to be refused rather than treated as "no filter".
 */

import { describe, expect, test } from "vitest";
import {
  decideScope,
  isStorageMethod,
  STORAGE_METHODS,
  STORAGE_SCOPES,
  type StorageMethod,
} from "./workflow-storage-scope.ts";

describe("the method set", () => {
  /**
   * Seventeen: the DevKit's eleven `Storage` methods plus six of its `Streamer`.
   *
   * A count is asserted rather than left implicit because the dangerous change is
   * an ADDITION that nobody scoped — and while the `Record` type catches that at
   * compile time, this catches a method being dropped from the union to make a
   * type error go away.
   *
   * Six of seven `Streamer` members, not all: `readFromStream` returns a LIVE
   * `ReadableStream` and is a long-lived streaming response rather than one
   * request and one reply, so it needs its own route. `streamFlushIntervalMs` is a
   * number on their interface, not a method.
   */
  test("is their eleven Storage methods plus six Streamer members", () => {
    expect(STORAGE_METHODS.filter((m) => !m.startsWith("streamer."))).toHaveLength(11);
    expect(STORAGE_METHODS.filter((m) => m.startsWith("streamer."))).toHaveLength(6);
    expect(new Set(STORAGE_METHODS).size).toBe(17);
  });

  test("no streamer method is scoped without namespacing its stream name", () => {
    // The reason the namespacing exists: their `readFromStream` looks a stream up by
    // name alone, so two agents sharing a name would share a stream. Every streamer
    // method that TAKES a name must therefore qualify it, and the only exception is
    // the one that takes a run id instead and returns names.
    for (const method of STORAGE_METHODS.filter((m) => m.startsWith("streamer."))) {
      expect(["stream", "own-streams"], `${method} is not stream-scoped`).toContain(
        STORAGE_SCOPES[method].kind,
      );
    }
  });

  test("every method has a scope", () => {
    for (const method of STORAGE_METHODS) {
      expect(STORAGE_SCOPES[method], `${method} has no scope`).toBeDefined();
    }
  });

  test("no scope entry names a method that is not in the set", () => {
    // The reverse direction: a leftover entry for a renamed method is dead config
    // that reads as coverage.
    for (const key of Object.keys(STORAGE_SCOPES)) {
      expect(isStorageMethod(key), `${key} is not a served method`).toBe(true);
    }
  });

  test.each(["runs.destroy", "events", "", "RUNS.GET", "steps.get "])(
    "refuses %o as a method",
    (value) => {
      expect(isStorageMethod(value)).toBe(false);
    },
  );

  test.each([undefined, null, 7, {}])("refuses the non-string %o", (value) => {
    expect(isStorageMethod(value)).toBe(false);
  });
});

describe("methods keyed by a positional run id", () => {
  const positional: StorageMethod[] = ["runs.get", "steps.get", "events.get"];

  test.each(positional)("%s takes the run id from argument 0", (method) => {
    const decision = decideScope(method, ["run_1", "other"]);
    expect(decision).toEqual({
      ok: true,
      scope: { kind: "run-arg", index: 0 },
      requiredRunId: "run_1",
    });
  });

  /**
   * `steps.get`'s first parameter is `string | undefined` in their signature, and
   * undefined makes them look a step up by its id ALONE — across every tenant.
   * That is the single most dangerous shape in this surface.
   */
  test.each(positional)("%s is REFUSED without a run id, never defaulted", (method) => {
    for (const args of [[undefined, "step_1"], [null, "step_1"], ["", "step_1"], []]) {
      const decision = decideScope(method, args);
      expect(decision.ok, `${method} accepted ${JSON.stringify(args)}`).toBe(false);
    }
  });

  test("the refusal names the method and the argument, for a diagnosable 400", () => {
    const decision = decideScope("steps.get", [undefined, "step_1"]);
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toMatch(/steps\.get requires a run id at argument 0/);
  });
});

describe("methods keyed by a run id inside their params", () => {
  const inParams: StorageMethod[] = ["steps.list", "events.list", "hooks.list"];

  test.each(inParams)("%s takes runId out of the params object", (method) => {
    const decision = decideScope(method, [{ runId: "run_1", pagination: { limit: 10 } }]);
    expect(decision.ok).toBe(true);
    if (decision.ok) expect(decision.requiredRunId).toBe("run_1");
  });

  /**
   * `hooks.list`'s `runId` is OPTIONAL in their params, and absent means every
   * hook. Requiring it is what closes that.
   */
  test.each(inParams)("%s is REFUSED when runId is absent or empty", (method) => {
    for (const args of [[{}], [{ runId: "" }], [{ runId: 7 }], [undefined], ["run_1"], []]) {
      const decision = decideScope(method, args);
      expect(decision.ok, `${method} accepted ${JSON.stringify(args)}`).toBe(false);
    }
  });

  test("the refusal names the field", () => {
    const decision = decideScope("hooks.list", [{}]);
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toMatch(/hooks\.list requires runId in its params/);
  });
});

describe("the methods with no run key at all", () => {
  /**
   * These four are the ones that CANNOT be scoped by requiring a run id, and each
   * has a different reason. Asserting the kind rather than the behaviour, because
   * the behaviour is the handler's — what matters here is that none of them is
   * classified as a forwardable run lookup.
   */
  test.each([
    // Their query filters on workflowName and status, so forwarding lists everyone's.
    ["runs.list", "own-runs"],
    // A correlation id is user-chosen, so two agents may legitimately share one.
    ["events.listByCorrelationId", "filter-runs"],
    // A hook id and a token identify a hook, not a run.
    ["hooks.get", "resolve-hook"],
    ["hooks.getByToken", "resolve-hook"],
    // The mutation, which may create the run it is scoped by.
    ["events.create", "create-run"],
  ] as const)("%s is scoped as %s", (method, kind) => {
    expect(STORAGE_SCOPES[method].kind).toBe(kind);
  });

  test.each([
    "runs.list",
    "events.listByCorrelationId",
    "hooks.get",
    "hooks.getByToken",
    "events.create",
  ] as const)("%s requires no run id of the caller", (method) => {
    const decision = decideScope(method, [{}]);
    expect(decision.ok).toBe(true);
    if (decision.ok) expect(decision.requiredRunId).toBeUndefined();
  });

  /**
   * The assertion that would have caught the mistake this module exists to
   * prevent: none of the five may be a plain pass-through.
   *
   * There is no `forward` kind, so this is really asserting that nobody adds one
   * and points these at it. It fails the moment a scope for any of them is
   * softened to something that forwards an unscoped query.
   */
  test("none of them is scoped as an ordinary run lookup", () => {
    for (const method of [
      "runs.list",
      "events.listByCorrelationId",
      "hooks.get",
      "hooks.getByToken",
    ] as const) {
      expect(["run-arg", "run-param"]).not.toContain(STORAGE_SCOPES[method].kind);
    }
  });
});

describe("the shape of the decision", () => {
  test("a required run id is carried out, so the handler need not re-derive it", () => {
    // Re-deriving is how the check and the call come to disagree about which run
    // they are talking about.
    const decision = decideScope("events.list", [{ runId: "run_9" }]);
    expect(decision.ok).toBe(true);
    if (decision.ok) expect(decision.requiredRunId).toBe("run_9");
  });

  test("deciding touches nothing — no database, no world, no ownership", () => {
    // The whole reason this is a separate module. If `decideScope` needed either,
    // it could not be tested exhaustively and the table would go unchecked.
    expect(decideScope.length).toBe(2);
    expect(decideScope("runs.get", ["run_1"]).ok).toBe(true);
  });
});
