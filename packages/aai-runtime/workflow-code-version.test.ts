// Copyright 2026 the AAI authors. MIT license.
/**
 * The three verdicts, and the one that must never be invented.
 *
 * `workflow-replay-divergence.test.ts` covers what the message SAYS; this covers
 * the decision under it, because the failure mode is asymmetric. Reporting
 * `unknown` where the code really did change costs a less specific error
 * message. Reporting `same` where either side is unknown makes the divergence
 * message state as a fact that the code did not change — ruling out the cause
 * that actually happened, which is worse than having no version at all.
 */

import { describe, expect, test } from "vitest";
import { describeCodeChange, resolveCodeVersion } from "./workflow-code-version.ts";

const A = "a".repeat(64);
const B = "b".repeat(64);

describe("resolveCodeVersion", () => {
  test("answers the bundle hash the platform baked in", () => {
    expect(resolveCodeVersion({ AAI_BUNDLE_SHA256: A })).toBe(A);
  });

  test("answers undefined off the platform, where the key is absent", () => {
    expect(resolveCodeVersion({})).toBeUndefined();
  });

  test("treats an empty or whitespace value as absent, never as a version", () => {
    // An empty string is a key that was SET and says nothing, and it would
    // compare unequal to every real hash — i.e. it would report a redeploy on
    // every walk. Trimmed for the same reason: a hash with a stray newline is
    // the same program.
    expect(resolveCodeVersion({ AAI_BUNDLE_SHA256: "" })).toBeUndefined();
    expect(resolveCodeVersion({ AAI_BUNDLE_SHA256: "   " })).toBeUndefined();
    expect(resolveCodeVersion({ AAI_BUNDLE_SHA256: ` ${A}\n` })).toBe(A);
  });
});

describe("describeCodeChange", () => {
  test("two different versions is a CHANGE, carrying both", () => {
    expect(describeCodeChange(A, B)).toEqual({ kind: "changed", startedUnder: A, current: B });
  });

  test("one version on both sides is SAME, which rules a redeploy out", () => {
    expect(describeCodeChange(A, A)).toEqual({ kind: "same", version: A });
  });

  test("either side missing is UNKNOWN, and never same", () => {
    // The asymmetry this module exists for — see the file's doc.
    expect(describeCodeChange(undefined, B)).toEqual({ kind: "unknown" });
    expect(describeCodeChange(A, undefined)).toEqual({ kind: "unknown" });
    expect(describeCodeChange(undefined, undefined)).toEqual({ kind: "unknown" });
  });
});
