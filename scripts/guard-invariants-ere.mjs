/**
 * The POSIX-ERE fragments every `guard-invariants` line rule is composed from.
 *
 * Its own module, with no side effects, for the reason the rules are: biome's
 * `noSecrets` entropy heuristic scores a regex literal above ~20 characters as
 * a credential — a POSIX ERE full of escaped character classes looks exactly
 * like a high-entropy string — and the alternative, an `overrides` entry
 * switching the rule off, also drops the root `formatter` settings for the
 * file, so it reformatted the gate to biome's defaults while still reporting a
 * formatting error. Short named fragments cost a line each and are clearer at
 * the call site.
 *
 * Every pattern built here is handed to `git grep -E`, so it must be POSIX ERE.
 * In particular `\b` is a GNU extension that git's own matcher does not
 * implement: a pattern using one matches NOTHING and the rule reports success
 * forever. Not hypothetical — two `check-escape-hatches.mjs` patterns were dead
 * that way for months over a tree holding 110 violations, and
 * `guard-invariants-gate.test.ts` asserts against it.
 *
 * Split out of `guard-invariants-rules.mjs` when that file passed the 500-line
 * source cap. The seam is real rather than arithmetic: what is here is the
 * REGEX VOCABULARY, and it is the half a reader consults when asking "can this
 * pattern see that shape", which is the question every gap in this gate's
 * history has turned on.
 */

// Named down to the character class — one more level of decomposition than
// reads naturally, for the `noSecrets` reason in the module doc above.

/** Characters a JavaScript identifier may start with. */
export const ID_HEAD = "A-Za-z_$";
/** Characters a JavaScript identifier may continue with. */
const ID_TAIL = "A-Za-z0-9_$";
/** A JavaScript identifier. */
export const IDENT = `[${ID_HEAD}][${ID_TAIL}]*`;
/** A dotted member path, e.g. `state.entries`. */
export const MEMBER = `[${ID_HEAD}][${ID_TAIL}.]*`;
/** A parenthesised argument list with no nested parens. */
export const ARGS = "\\([^)]*\\)";
/** A `.get(…)` call — the read half of both hand-rolled-map patterns. */
export const MAP_GET = `\\.get${ARGS}`;
/** An `on*` handler name — the observer-callback naming convention. */
export const ON_NAME = "on[A-Z][A-Za-z0-9]*";
/** ERE for a literal `&&`. */
export const AND = " && ";
/** ERE for a literal `||` — the pipe is alternation, so both halves escape. */
export const OR = " \\|\\| ";
/** `typeof X === "object"`, the positive half of rule 17. */
export const TYPEOF_OBJECT = `typeof ${MEMBER} === "object"`;
/** `typeof X !== "object"`, the same test written as a guard clause. */
export const NOT_TYPEOF_OBJECT = `typeof ${MEMBER} !== "object"`;
/** `X !== null`, the other positive half. */
export const NOT_NULL = `${MEMBER} !== null`;
/** `X === null`, the guard-clause half. */
export const IS_NULL = `${MEMBER} === null`;
/** The spread of a parenthesised expression — the head of rule 2's three shapes. */
export const SPREAD_OPEN = "\\.\\.\\.\\([^)]*";
/** A literal `"?"` argument, escaped for ERE. */
const QUERY_ARG = '\\("\\?"\\)';
/** A `.split("?")` call — hand-cutting a request target into path and query. */
export const SPLIT_ON_QUERY = `\\.split${QUERY_ARG}`;
/**
 * A `setTimeout` delay argument that is NOT the literal 0 — a digit 1-9, the head
 * of an identifier, or the open paren of an expression. This is the whole
 * difference between rule 19 (a sleep) and rule 4 (a yield), so it has to be
 * exact: `, 0)` must fall to rule 4, whose remedy names which of the two yields
 * the caller meant.
 *
 * The paren is here because omitting it under-matches SILENTLY, which is the
 * failure this whole gate exists to prevent — `setTimeout(resolve, (8 - i) * 20)`
 * is as much a sleep as `setTimeout(resolve, 160)`, and the first draft of this
 * fragment could not see one.
 */
const NONZERO_DELAY = `[1-9(${ID_HEAD}]`;
/**
 * `new Promise`, with an OPTIONAL type argument before the paren.
 *
 * Rules 4 and 19 both required a LITERAL `(` immediately after `new Promise`,
 * so `new Promise<"hung">((r) => setTimeout(…))` evaded both — five live
 * occurrences across `aai`, `aai-ui` and the two fuzz harnesses. Rule 4's own
 * comment celebrates fixing a draft that "reported 0 against five real
 * occurrences"; the fixed version reported 0 against five DIFFERENT ones, for
 * an adjacent reason. Fifth time a substring guard over a language with syntax
 * has been paid for here.
 */
const TYPE_ARG = "(<[^>]*>)?";
const NEW_PROMISE = `new Promise${TYPE_ARG}\\(`;
/** Anything but a comma or a paren — `setTimeout`'s argument, flat. */
const NO_COMMA = "[^,)]*";
/**
 * `setTimeout`'s FIRST argument: anything but a comma, with balanced parens
 * allowed one level deep.
 *
 * A flat `[^,)]*` cannot cross `() => r("hung")`, so
 * `new Promise<"hung">((r) => setTimeout(() => r("hung"), 5000))` — a real
 * five-second sleep in both fuzz harnesses — was invisible to rule 19. A plain
 * `.*` would cross it and much more: `new Promise((r) => setTimeout(r, 0));
 * doSomething(x, y)` would then backtrack to the LAST comma on the line and
 * report a zero-length yield as a sleep. This is the middle, and it keeps rule
 * 19's whole negative set (the two-parameter executor included) spared.
 */
const CALLBACK_ARG = `${NO_COMMA}(\\([^)]*\\)${NO_COMMA})*`;
/**
 * A hand-rolled timer promise with a nonzero delay.
 *
 * `.*` before `setTimeout` for rule 4's documented reason — the executor's own
 * parameter list closes a paren, so a negated-paren class matches nothing.
 */
export const SLEEP_PROMISE = `${NEW_PROMISE}.*setTimeout\\(${CALLBACK_ARG}, ?${NONZERO_DELAY}`;
/** A hand-rolled timer promise with a ZERO delay — rule 4's shape. */
export const TICK_PROMISE = `${NEW_PROMISE}.*setTimeout\\(.*, ?0\\)`;
/**
 * The OTHER zero-length yield. `setImmediate` takes no delay at all, so it can
 * only ever be rule 4's yield and never rule 19's sleep — which is why it is
 * spliced into one rule and not both.
 *
 * Eight live occurrences that neither timer rule could see, in `aai-server`'s
 * lock and auth suites, the s2s fuzz harness, and `host/tool-executor.ts` — the
 * last of which is SHIPPED source reaching for it deliberately, and so is a
 * baselined entry rather than a fix.
 */
export const IMMEDIATE_PROMISE = `${NEW_PROMISE}.*setImmediate`;
/** A single-line `Promise.race` with a timer in it — rule 3's original shape. */
export const RACE_TIMEOUT = "Promise\\.race\\(.*setTimeout";
/**
 * A `Promise.race(` whose argument list continues on the NEXT line.
 *
 * `git grep` is line-based and rule 3's pattern was line-anchored, so the
 * multi-line form Biome actually produces —
 *
 *     const outcome = await Promise.race([
 *       work.then(() => "done"),
 *       new Promise<"hung">((r) => setTimeout(() => r("hung"), 5000)),
 *     ]);
 *
 * — was invisible, and the gate-under-the-gate fed the rule a SINGLE-LINE
 * positive sample, so the guard passed over the exact gap it exists to find.
 * This alternative is deliberately CONSERVATIVE: it cannot see whether a timer
 * is among the elements, so a timer-free multi-line race matches too and is a
 * legitimate baseline entry (there is one, `aai-server/guest-readiness.ts`).
 * Over-reporting a race is the cheap error; every finding in this family is a
 * guard that under-reports silently.
 */
export const RACE_CONTINUES = "Promise\\.race\\(\\[?$";
/**
 * The aliased `node:timers/promises` sleep — the one timer `vi.useFakeTimers()`
 * cannot drive. Matched on the aliased IMPORT rather than the module specifier,
 * so a future caller wanting `scheduler.wait` from the same module is not caught
 * by a rule that has nothing to say about it.
 */
export const TIMERS_PROMISES = `setTimeout as ${IDENT}`;
/** Line start plus indentation: where a property or method is DECLARED. */
export const AT_LINE_START = "^ *";
/**
 * A property or method DECLARATION, as opposed to a call of one.
 *
 * `onFoo:` (a property), or `onFoo(args):`/`onFoo(args) {` (a signature or a
 * method). Deliberately NOT `onFoo();`, which is an ordinary call of a local
 * function — `_timer.ts`'s `onWake()` and `_pipeline-fuzz-model.ts`'s
 * `onReplyCompleted()` are both that, and neither declares a surface.
 */
export const DECLARES = `(\\?)?(:|${ARGS} *(:|\\{))`;
