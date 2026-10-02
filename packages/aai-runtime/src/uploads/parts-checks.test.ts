// Copyright 2026 the AAI authors. MIT license.
// What a parts upload's own record permits, checked against one window.

import { describe, expect, test } from "vitest";
import { assertUploadOpen, declaredTotal, measuredPart } from "./parts-checks.ts";
import type { UploadRecord } from "./records.ts";
import { UploadCompleteError, UploadPartError } from "./store.ts";

function record(overrides: Partial<UploadRecord> = {}): UploadRecord {
  return { name: "a.wav", type: "audio/wav", size: 0, complete: false, parts: [], ...overrides };
}

describe("measuredPart", () => {
  test("a window that fits is the part it measured", () => {
    expect(measuredPart("upl_1", 4, 4, 8)).toEqual({ at: 4, bytes: 4 });
  });

  test("no stored bytes is refused, naming the signed-URL step", () => {
    expect(() => measuredPart("upl_1", 0, undefined, 8)).toThrow(
      /Upload the part to its signed URL/,
    );
  });

  test("an empty window is refused where the upload declares bytes, and allowed where it declares none", () => {
    expect(() => measuredPart("upl_1", 0, 0, 8)).toThrow(/measured 0 bytes/);
    expect(measuredPart("upl_1", 0, 0, 0)).toEqual({ at: 0, bytes: 0 });
  });

  test("a window running past the declared total is refused", () => {
    expect(() => measuredPart("upl_1", 4, 5, 8)).toThrow(UploadPartError);
  });
});

describe("assertUploadOpen", () => {
  test("an open upload passes; a finished one is a 409-shaped refusal", () => {
    expect(() => assertUploadOpen("upl_1", record())).not.toThrow();
    expect(() => assertUploadOpen("upl_1", record({ complete: true }))).toThrow(
      UploadCompleteError,
    );
  });
});

describe("declaredTotal", () => {
  test("answers the declared total for an offset inside it, the end included", () => {
    expect(declaredTotal("upl_1", record({ expected: 8 }), 8)).toBe(8);
  });

  test("an upload not begun as parts, and an offset past the total, are refused", () => {
    expect(() => declaredTotal("upl_1", record(), 0)).toThrow(/not begun as a parts upload/);
    expect(() => declaredTotal("upl_1", record({ expected: 8 }), 9)).toThrow(/starts past/);
  });
});
