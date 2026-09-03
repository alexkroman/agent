// Copyright 2026 the AAI authors. MIT license.
/**
 * The repo's one always-on oracle.
 *
 * ## What it is for
 *
 * Nothing in this codebase fires unless a test walks to a state deliberately and
 * checks it by hand. A review of ~38 defects fixed over one 48-hour window found
 * that every one of them lived at a boundary the test suite owned BOTH sides of,
 * and that the suite is therefore almost entirely CONFIRMATORY: it pins fixes
 * after the fact and has very little capacity to discover a bug nobody has hit.
 *
 * An invariant inverts that economics. State the property once, at the place that
 * has to maintain it, and every one of the ~700 existing test files, every load
 * run, every `aai dev` session and production itself becomes a detector for it at
 * zero marginal cost — including the paths nobody wrote a test for, which is
 * where the defects were.
 *
 * ## It THROWS, and it is never a log
 *
 * A logged invariant is a silent one: it goes to a stream nobody reads, on a
 * request that returned a wrong answer anyway. Every violation here is a bug in
 * this process by construction — the conditions are ours to maintain, not a
 * peer's to satisfy, and a peer's input is validated by a schema rather than by
 * this. So the failure is loud and NAMED, and the name is what a reader searches
 * for; {@link InvariantViolation} carries it separately from the message.
 *
 * The risk this accepts is stated rather than hidden: an invariant that is WRONG
 * turns a working path into an outage. The mitigation is not a log-instead-of-
 * throw switch, which would give up the whole guarantee for the whole fleet on
 * the strength of one bad statement. It is that a condition goes in here only
 * when it is a property this code establishes and nothing else can perturb.
 *
 * ## There is deliberately NO sampling
 *
 * The obvious design is a thunk, checked always in dev and on a fraction of calls
 * in production, so an expensive condition can be left on. Every invariant stated
 * against this seam today is O(1) — a comparison between two numbers a caller is
 * already holding — so the thunk would allocate a closure per call to avoid work
 * that costs less than the closure.
 *
 * More to the point, a sampling rate nothing needs is a knob nobody tunes and a
 * code path nobody exercises, which is the shape this repo has been bitten by
 * repeatedly: a `.size-limit.json` no script read, an `ls-lint` config no
 * pipeline ran, root coverage thresholds nothing evaluated. Sampling belongs with
 * its first O(n) caller — as `invariantsCostly()` guarding the expensive read —
 * not before one exists.
 */

/**
 * A broken invariant.
 *
 * Its own class so a caller can tell one from a `TypeError` — a boundary that
 * maps thrown values to statuses must never classify this as a peer's fault, and
 * an error-classification test needs to be able to say "this one is ours".
 */
export class InvariantViolation extends Error {
  /** The invariant's name, searchable on its own. */
  readonly invariant: string;

  constructor(name: string, message: string) {
    super(message);
    this.name = "InvariantViolation";
    this.invariant = name;
  }
}

/** Extra context for a violation, built ONLY when one happens. */
export type InvariantDetail = () => Record<string, unknown>;

/**
 * Throw unless `condition` holds.
 *
 * `name` is a stable, searchable identifier for the property — `"page.tail"`,
 * not a sentence. `detail` is a THUNK: it runs only on the failing path, so
 * building a rich message costs nothing while the invariant holds, which is what
 * lets a violation report the actual numbers rather than just the claim.
 *
 * The `asserts` return type narrows for the caller, and is honest here precisely
 * BECAUSE there is no sampling: the check really did run.
 *
 * @example
 * ```ts no-check
 * invariant(tail >= events.length, "page.tail", () => ({ tail, got: events.length }));
 * ```
 */
export function invariant(
  condition: boolean,
  name: string,
  detail?: InvariantDetail,
): asserts condition {
  if (condition) return;
  throw new InvariantViolation(name, describe(name, detail));
}

/**
 * The message a violation carries.
 *
 * Separate so the `detail` thunk's own failure cannot mask the violation: a
 * caller building context out of the very state that just went inconsistent is
 * the likeliest place for a second throw, and reporting a `TypeError` from the
 * message builder in place of the broken invariant would lose the finding
 * entirely.
 */
function describe(name: string, detail?: InvariantDetail): string {
  if (detail === undefined) return `invariant ${name} violated`;
  try {
    return `invariant ${name} violated: ${JSON.stringify(detail())}`;
  } catch {
    return `invariant ${name} violated (detail unavailable)`;
  }
}

/** Is `value` a broken invariant of ours, however deeply wrapped? */
export function isInvariantViolation(value: unknown): value is InvariantViolation {
  for (let cur: unknown = value, hops = 0; cur !== undefined && hops < 8; hops += 1) {
    if (cur instanceof InvariantViolation) return true;
    cur = cur instanceof Error ? cur.cause : undefined;
  }
  return false;
}
