// Copyright 2025 the AAI authors. MIT license.
import { describe, expect, it } from "vitest";
import { registry } from "./metrics.ts";

const SLUG_LABEL_PERMITLIST = new Set([
  "aai_sessions_started_total",
  "aai_sessions_active",
  "aai_sessions_ended_total",
]);

describe("metric cardinality discipline", () => {
  it("attaches the slug label only to permitlisted metrics", () => {
    // Inspect *declared* label names (not observed values) so the test
    // catches a stray `slug` label even on a metric that has never been
    // incremented.
    const offenders: string[] = [];
    for (const m of registry.getMetricsAsArray()) {
      const labelNames = (m as { labelNames?: readonly string[] }).labelNames ?? [];
      if (labelNames.includes("slug") && !SLUG_LABEL_PERMITLIST.has(m.name)) {
        offenders.push(m.name);
      }
    }
    expect(offenders).toEqual([]);
  });
});
