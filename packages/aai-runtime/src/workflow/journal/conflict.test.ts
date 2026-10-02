// Copyright 2026 the AAI authors. MIT license.
// The one journal rejection that is a verdict about the RUN.

import { expect, test } from "vitest";
import { JournalConflictError } from "./conflict.ts";

test("is an Error named for itself", () => {
  const err = new JournalConflictError("hook token tok_1 is held by another run");
  expect(err).toBeInstanceOf(Error);
  expect(err.name).toBe("JournalConflictError");
  expect(err.message).toContain("tok_1");
});

test("`is` reads the NAME, so an Error rebuilt across a boundary still counts", () => {
  expect(JournalConflictError.is(new JournalConflictError("x"))).toBe(true);
  // What a JSON-RPC client rebuilds from `{ name, message }`: a plain Error.
  const rebuilt = Object.assign(new Error("x"), { name: "JournalConflictError" });
  expect(rebuilt).not.toBeInstanceOf(JournalConflictError);
  expect(JournalConflictError.is(rebuilt)).toBe(true);
});

test("`is` refuses a store failure and a non-Error carrying the name", () => {
  expect(JournalConflictError.is(new Error("socket reset"))).toBe(false);
  expect(JournalConflictError.is({ name: "JournalConflictError", message: "x" })).toBe(false);
  expect(JournalConflictError.is(undefined)).toBe(false);
});
