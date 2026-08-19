/**
 * The SHAPE rules — 2, 17 and 18. Each replaces an open-coded expression with a
 * primitive the repo already publishes.
 *
 * Grouped because all three are about a value's shape being re-derived at a
 * call site rather than asked for once, and because all three shipped a
 * one-polarity pattern first and had to be widened to the spelling the code
 * actually uses (rule 2 saw one of three spread forms; rule 17 saw the positive
 * conjunction and missed the negated disjunction, grading 1 of 21).
 *
 * Rule IDs are STABLE across the split from `guard-invariants-rules.mjs`.
 */

import {
  AND,
  IS_NULL,
  NOT_NULL,
  NOT_TYPEOF_OBJECT,
  OR,
  SPLIT_ON_QUERY,
  SPREAD_OPEN,
  SPREAD_TRUTHY,
  TYPEOF_OBJECT,
} from "./guard-invariants-ere.mjs";
import { SOURCE_PATHSPECS } from "./guard-invariants-scopes.mjs";

/** @type {import("./guard-invariants-rules.mjs").LineRule[]} */
export const SHAPE_RULES = [
  {
    id: 2,
    key: "rule2_spreadTernary",
    label: "spread-ternary object composition",
    // THREE spellings of one idiom, not one. The original pattern required
    // `!== undefined ?`, so the two other ways the repo writes the same
    // conditional spread scored zero and were free to spread: the INVERTED
    // ternary (`...(x === undefined ? {} : { x })`) and the `&&` form
    // (`...(x !== undefined && { x })`). Both were in the tree in quantity, in
    // sdk, host, transports, guest, server and ui, while the rule reported three.
    //
    // The trailing `{}` / `{` is what keeps this honest rather than merely
    // wider. `...(opts.system === undefined ? [] : [{ role: "system", … }])`
    // spreads an ARRAY, which `omitUndefined` cannot express at all, and
    // `...(opts.languages !== undefined && opts.languages.length > 0 ? … )` is a
    // compound condition rather than a presence test. Neither matches, and
    // neither should.
    //
    // **`undefined` is a BOUNDARY, not a fourth spelling waiting to be added.**
    // All three patterns here test PRESENCE, and `omitUndefined` is exactly that
    // test, so every match has a mechanical rewrite that cannot change
    // behaviour. A truthiness guard does not: `...(x && { x })` also drops `""`,
    // `0` and `false`, so pointing this rule's remedy at one would have the gate
    // recommend a behaviour change. That is why the truthiness family — 147
    // occurrences, measured, i.e. an order of magnitude more than this rule's 13
    // — is RULE 22 with its own three-way remedy rather than a widening here.
    // Widening was proposed and rejected; do not re-propose it without reading
    // rule 22 first.
    re: `${SPREAD_OPEN} !== undefined \\?|${SPREAD_OPEN} === undefined \\? \\{\\}|${SPREAD_OPEN} !== undefined && \\{`,
    paths: SOURCE_PATHSPECS,
    skipComments: true,
    remedy:
      "Use `...omitUndefined({ x })` from @alexkroman1/aai/utils.\n" +
      "All three spellings mean the same thing and this rule sees all three —\n" +
      "`x !== undefined ? { x } : {}`, `x === undefined ? {} : { x }`, and\n" +
      "`x !== undefined && { x }`.\n" +
      "Baseline an occurrence only when the GUARD IS NOT THE VALUE —\n" +
      "`params.port !== undefined ? { AAI_GUEST_PORT: String(params.port) }`\n" +
      'would stringify undefined into "undefined", and\n' +
      "`opts.mode !== undefined ? { mode: 0o700 }` sets a different value from\n" +
      "the one it tests.\n" +
      "A frozen `contracts/compatibility/**` example is the other legitimate\n" +
      "entry: those are authoring examples written the way an epoch WAS\n" +
      "authored, and editing one destroys the check it exists to be.",
  },
  {
    id: 22,
    key: "rule22_truthySpread",
    label: "truthiness-guarded conditional spread",
    // Rule 2's sibling, and the FIRST rule here seeded as DEBT rather than as a
    // short list of legitimate exceptions. Its baseline opens at 147 occurrences
    // across 77 files, which is the same order as the escape-hatch ratchet's
    // `as unknown as` (83 across 59) and 7x this gate's largest existing entry.
    // That is stated rather than hidden because it changes how an entry here
    // reads: for every other rule a baselined line is a decision someone
    // defends, and for this one it is a line nobody has looked at yet. The goal
    // is zero.
    //
    // Seeding is the cheap half of the alternative. `--update` refuses to raise,
    // so the only other way to introduce this rule is to convert all 147 sites
    // in one commit — and a conversion is NOT mechanical here (see the remedy),
    // so that commit would be 147 behaviour judgements landing together. Counting
    // stops the growth today, which is the whole finding: `as never` went 98 ->
    // 110 in three days while uncounted, and this family is bigger than that was.
    //
    // Why it is not folded into rule 2: same shape, different remedy. Read the
    // `undefined`-is-a-boundary paragraph on rule 2.
    re: SPREAD_TRUTHY,
    paths: SOURCE_PATHSPECS,
    skipComments: true,
    samples: {
      matches: [
        "    ...(auth && { auth }),",
        "    ...(notifier ? { notifier } : {}),",
        // Optional chaining is the one punctuation a bare truthiness test may
        // carry, which is why `MEMBER_Q` exists apart from `MEMBER`.
        "      ...(startOpts?.onOpen ? { onOpen: startOpts.onOpen } : {}),",
        // The brace-at-end-of-line form Biome emits for a long property list.
        "    ...(overrides.studioSessionRegistry && {",
      ],
      ignores: [
        // Rule 2's three shapes: a different rule with an exact remedy.
        "    ...(x !== undefined ? { x } : {}),",
        "    ...(x === undefined ? {} : { x }),",
        "    ...(x !== undefined && { x }),",
        // A comparison is not a bare truthiness test.
        "    ...(failures.length > 0 && { failures }),",
        '    ...(init.body != null && { "Content-Type": "application/json" }),',
        '    ...("url" in opts.bundle ? { url: opts.bundle.url } : {}),',
        // An ARRAY spread, which `omitUndefined` cannot express — the trailing
        // brace is what excludes it, exactly as in rule 2.
        "    ...(placed ? [item] : []),",
      ],
    },
    remedy:
      "A truthiness guard on a conditional spread is THREE different\n" +
      "situations wearing one spelling, and which one it is decides the fix:\n\n" +
      "1. The value cannot be falsy-but-defined — a function, an object, a\n" +
      "   validated slug. Then the guard is a presence test written the loose\n" +
      "   way, and `...omitUndefined({ x })` is an exact rewrite. Most of the\n" +
      "   seeded occurrences are this one.\n" +
      '2. Dropping `""` / `0` / `false` is DELIBERATE. Then the truthiness is\n' +
      "   load-bearing, `omitUndefined` would change behaviour, and the\n" +
      "   occurrence stays — baseline it with a comment saying which falsy\n" +
      "   value it is filtering and why.\n" +
      "3. The GUARD IS NOT THE VALUE — `...(opts.allowPreviewSlug ? {\n" +
      "   allowPreviewSlug: true } : {})` sets a literal, and\n" +
      '   `...(body ? { body, duplex: "half" } : {})` adds a second key.\n' +
      "   `omitUndefined` cannot express either; baseline with a comment, the\n" +
      "   same way rule 2 documents its own guard-is-not-the-value entries.\n" +
      "4. It is a TWO-WAY CHOICE, not an optional key: `...(opts.slug ? {} :\n" +
      "   { retry: 0 })` spreads on the FALSY side, and `...(error ? { error }\n" +
      "   : { result })` spreads a different object in each branch. Neither is\n" +
      "   an optional-key spread and `omitUndefined` has nothing to say about\n" +
      "   either; both are reported because the else branch is not something a\n" +
      "   line-based pattern can inspect — rule 2 over-reports the same shape\n" +
      "   for the same reason. Baseline with a comment.\n\n" +
      "Do NOT convert by pattern-matching the spelling. The whole reason this\n" +
      "is a separate rule from rule 2 is that rule 2's rewrite is mechanical\n" +
      "and this one's is a judgement about the value's type.\n\n" +
      "A multi-line spread whose `?` wraps to the next line is NOT reported —\n" +
      "`git grep` is line-based, and the alternative that would catch it also\n" +
      "catches every wrapped spread of a plain call. Measured: 15 multi-line\n" +
      "spreads exist and none is this shape.",
  },
  {
    id: 17,
    key: "rule17_openCodedRecordGuard",
    label: "open-coded record guard",
    // FOUR spellings: the positive conjunction in both operand orders, and the
    // NEGATED DISJUNCTION in both — `if (typeof v !== "object" || v === null)
    // return null;` followed by a cast, which is how a guard clause is written
    // and which is how this codebase actually writes it.
    //
    // The two-way version of this pattern graded 1 occurrence out of 21 and
    // printed a checkmark. Its own comment argued that a one-way pattern "would
    // have left a quarter of them representable"; leaving the negated form out
    // left 95%. De Morgan is not a different check, it is the same check read
    // from the failing side, and the cast that follows it is the same cost —
    // which is the thing the rule is actually about.
    //
    // The null half is still what makes this a duck-type rather than a narrow.
    // `typeof addr === "object" && addr` (an `AddressInfo | string | null` from
    // `server.address()`) and `typeof root === "object"` (a declared union in
    // `studio-build.ts`) are ordinary union narrowing over a type the compiler
    // already knows, and none of the four alternatives matches either — which is
    // the whole reason this rule can run without an allowlist of them.
    re:
      `${TYPEOF_OBJECT}${AND}${NOT_NULL}|${NOT_NULL}${AND}${TYPEOF_OBJECT}|` +
      `${NOT_TYPEOF_OBJECT}${OR}${IS_NULL}|${IS_NULL}${OR}${NOT_TYPEOF_OBJECT}`,
    paths: SOURCE_PATHSPECS,
    skipComments: true,
    remedy:
      // Not "Use `isRecord(value)` from …", which reads better and trips
      // `noSecrets`: the heuristic scores the whole literal, and the call's
      // parens and the scoped path together push it over. The module doc's
      // point 2 is about the REGEXES; it applies to remedy prose too.
      "Use the `isRecord` guard from @alexkroman1/aai/utils.\n" +
      "\n" +
      "The narrowing is the point, not the keystrokes. This spelling narrows to\n" +
      "`object`, on which every field read is an error — so all twelve sites it\n" +
      "replaced paid for the check a SECOND time with a cast\n" +
      "(`(v as { kind?: unknown }).kind`, `(v as PromiseLike<unknown>).then`).\n" +
      "A cast asserts what the check was supposed to establish and stops\n" +
      "reporting the moment the shape moves. `isRecord` returns\n" +
      "`value is Record<string, unknown>`, so the cast goes with it.\n" +
      "\n" +
      "Note it EXCLUDES arrays, because every caller here reads a named field.\n" +
      'For "any non-null object, arrays included", write the two comparisons\n' +
      "inline and baseline it — `sdk/standard-schema.ts` narrows a declared\n" +
      "union that way and is the entry to copy.\n" +
      "\n" +
      "The guard is defined in a LEAF module so that anything may import it;\n" +
      "if it looks unreachable from where you are, check that before writing\n" +
      "the comparisons out — an import cycle was the historical reason nine\n" +
      "of these existed inside this package at once.\n" +
      "\n" +
      "A `scripts/*.mjs` gate is the one place the remedy genuinely does not\n" +
      "apply: plain node with no build step cannot import the SDK's TypeScript,\n" +
      "and a second copy of the guard living in `scripts/` would be the very\n" +
      "duplication this rule exists to stop. Those are baselined, one line each.",
  },
  {
    id: 18,
    key: "rule18_splitOnQuestionMark",
    label: "hand-split request target",
    // The CALL, not the indexing, so both halves are caught with one pattern —
    // `[0]` (the path) and `[1]` (the query) were each open-coded, and the
    // second is the one that is wrong.
    re: `${SPLIT_ON_QUERY}`,
    paths: SOURCE_PATHSPECS,
    skipComments: true,
    remedy:
      "Use requestPath or requestQuery from @alexkroman1/aai/internal.\n" +
      "\n" +
      "Taking index 1 of the split keeps only the segment BETWEEN the first\n" +
      "and second question mark, so a query value carrying a literal one is\n" +
      "silently truncated — a namespace of `a?b` reads as `a`. That was the\n" +
      "spelling at five of the six query sites in this repo, against two\n" +
      "other spellings that got it right, one of which carried a comment\n" +
      "explaining the hazard that nothing else could see.\n" +
      "\n" +
      "The path half has the mirror-image problem. A split never returns an\n" +
      "empty array, so index 0 is always a string and the fallback after it\n" +
      "is dead code that exists to satisfy `noUncheckedIndexedAccess`. Four\n" +
      "different dead fallbacks were in the tree, which left a reader to work\n" +
      "out which one was load-bearing.\n" +
      "\n" +
      "Splitting a string that is NOT a request target is legitimate and\n" +
      "baselined: `aai-cli/workflow-bundler.ts` strips a Vite module id's query\n" +
      "suffix, where there is no request and no path to answer with.",
  },
];
