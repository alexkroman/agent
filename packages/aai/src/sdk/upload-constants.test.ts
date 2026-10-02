// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import {
  MAX_WORKFLOW_UPLOAD_BYTES,
  UPLOAD_CHUNK_BYTES,
  UPLOAD_ID_PREFIX,
  UPLOAD_PART_BYTES,
  UPLOAD_PART_CONCURRENCY,
  UPLOAD_RESUME_BASE_MS,
  UPLOAD_RESUME_MAX_MS,
  UPLOAD_RETRY_BASE_MS,
  UPLOAD_RETRY_MAX_MS,
  UPLOAD_TOKEN_RE,
} from "./upload-constants.ts";

describe("upload sizes", () => {
  test("a part is a whole number of chunks, so a part boundary is a chunk boundary", () => {
    expect(UPLOAD_PART_BYTES % UPLOAD_CHUNK_BYTES).toBe(0);
  });

  test("the window in flight stays at the 64 MiB that measured clean", () => {
    expect(UPLOAD_PART_BYTES * UPLOAD_PART_CONCURRENCY).toBeLessThanOrEqual(64 * 1024 * 1024);
  });

  test("the upload cap is far above one part", () => {
    expect(MAX_WORKFLOW_UPLOAD_BYTES).toBeGreaterThan(UPLOAD_PART_BYTES);
  });
});

describe("upload backoff", () => {
  test("each backoff's base sits under its ceiling", () => {
    expect(UPLOAD_RETRY_BASE_MS).toBeLessThan(UPLOAD_RETRY_MAX_MS);
    expect(UPLOAD_RESUME_BASE_MS).toBeLessThan(UPLOAD_RESUME_MAX_MS);
  });
});

describe("UPLOAD_TOKEN_RE", () => {
  test.each([`${UPLOAD_ID_PREFIX}abc`, crypto.randomUUID(), "a", "x".repeat(64)])(
    "accepts %j",
    (token) => {
      expect(UPLOAD_TOKEN_RE.test(token)).toBe(true);
    },
  );

  test.each(["", "../../etc/passwd", "a/b", "a.b", "x".repeat(65), "a b"])(
    "refuses %j, which a path or a key could interpret",
    (token) => {
      expect(UPLOAD_TOKEN_RE.test(token)).toBe(false);
    },
  );
});
