// Copyright 2026 the AAI authors. MIT license.
/**
 * The three shapes a tool body actually wants from a random number, over a
 * SOURCE it can be handed rather than the global.
 *
 * A tool that calls `Math.random()` directly cannot be tested. Not "is
 * awkward to test" — a spec asserting on what it produced has no way to say
 * which value it should have produced, so the assertion becomes a range check
 * or the test is not written. Seven shipped templates reached for the global in
 * ten places (dice, a shuffle, an ETA jitter, an order number, a reference
 * code), and exactly one of them — `word-wrangler`, which threads
 * `random: () => number = Math.random` through as a parameter — was covered.
 *
 * {@link ToolContext.random} is the seam that generalizes that one template's
 * fix: production hands the tool `Math.random`, `createToolContext({ random })`
 * hands it whatever the spec says. **The functions here all take a source as
 * their last argument**, defaulting to `Math.random` so a call site that has no
 * context (a seed script, a pure helper) still reads well.
 *
 * A workflow body wants `ctx.random()` from `WorkflowContext` instead — that
 * one is JOURNALED, so a replay re-derives the same value, which is a stronger
 * promise than this makes and a different mechanism. `guard-invariants`
 * rule 30 already refuses the global in a workflow body.
 *
 * **None of this is cryptographic.** `Math.random` is not, a spec's stub
 * certainly is not, and nothing here whitens or reseeds. A token, a session id
 * or anything an attacker benefits from guessing wants
 * `crypto.getRandomValues`.
 *
 * @module
 */

/**
 * A source of uniform floats in `[0, 1)` — `Math.random`'s contract, and the
 * one a caller substitutes.
 *
 * @public
 */
export type RandomSource = () => number;

/**
 * A {@link RandomSource} that produces the same sequence every run, from a seed.
 *
 * The source `createToolContext` defaults to, and the reason a spec that FORGOT
 * to stub randomness is still deterministic rather than flaky. It is also what
 * a seed script or a demo wants: a catalog shuffled the same way on every boot
 * is reviewable, where one shuffled by `Math.random` makes every diff of its
 * output noise.
 *
 * **A constant function is not a substitute**, which is the trap this exists to
 * remove. `() => 0.5` looks like the simplest deterministic source and is a
 * degenerate one: every draw is identical, so {@link shuffled} returns a fixed
 * non-random permutation and {@link mintCode} re-draws the same code until it
 * gives up. Sequences that VARY reproducibly are what tests and seeds both
 * want.
 *
 * mulberry32 — a 32-bit generator chosen for being short enough to read and
 * having no state beyond one integer. Not cryptographic, and its period is far
 * below what a simulation would need; it is here so that "deterministic" and
 * "varied" can both be true of a spec.
 *
 * @example
 * ```ts
 * import { createSeededRandom, shuffled } from "@alexkroman1/aai";
 *
 * const random = createSeededRandom(42);
 * shuffled(["a", "b", "c"], random); // the same order on every run
 * ```
 *
 * @public
 */
export function createSeededRandom(seed: number): RandomSource {
  // `>>> 0` keeps the state an unsigned 32-bit integer through every step;
  // without it the shifts below start operating on a negative number and the
  // sequence degenerates.
  let state = Math.trunc(seed) >>> 0;
  return () => {
    state = (state + 0x6d_2b_79_f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/**
 * A whole number in `[0, maxExclusive)`.
 *
 * The floor-and-multiply that every call site would otherwise write, in the one
 * place its two edges can be got right: a `maxExclusive` of `0` or less has no
 * value to return and answers `0` rather than `-1` or `NaN`, and a source that
 * returns exactly `1` — outside `Math.random`'s contract, but well inside what
 * a hand-written stub does — is clamped rather than allowed to index one past
 * the end.
 *
 * @example
 * ```ts
 * import { randomInt } from "@alexkroman1/aai";
 *
 * randomInt(6); // 0..5
 * randomInt(6, () => 0.5); // 3
 * ```
 *
 * @public
 */
export function randomInt(maxExclusive: number, random: RandomSource = Math.random): number {
  if (!Number.isFinite(maxExclusive) || maxExclusive <= 0) return 0;
  const n = Math.floor(random() * maxExclusive);
  return Math.min(Math.max(n, 0), Math.floor(maxExclusive) - 1);
}

/**
 * One item, uniformly.
 *
 * `undefined` for an empty list rather than a throw, so the empty case is
 * narrowed by the type at the call site — which is where a caller knows
 * whether "nothing to pick" is a failure or a legal answer. Under
 * `noUncheckedIndexedAccess` the hand-written `items[Math.floor(...)]` this
 * replaces was `T | undefined` anyway and was routinely asserted away with
 * `as T`, which is the same reachable `undefined` with the check removed.
 *
 * @example
 * ```ts
 * import { pickOne } from "@alexkroman1/aai";
 *
 * pickOne(["north", "south"], () => 0); // "north"
 * pickOne([]); // undefined
 * ```
 *
 * @public
 */
export function pickOne<T>(items: readonly T[], random: RandomSource = Math.random): T | undefined {
  if (items.length === 0) return undefined;
  return items[randomInt(items.length, random)];
}

/**
 * A NEW array holding the same items in a random order.
 *
 * A Fisher-Yates walk, which is worth having in one place because the
 * plausible-looking alternatives are subtly not uniform: `sort(() => Math.random() - 0.5)`
 * produces a distribution that depends on the engine's sort algorithm, and a
 * loop drawing `j` from the WHOLE range rather than `[0, i]` is the classic
 * biased variant that still looks shuffled.
 *
 * Copies rather than mutating — the input is `readonly`, and a shuffle applied
 * in place to a slot's frozen value is a `TypeError` at runtime.
 *
 * @example
 * ```ts
 * import { shuffled } from "@alexkroman1/aai";
 *
 * shuffled([1, 2, 3], () => 0); // a new array; the input is untouched
 * ```
 *
 * @public
 */
export function shuffled<T>(items: readonly T[], random: RandomSource = Math.random): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = randomInt(i + 1, random);
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}
