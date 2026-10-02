// Copyright 2026 the AAI authors. MIT license.
// The upload store's own pure rules: the part-offset grid, the declared-total
// check, the readable prefix, fresh ids, and the error vocabulary the routes
// classify by name.

import { UPLOAD_CHUNK_BYTES, UPLOAD_ID_PREFIX } from "@alexkroman1/aai/host-internal";
import { describe, expect, test } from "vitest";
import {
  assertPartOffset,
  assertPartTotal,
  contiguousBytes,
  newUploadId,
  UnknownUploadError,
  UploadCompleteError,
  UploadIdTakenError,
  UploadPartError,
  UploadsUnavailableError,
  UploadTooLargeError,
} from "./store.ts";

describe("assertPartOffset", () => {
  test.each([0, UPLOAD_CHUNK_BYTES, 7 * UPLOAD_CHUNK_BYTES])("accepts %i", (offset) => {
    expect(() => assertPartOffset(offset)).not.toThrow();
  });

  test.each([
    [1.5, /whole number/],
    [-UPLOAD_CHUNK_BYTES, /negative/],
    [UPLOAD_CHUNK_BYTES + 1, /multiple of/],
    [1e20, /whole number/],
  ])("refuses %d with a reason of its own", (offset, reason) => {
    expect(() => assertPartOffset(offset)).toThrow(UploadPartError);
    expect(() => assertPartOffset(offset)).toThrow(reason);
  });
});

describe("assertPartTotal", () => {
  test("a size within the limit is accepted, zero included", () => {
    expect(() => assertPartTotal(0, 10)).not.toThrow();
    expect(() => assertPartTotal(10, 10)).not.toThrow();
  });

  test("a total that is not a size is a part error; one over the limit is too large", () => {
    expect(() => assertPartTotal(-1, 10)).toThrow(UploadPartError);
    expect(() => assertPartTotal(Number.NaN, 10)).toThrow(UploadPartError);
    expect(() => assertPartTotal(11, 10)).toThrow(UploadTooLargeError);
  });
});

describe("contiguousBytes", () => {
  test("is the end of the range starting at zero", () => {
    expect(
      contiguousBytes([
        { start: 0, end: 4 },
        { start: 8, end: 12 },
      ]),
    ).toBe(4);
  });

  test("is 0 when byte zero has not arrived, however much else has", () => {
    expect(contiguousBytes([{ start: 4, end: 100 }])).toBe(0);
    expect(contiguousBytes([])).toBe(0);
  });
});

test("newUploadId is prefixed and unique", () => {
  const a = newUploadId();
  expect(a.startsWith(UPLOAD_ID_PREFIX)).toBe(true);
  expect(a).toMatch(/^[\w]+$/);
  expect(newUploadId()).not.toBe(a);
});

test("every upload error carries its own name and names the id it is about", () => {
  const cause = new Error("bucket refused");
  const cases: [Error, string][] = [
    [new UploadTooLargeError(10), "UploadTooLargeError"],
    [new UploadIdTakenError("upl_1", { cause }), "UploadIdTakenError"],
    [new UploadCompleteError("upl_1"), "UploadCompleteError"],
    [new UploadPartError("bad part"), "UploadPartError"],
    [new UnknownUploadError("upl_1"), "UnknownUploadError"],
    [new UploadsUnavailableError("no bucket"), "UploadsUnavailableError"],
  ];
  for (const [err, name] of cases) expect.soft(err.name, name).toBe(name);
  expect(new UploadIdTakenError("upl_1", { cause }).cause).toBe(cause);
  expect(new UnknownUploadError("upl_9").message).toContain("upl_9");
  expect(new UploadTooLargeError(10).message).toContain("10");
});
