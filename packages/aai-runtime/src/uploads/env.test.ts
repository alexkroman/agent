// Copyright 2026 the AAI authors. MIT license.
// The three env keys an upload's byte home is configured by. They are read
// from a DEPLOYMENT's environment and published on the root barrel, so a
// rename is a break for every operator who set them — the strings are pinned.

import { expect, test } from "vitest";
import {
  UPLOAD_STORAGE_BUCKET_ENV,
  UPLOAD_STORAGE_KEY_ENV,
  UPLOAD_STORAGE_URL_ENV,
} from "./env.ts";

test("the three keys keep their names", () => {
  expect([UPLOAD_STORAGE_URL_ENV, UPLOAD_STORAGE_KEY_ENV, UPLOAD_STORAGE_BUCKET_ENV]).toEqual([
    "AAI_UPLOAD_STORAGE_URL",
    "AAI_UPLOAD_STORAGE_KEY",
    "AAI_UPLOAD_STORAGE_BUCKET",
  ]);
});
