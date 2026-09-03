// Copyright 2026 the AAI authors. MIT license.

import { parseBearer } from "@alexkroman1/aai-runtime/internal";
import { describe, expect, test } from "vitest";
import { bearerFailureMessage } from "./_bearer.ts";

/**
 * The `parseBearer` cases this file used to hold live in
 * `aai-runtime/bearer.test.ts` now, beside the parse itself.
 *
 * They are not merely moved — a copy here would be the failure this suite's own
 * history records. It PINNED the case-sensitivity bug as correct
 * (`expect(parseBearer("bearer abc123")).toBe("")`), which is how a spec-legal
 * client stayed locked out of every platform route while the gate that should
 * have caught it asserted the bug, and it is a large part of how the same line
 * came to exist in four packages. One parse, one suite.
 *
 * What stays is the sentence, which is this package's alone, plus the one claim
 * that spans both: they may never disagree about what "did not resolve" means.
 */
describe("parseBearer, as this package consumes it", () => {
  test("a header the SHARED parse resolves never reaches a failure sentence", () => {
    // The coupling, not the parse. `requireBearerToken` calls
    // `bearerFailureMessage` only when the parse answered `""`, so a parse that
    // grew stricter would start answering "Malformed" for headers this platform
    // used to accept — the exact shape of the case-sensitivity bug, whose whole
    // symptom was a refusal sentence for a header that was in fact well formed.
    for (const header of ["Bearer abc123", "bearer abc123", "BEARER  abc123"]) {
      expect(parseBearer(header), header).toBe("abc123");
    }
  });

  test("a header it REJECTS is exactly the set the sentence has to describe", () => {
    // The other half of the coupling. `requireBearerToken` throws with
    // `bearerFailureMessage` precisely when the parse answers `""`, so these two
    // sets must partition every header — a parse that started ACCEPTING one of
    // these would hand an unparsed header on as a credential.
    for (const header of ["Basic abc123", "Bearerabc123", "Bearer", "", "Bearer   ", null]) {
      expect(parseBearer(header), String(header)).toBe("");
    }
  });
});

describe("bearerFailureMessage", () => {
  test("says MISSING only when nothing was sent", () => {
    for (const header of [null, undefined, "", "   "]) {
      expect(bearerFailureMessage(header)).toBe("Missing Authorization header (Bearer <API_KEY>)");
    }
  });

  test("says MALFORMED when a header was present but unparseable", () => {
    // The half that was wrong: a present, well-formed-looking header answered
    // "Missing Authorization header", naming a cause that is not the cause.
    for (const header of ["Basic abc123", "Bearerabc123", "Bearer", "Token abc123"]) {
      expect(bearerFailureMessage(header)).toBe(
        "Malformed Authorization header (expected `Bearer <API_KEY>`)",
      );
    }
  });

  test("does not reflect the header back into the response body", () => {
    // The value is attacker-controlled and this string is a response body.
    expect(bearerFailureMessage("Basic <script>alert(1)</script>")).not.toContain("script");
  });
});
