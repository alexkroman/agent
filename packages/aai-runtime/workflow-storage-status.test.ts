// Copyright 2026 the AAI authors. MIT license.
/**
 * The two directions have to compose, and that is most of what this pins.
 *
 * A status the platform sends and a status the guest reads are one decision
 * split across two packages, so the property worth asserting is the ROUND TRIP:
 * every class this taxonomy recognises must come back as itself. Asserting the
 * numbers alone would pass a version where one side learned a status the other
 * never did — which is the bug the module exists to prevent, one status later.
 */

import { describe, expect, test } from "vitest";
import {
  STORAGE_CONFLICT_STATUS,
  STORAGE_RUN_EXPIRED_STATUS,
  storageErrorForStatus,
  storageStatusFor,
} from "./workflow-storage-status.ts";

/**
 * A world error built by NAME, the way the real one arrives.
 *
 * `RunExpiredError.is` is `isError(v) && v.name === "…"`, and it is a name check
 * because the copy that RAISES is not the copy anyone imported — this tree holds
 * four of `@workflow/errors`. Constructing by name is therefore the faithful
 * fixture, not a shortcut around one.
 */
function worldError(name: string): Error {
  const err = new Error(`${name} happened`);
  err.name = name;
  return err;
}

describe("storageStatusFor", () => {
  test.each([
    ["RunExpiredError", STORAGE_RUN_EXPIRED_STATUS],
    ["EntityConflictError", STORAGE_CONFLICT_STATUS],
  ])("classifies %s as %i", (name, status) => {
    expect(storageStatusFor(worldError(name))).toBe(status);
  });

  test.each([
    ["a transient throttle", worldError("ThrottleError")],
    ["a too-early retry", worldError("TooEarlyError")],
    ["the world's catch-all", worldError("WorkflowWorldError")],
    ["a plain error", new Error("connection terminated")],
    ["a non-error", "not an error"],
    ["nothing at all", undefined],
  ])("leaves %s to the caller's default", (_label, err) => {
    // `undefined` is the load-bearing half: everything unrecognised keeps
    // `withReserved`'s 503, because a transient failure misread as permanent
    // strands a healthy run — the expensive direction to be wrong in.
    expect(storageStatusFor(err)).toBeUndefined();
  });

  test("does not classify a transient class, deliberately", () => {
    // `ThrottleError` IS distinguishable here and is left alone on purpose: 503
    // already means "retry me", and the only thing 429 would add is the
    // `retryAfter` — which needs a header to survive the hop. See the module doc.
    expect(storageStatusFor(worldError("ThrottleError"))).toBeUndefined();
  });
});

describe("storageErrorForStatus", () => {
  test.each([
    [STORAGE_RUN_EXPIRED_STATUS, "RunExpiredError"],
    [STORAGE_CONFLICT_STATUS, "EntityConflictError"],
  ])("rebuilds %i as %s, carrying the detail", (status, name) => {
    const rebuilt = storageErrorForStatus(status, "storage events.create answered HTTP 410");
    expect(rebuilt?.name).toBe(name);
    // The detail has to ride along or the only record of WHICH call was refused
    // is a class name.
    expect(rebuilt?.message).toContain("events.create");
  });

  test.each([404, 400, 500, 503, 501])("leaves %i to the caller", (status) => {
    // 404 especially: `storageFailure` owns that one and turns it into
    // `WorkflowRunNotFoundError`, so claiming it here would silently take it over.
    expect(storageErrorForStatus(status, "detail")).toBeUndefined();
  });
});

describe("the two directions compose", () => {
  test.each(["RunExpiredError", "EntityConflictError"])("%s survives the hop as itself", (name) => {
    // The whole point of one module: a class the platform classifies is a class
    // the guest rebuilds. A status added to one table and not the other fails
    // here rather than in production, where it reads as an unclassified error
    // the DevKit retries.
    const status = storageStatusFor(worldError(name));
    expect(status).toBeDefined();
    expect(storageErrorForStatus(status as number, "detail")?.name).toBe(name);
  });

  test("the two statuses are distinct, so one cannot mask the other", () => {
    expect(STORAGE_RUN_EXPIRED_STATUS).not.toBe(STORAGE_CONFLICT_STATUS);
  });
});
