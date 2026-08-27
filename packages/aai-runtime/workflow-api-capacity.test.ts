// Copyright 2026 the AAI authors. MIT license.
/**
 * A capacity failure is a 503, not a 500 — the distinction a caller acts on.
 *
 * Found by load: eight workflow guests booted at once against a 100-connection
 * Postgres saturated it, and every `POST /workflows/runs` that could not get a
 * connection answered `Internal server error`. That is indistinguishable from a
 * broken agent, so a client cannot back off, an operator cannot triage, and a
 * load balancer cannot shed.
 */

import { describe, expect, test } from "vitest";
import { isInsufficientResources } from "./workflow-api-http.ts";

describe("isInsufficientResources", () => {
  /** The one that actually happened, and the one that reaches us WRAPPED. */
  test("finds 53300 through a cause chain", () => {
    const driver = Object.assign(new Error('too many connections for role "app_abc"'), {
      code: "53300",
    });
    // graphile-worker → drizzle → the DevKit's world: none re-throws the
    // original, so the code is only ever reachable through `cause`.
    const wrapped = new Error("the Postgres world migration failed", {
      cause: new Error("query failed", { cause: driver }),
    });
    expect(isInsufficientResources(wrapped)).toBe(true);
    expect(isInsufficientResources(driver)).toBe(true);
  });

  /**
   * The CLASS, not a code list. All four of these mean the database ran out of
   * something and a caller's response to each is identical, so enumerating them
   * is how the next one gets missed.
   */
  test.each(["53300", "53200", "53100", "53400"])("treats %s as capacity", (code) => {
    expect(isInsufficientResources(Object.assign(new Error("x"), { code }))).toBe(true);
  });

  test("is not fooled by a non-capacity SQLSTATE or a foreign code", () => {
    // 42P07 is duplicate_table — a real error, and never retryable.
    expect(isInsufficientResources(Object.assign(new Error("x"), { code: "42P07" }))).toBe(false);
    // A five-character guard, so another vocabulary's `53…` cannot pass as one.
    expect(isInsufficientResources(Object.assign(new Error("x"), { code: "53" }))).toBe(false);
    expect(isInsufficientResources(Object.assign(new Error("x"), { code: "530012" }))).toBe(false);
    expect(isInsufficientResources(new Error("no code at all"))).toBe(false);
    expect(isInsufficientResources(undefined)).toBe(false);
  });

  test("terminates on a cyclic cause chain", () => {
    // A walk without the `seen` set hangs the request it was trying to classify.
    const a: { code?: string; cause?: unknown } = {};
    const b = { cause: a };
    a.cause = b;
    expect(isInsufficientResources(a)).toBe(false);
  });
});
