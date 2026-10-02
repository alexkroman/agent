// Copyright 2026 the AAI authors. MIT license.
/**
 * The two lazy loaders `/internal` carries for another package's conformance
 * arms. Each defers a module that imports vitest, so loading must hand back the
 * case list and its id factory without declaring a single case.
 *
 * Deliberately never INVOKES a case list: `conformance-arms.test.ts` and
 * `session-state/conformance.test.ts` scan for files that do, and count each as
 * an arm.
 */

import { describe, expect, test } from "vitest";
import { loadJournalConformance, loadSessionStateConformance } from "./internal.ts";

describe("loadJournalConformance", () => {
  test("hands back the case list and an id factory", async () => {
    const suite = await loadJournalConformance();
    expect(suite.journalConformance).toBeTypeOf("function");
    const next = suite.journalIds("internal-test");
    const [a, b] = [next(), next()];
    expect(a).not.toBe(b);
  });
});

describe("loadSessionStateConformance", () => {
  test("hands back the case list and an id factory", async () => {
    const suite = await loadSessionStateConformance();
    expect(suite.sessionStateConformance).toBeTypeOf("function");
    const next = suite.sessionStateIds("internal-test");
    expect(next()).not.toBe(next());
  });
});
