// Copyright 2026 the AAI authors. MIT license.
import { expect, expectTypeOf, test } from "vitest";
import { omitUndefined } from "./omit-undefined.ts";

test("drops undefined-valued keys and keeps every other value", () => {
  const out = omitUndefined({
    name: "demo" as string | undefined,
    greeting: undefined as string | undefined,
    count: 0 as number | undefined,
    flag: false as boolean | undefined,
    empty: "" as string | undefined,
  });

  // 0/false/"" are values, not absences — the hand-written conditional spreads
  // this replaces all tested `!== undefined` rather than truthiness, and a
  // helper that quietly dropped a falsy value would change 44 call sites'
  // behaviour at once.
  expect(out).toEqual({ name: "demo", count: 0, flag: false, empty: "" });
  expect("greeting" in out).toBe(false);
});

test("keeps a null value — null is not undefined", () => {
  expect(omitUndefined({ a: null as string | null })).toEqual({ a: null });
});

test("returns a fresh object and never mutates its argument", () => {
  const input = { a: 1, b: undefined };
  const out = omitUndefined(input);
  expect(out).not.toBe(input);
  expect(Object.keys(input)).toEqual(["a", "b"]);
});

test("an all-undefined object spreads to nothing", () => {
  expect({ kept: 1, ...omitUndefined({ a: undefined, b: undefined }) }).toEqual({ kept: 1 });
});

test("types every surviving key as optional-and-defined", () => {
  const out = omitUndefined({ name: "x" as string | undefined, n: 1 as number | undefined });
  expectTypeOf(out).toEqualTypeOf<{ name?: string; n?: number }>();
});

test("an `unknown` field narrows rather than staying unknown", () => {
  // `Exclude<unknown, undefined>` is still `unknown`, which cannot be passed
  // to a narrower parameter — the CLI's `body?: unknown` is the live case, and
  // it is what the `!== undefined` narrowing this replaces used to produce.
  const out = omitUndefined({ body: null as unknown });
  expectTypeOf(out).toEqualTypeOf<{ body?: NonNullable<unknown> | null }>();
  expect(out).toEqual({ body: null });
});

test("the result spreads into an exactOptionalPropertyTypes target", () => {
  const name: string | undefined = undefined;
  const greeting: string | undefined = "hi";

  // The whole point: under `exactOptionalPropertyTypes` a bare
  // `{ slug, name, greeting }` is a compile error here.
  const config: { slug: string; name?: string; greeting?: string } = {
    slug: "demo",
    ...omitUndefined({ name, greeting }),
  };

  expect(config).toEqual({ slug: "demo", greeting: "hi" });
});
