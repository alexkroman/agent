// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, expectTypeOf, test } from "vitest";
import { type Db, MAX_DB_RESULT_ROWS } from "./db.ts";

describe("Db", () => {
  test("Db.query returns Promise<Record<string, unknown>[]> by default", () => {
    // Still pinned, and deliberately: an INTERNAL type with three consumers across
    // two packages is exactly the kind whose signature drifts unnoticed.
    const query: Db["query"] = () => Promise.resolve([]);
    expectTypeOf(query("select 1")).toEqualTypeOf<Promise<Record<string, unknown>[]>>();
  });
  test("Db.query accepts sql alone or with params, and a row type argument", () => {
    expectTypeOf<Db["query"]>().toBeCallableWith("select 1");
    expectTypeOf<Db["query"]>().toBeCallableWith("select * from t where id = $1", [42]);
    const query: Db["query"] = () => Promise.resolve([]);
    expectTypeOf(query<{ id: number }>("select id from t")).toEqualTypeOf<
      Promise<{ id: number }[]>
    >();
  });
});

describe("MAX_DB_RESULT_ROWS", () => {
  test("is a positive whole number of rows", () => {
    expect(Number.isInteger(MAX_DB_RESULT_ROWS)).toBe(true);
    expect(MAX_DB_RESULT_ROWS).toBeGreaterThan(0);
  });
});
