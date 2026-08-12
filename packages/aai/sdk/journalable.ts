// Copyright 2026 the AAI authors. MIT license.
/**
 * What a workflow step may RETURN — the journal's value contract, as a type and
 * as a runtime check.
 *
 * Split from `workflow.ts` (which owns the authoring API) because these two are
 * one self-contained idea with a long argument attached, and that file sits at
 * the file-length cap. Both are re-exported from `workflow.ts`, so the import
 * path an author uses is unchanged.
 */

/**
 * A value that survives the journal unchanged.
 *
 * Every step output and every run input is written as jsonb and read back on
 * the NEXT replay, so a step returning a `Date`, a `Map`, a `Set` or a method
 * hands the resume a different value than the first run produced. That is the
 * worst shape a type error can take here: the first execution is correct, the
 * divergence appears only after a crash or a `sleep`, and nothing reports it.
 *
 * Plain data maps to itself; anything whose identity is its prototype maps to
 * `never`, so `Journalable<{ at: Date }>` is `{ at: never }` — a shape nothing
 * inhabits.
 *
 * **It is not `step`'s constraint, and it cannot be.** `T extends Journalable<T>`
 * is a circular constraint (TS2313), and moving it to a second parameter
 * defaulted to `T` fails for the same reason one step removed — TypeScript checks
 * a default against its own constraint, and an unconstrained `T` does not
 * provably satisfy this. What enforces the rule instead is
 * {@link findUnjournalable}, a runtime walk the engine runs on every step output.
 * That turned out to be the stronger half anyway: it fires on the FIRST
 * execution rather than the resume, names the property path, and sees through an
 * `unknown` the type system has already lost track of.
 *
 * So this type is for an author who wants the check at compile time too — write
 * `satisfies Journalable<Shape>` on the value, or annotate the step's return.
 * Two limits when you do: a CLASS instance with only data properties is
 * accepted, because structurally it is indistinguishable from the object literal
 * it round-trips into, and `unknown` is accepted because a value that has not
 * been narrowed is not yet making a claim this could check.
 *
 * @public
 */
// `void` is deliberately absent from this first branch: a step whose function
// returns nothing falls through every clause below to `: T`, so it is accepted
// anyway, and naming it here trips `noConfusingVoidType` for no gain.
export type Journalable<T> = T extends string | number | boolean | null | undefined
  ? T
  : T extends (...args: never[]) => unknown
    ? never
    : T extends Date | RegExp | Map<unknown, unknown> | Set<unknown> | bigint | symbol
      ? never
      : T extends readonly (infer E)[]
        ? readonly Journalable<E>[]
        : T extends object
          ? { [K in keyof T]: Journalable<T[K]> }
          : T;

/**
 * Deepest structure {@link findUnjournalable} will walk before it gives up.
 *
 * A step output is small by design — bytes belong in a blob — so anything this
 * deep is a data-structure mistake, and refusing it is better than recursing
 * until the stack ends.
 */
const MAX_JOURNAL_DEPTH = 64;

/**
 * Describe the first value in `value` that the journal cannot store, or
 * `undefined` when the whole thing round-trips.
 *
 * This is the enforcement half of {@link Journalable} and the reason the type is
 * advisory. Every step output is written as jsonb and read back on the next
 * replay, so a `Date` becomes a string, a `Map` becomes `{}`, and a method
 * disappears — silently, and only on the resume, which is the worst place for a
 * value to change. The engine calls this before journaling, so the run fails on
 * its FIRST execution with the offending path named.
 *
 * `undefined` is accepted: the store writes it as `null` and the docs say so.
 * A class instance with only data properties is accepted for the reason
 * {@link Journalable} gives. Cycles are reported rather than followed — the
 * `seen` set is unwound after each branch, so an object appearing twice in a
 * DAG is fine and only a real cycle trips it (which is also `JSON.stringify`'s
 * rule).
 *
 * @public
 */
export function findUnjournalable(value: unknown, path = "the result"): string | undefined {
  return walk(value, path, 0, new Set<object>());
}

/**
 * Constructors whose instances are their prototype — none survives `JSON`.
 *
 * A table rather than a chain of `instanceof` arms so `walk` stays under the
 * cognitive-complexity cap, and so adding a type is one entry.
 */
const EXOTIC: readonly (readonly [abstract new (...args: never[]) => object, string])[] = [
  [Date, "a Date"],
  [Map, "a Map"],
  [Set, "a Set"],
  [RegExp, "a RegExp"],
];

/** The non-object problems, by `typeof`. `undefined` means "fine so far". */
function primitiveProblem(value: unknown): string | undefined {
  switch (typeof value) {
    case "function":
      return "a function";
    case "bigint":
      return "a bigint";
    case "symbol":
      return "a symbol";
    default:
      return;
  }
}

/** Recurse into an array's elements or an object's own values. */
function walkChildren(
  value: object,
  path: string,
  depth: number,
  seen: Set<object>,
): string | undefined {
  if (Array.isArray(value)) {
    for (const [index, element] of value.entries()) {
      const bad = walk(element, `${path}[${index}]`, depth + 1, seen);
      if (bad !== undefined) return bad;
    }
    return;
  }
  for (const [key, nested] of Object.entries(value)) {
    const bad = walk(nested, `${path}.${key}`, depth + 1, seen);
    if (bad !== undefined) return bad;
  }
}

function walk(value: unknown, path: string, depth: number, seen: Set<object>): string | undefined {
  if (value === null) return;
  const primitive = primitiveProblem(value);
  if (primitive !== undefined) return `${primitive} at ${path}`;
  // Everything left that is not an object is a JSON scalar: string, number,
  // boolean, undefined.
  if (typeof value !== "object") return;
  for (const [ctor, label] of EXOTIC) {
    if (value instanceof ctor) return `${label} at ${path}`;
  }
  if (depth >= MAX_JOURNAL_DEPTH) {
    return `a value nested past ${MAX_JOURNAL_DEPTH} levels at ${path}`;
  }
  if (seen.has(value)) return `a circular reference at ${path}`;
  seen.add(value);
  try {
    return walkChildren(value, path, depth, seen);
  } finally {
    // Unwound so a DAG — one object reachable by two paths — is not reported as
    // a cycle. Only a value that contains ITSELF is.
    seen.delete(value);
  }
}
