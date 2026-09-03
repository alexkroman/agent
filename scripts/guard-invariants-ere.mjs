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
 *
 * ## What is NOT here any more
 *
 * The fifteen fragments the TIMING rules were built from are gone, with the
 * rules: 3, 4, 19, 21, 23 and 31 are node rules now
 * (`guard-invariants-nodes.mjs`, over a real parse). That family is where every
 * one of the gaps above was found, and the fragments record why — a delay class
 * widened twice, a callback argument that had to allow "balanced parens one
 * level deep", a `Promise.race` alternative that deliberately over-reported
 * because a line cannot see inside brackets. None of those is expressible as a
 * character class, which is the whole argument.
 *
 * What stays is what grep is genuinely good at: a rule about a NAME or about a
 * literal string, where the pattern has no syntax to cross. Those also keep one
 * capability the parse gives up — they see code EMBEDDED IN A TEMPLATE LITERAL,
 * which several fixtures here write and later execute.
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
/**
 * A dotted member path that may use OPTIONAL CHAINING — `startOpts?.logContext`.
 *
 * Distinct from `MEMBER` because rule 22's whole discriminator is that the
 * condition contains no operator, and `?.` is the one punctuation a bare
 * truthiness test is allowed to carry. Folding it into `MEMBER` would let rule
 * 17's patterns match a `typeof a?.b === "object"` they were never measured
 * against.
 */
const MEMBER_Q = `[${ID_HEAD}][${ID_TAIL}.?]*`;
/**
 * A BARE truthiness test: a member path, optionally negated, and nothing else.
 *
 * The absence of an operator is the entire point. `!==`, `===`, `<`, `.length`
 * and `in` are all excluded by the character class, which is what keeps rule 22
 * off rule 2's `!== undefined` forms (a different remedy), off the compound
 * conditions rule 2 documents as deliberately unmatched
 * (`opts.languages !== undefined && opts.languages.length > 0`), and off
 * `"url" in opts.bundle` — verified against all seven shapes.
 */
const TRUTHY = `!?${MEMBER_Q}`;
/**
 * A conditional spread guarded by a bare TRUTHINESS test, either spelling:
 * `...(x && {` or `...(x ? {`.
 *
 * The trailing `\{` carries the same weight it does in rule 2 — it is what
 * keeps an ARRAY spread out (`...(placed ? [item] : [])`), which
 * `omitUndefined` cannot express at all.
 *
 * Both spellings require the brace on the SAME LINE, so the multi-line form
 * whose `?` wraps to the next line is not seen. That is deliberate and
 * conservative rather than complete: an alternative matching a bare `...(ident$`
 * would also match every multi-line spread of a plain call
 * (`...(await mapInBatches(`), and rule 3's history is the argument for
 * over-reporting only where the over-report is still a real finding. Measured:
 * 15 multi-line spreads exist, none of them this shape.
 */
export const SPREAD_TRUTHY = `\\.\\.\\.\\(${TRUTHY} (&&|\\?) \\{`;
/** A literal `"?"` argument, escaped for ERE. */
const QUERY_ARG = '\\("\\?"\\)';
/** A `.split("?")` call — hand-cutting a request target into path and query. */
export const SPLIT_ON_QUERY = `\\.split${QUERY_ARG}`;
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

/**
 * The `/step` callers that reach a remote service and have a `*Classified`
 * sibling on `@alexkroman1/aai/step-errors` — rule 26's alternation.
 *
 * Named here rather than inline for this module's founding reason, and BUILT
 * from an array for the same one: spelled out as a single literal, the
 * alternation is long enough that biome's `noSecrets` entropy heuristic scores
 * it as a credential. One name per element keeps every literal short.
 *
 * `stepFetch` is deliberately ABSENT. Its sibling is `stepFetchOk`, whose value
 * is the non-2xx branch rather than the verdict, and a raw `stepFetch` whose
 * caller reads the status itself is the ordinary correct spelling — see
 * `recap-workflow`'s `discardTranscript`, where a 404 is success.
 */
export const CLASSIFIABLE_STEP_CALLS = [
  "stepGenerate",
  "stepGenerateJson",
  "stepTranscribeSync",
  "stepTranscribeUpload",
  "stepTranscribeSubmit",
  "stepTranscribePoll",
  "sendToChannel",
].join("|");

/**
 * An explicit INVOCATION of a disposal symbol — `warm[Symbol.asyncDispose]()`.
 *
 * The leading identifier character is what tells a CALL from a DECLARATION, and
 * it carries the whole rule: `async [Symbol.asyncDispose]() {`,
 * `[Symbol.dispose](): void;` and `[Symbol.asyncDispose]: async () => {` are all
 * preceded by whitespace, so none of them match — which they must not, since
 * declaring the protocol is the thing rule 27 wants MORE of. The trailing paren
 * is the other half: `expect(core[Symbol.dispose]).not.toHaveBeenCalled()`
 * references the method without calling it and is not a teardown.
 *
 * Both symbols and both capitalizations in one fragment, because the sync and
 * async halves have identical remedies (`using` / `await using`) and a rule
 * spelled for one of them is a rule the other walks past — the failure mode
 * this whole gate is a monument to.
 */
export const DISPOSE_CALL = `[${ID_TAIL}]\\[Symbol\\.(async)?[Dd]ispose\\]\\(`;

/**
 * Not preceded by an identifier character — POSIX ERE's stand-in for `\\b`,
 * which git's matcher does not implement.
 *
 * What keeps rule 26 off the `*Classified` wrappers is the other end (their
 * names are the banned name plus a suffix, so the `\\(` never follows); this end
 * is what keeps it off `myStepGenerate(` and off a property access.
 */
export const NOT_IDENT_BEFORE = "(^|[^A-Za-z])";

/**
 * Rule 28: an argv scan that cannot fail.
 *
 * The three spellings the gate scripts used, matched by the METHOD rather than
 * by the flag they look for, because the flag is the part that varies. Left out
 * deliberately: `process.argv[1]` (a main-module guard), `process.argv.slice(2)`
 * (handing the arguments to a parser, which is the remedy), and any method on a
 * LOCAL `argv` — `valueReader` and `parseLeadingFlags` in `scripts/_args.mjs`
 * are built out of exactly those, and a pattern that could not tell them apart
 * would ban its own remedy.
 *
 * Composed from two fragments rather than written out, for the reason this whole
 * module exists: spelled end to end it is a long enough literal that biome's
 * `noSecrets` entropy heuristic scores it as a credential, and the remedy for
 * that is composition rather than a lint suppression — which `check:hatches`
 * counts as an escape hatch even when, as here, it appears only in prose.
 */
const ARGV = "process\\.argv\\.";
/**
 * The three read METHODS, as identifiers rather than one alternation literal.
 *
 * Written out as `"(includes|indexOf|find)"` this trips `noSecrets` too — a
 * pipe-separated run of camelCase words is high entropy by that heuristic. A
 * joined array is the same pattern, and each element is an ordinary word.
 */
const SCANNING_METHODS = ["includes", "indexOf", "find"];
export const ARGV_SCAN = `${ARGV}(${SCANNING_METHODS.join("|")})\\(`;
