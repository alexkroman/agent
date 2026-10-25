// Copyright 2026 the AAI authors. MIT license.
import { expect, test } from "vitest";
import { isThenable } from "./is-thenable.ts";

/** An object answering a callable `then` without being this realm's `Promise`. */
function foreignThenable(): object {
  return new Proxy(
    {},
    { get: (_target, property) => (property === "then" ? () => undefined : undefined) },
  );
}

test("recognises a thenable STRUCTURALLY — a foreign-realm promise included", () => {
  expect(isThenable(Promise.resolve(1))).toBe(true);
  expect(isThenable((async () => 1)())).toBe(true);
  // What a bundle with its own Promise realm hands back: not `instanceof`
  // this realm's Promise, still a thenable.
  const foreign = foreignThenable();
  expect(foreign instanceof Promise).toBe(false);
  expect(isThenable(foreign)).toBe(true);
});

test("and nothing else", () => {
  expect(isThenable(1)).toBe(false);
  expect(isThenable("then")).toBe(false);
  expect(isThenable(null)).toBe(false);
  expect(isThenable(undefined)).toBe(false);
  // A `then` that is not callable is data, not a promise.
  expect(isThenable(JSON.parse('{"then":"soon"}'))).toBe(false);
  expect(isThenable(() => undefined)).toBe(false);
});
