// Copyright 2025 the AAI authors. MIT license.
import { expect, test } from "vitest";
import { _internals } from "./_bundler.ts";

const { BundleError } = _internals;

test("BundleError: creates error with BundleError name", () => {
  const err = new BundleError("something went wrong");
  expect(err).toBeInstanceOf(Error);
  expect(err).toBeInstanceOf(BundleError);
  expect(err.name).toBe("BundleError");
  expect(err.message).toBe("something went wrong");
});
