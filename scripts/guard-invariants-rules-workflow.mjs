/**
 * The three rules over a shipped `workflows/` body — 26, 30 and 32.
 *
 * They lived in `-rules-timing.mjs`, whose own doc had already conceded the
 * seam: "**26 and 30 are a PAIR and are here together.** Neither is about
 * waiting." That file passed the 500-line source cap when rule 31 landed, and
 * this is the split it was already described as needing rather than a new one
 * invented under the cap.
 *
 * What makes them one subject: both scan `WORKFLOW_BODY_PATHSPECS`, both answer
 * "what may a shipped `workflows/` body contain?", and both settle the same
 * undecidable-from-a-line question the same way. The `ctx.step` callback
 * boundary is invisible to `git grep`, so each bans the call ANYWHERE in the
 * corpus and leaves the legitimate case to the baseline WITH a reason recorded
 * at the occurrence — never in the baseline JSON, which `--update` rewrites.
 *
 * **32 is the one that needs no baseline, and that is what distinguishes it.**
 * It bans the computed step or wait NAME rather than the read that feeds one,
 * so there is nothing undecidable about it: a template-literal identity is
 * wrong wherever it appears, because identity is `(name, occurrence)` and the
 * per-name counter already distinguishes a fan-out's calls. It stands at zero
 * across all fourteen templates. It is also the shape `Literal<Name>` provably
 * misses — see its remedy — which is why a rule exists at all, and
 * `aai-cli/_workflow-determinism.ts` is the same check pointed at a USER's
 * project.
 *
 * Rule IDs are STABLE across this move, as they were across the last one: 30
 * arrived here from `-rules-shape.mjs` and kept its number, and `LINE_RULES` is
 * sorted by id rather than by module order, so nothing downstream can tell
 * which file a rule lives in. 32 rather than 31 because 31 was taken while this
 * one was being written, by the jittered-backoff rule in `-rules-timing.mjs`.
 *
 * This module is in `guard-invariants.mjs`'s `SELF_REFERENTIAL` set with its
 * four siblings, because every `label` and `re` here describes the thing it
 * bans. AGENTS.md records that trap being paid for four times; a split that
 * forgot one file would be the fifth, and this is the sixth file to add.
 */

import { CLASSIFIABLE_STEP_CALLS, NOT_IDENT_BEFORE } from "./guard-invariants-ere.mjs";
import { WORKFLOW_BODY_PATHSPECS } from "./guard-invariants-scopes.mjs";

/**
 * Rule 30's banned reads, one alternation.
 *
 * The five a workflow body must not perform at body level: three spellings'
 * worth of clock, an id, and the network.
 *
 * **`new +Date` is the one the rule shipped BLIND to**, by decision rather than
 * oversight — the fragment's own doc recorded the omission and deferred the
 * measurement. The measurement: two live occurrences, both
 * `new Date().toISOString()`, spelled that way only because the value wanted is
 * an ISO string. That difference is nothing to the rule — a body-level clock
 * read answers differently on every replay, so a step NAME built from one
 * re-executes the step, which is the failure rule 30 exists for.
 *
 * The `+` is load-bearing in both directions. TypeScript requires whitespace
 * between `new` and the class, so demanding it costs no real occurrence; and it
 * keeps `renewDate(` out on the mandatory space alone, without leaning on
 * `NOT_MEMBER_BEFORE`. The trailing `\\(` does the rest: `new DateRange(` is a
 * different constructor and does not match.
 *
 * BUILT from an array rather than one literal, for `CLASSIFIABLE_STEP_CALLS`'s
 * reason: end to end this alternation is long enough that biome's `noSecrets`
 * entropy heuristic scores it as a credential, and the formatter folds any
 * concatenation written to dodge that.
 */
const NONDETERMINISTIC_READS = [
  "Math\\.random",
  "Date\\.now",
  "new +Date",
  "crypto\\.randomUUID",
  "fetch",
].join("|");

/**
 * Not preceded by an identifier character OR a dot — i.e. the GLOBAL of that
 * name rather than somebody's method.
 *
 * `NOT_IDENT_BEFORE` admits `.`, which is correct for a name that is never a
 * method (rule 26's step callers) and wrong for `fetch`.
 */
const NOT_MEMBER_BEFORE = "(^|[^A-Za-z0-9_$.])";

/**
 * Rule 31's three journal identities.
 *
 * `ctx.step`, `ctx.sleep` and `ctx.waitFor` all key a journal ROW by their
 * first argument — `name#occurrence`, `sleep!<label>#<n>`, `hook!<token>#<n>` —
 * so a computed one mints a row no earlier walk reached, whichever it is.
 */
const IDENTITY_CALLS = ["step", "sleep", "waitFor"].join("|");

/**
 * A template placeholder as SOURCE text: `interp("base")` is `${base}`.
 *
 * Composed rather than written out because biome reads a literal `${` inside a
 * plain string as a mistaken template — true in general, and rule 31's samples
 * are source lines whose whole subject is one. A template literal is not the
 * escape either: with no REAL placeholder biome rewrites it back to a quoted
 * string. This one has one, so it stays.
 */
const interp = (expr) => `\${${expr}}`;

/** @type {import("./guard-invariants-rules.mjs").LineRule[]} */
export const WORKFLOW_BODY_RULES = [
  {
    id: 26,
    key: "rule26_unclassifiedStepCall",
    label: "raw step call in a shipped workflow body",
    // A call position. The wrappers themselves are excluded by the trailing
    // `\\(`: their names are the banned name plus `OrFail`, so the paren
    // never follows. See both fragments' docs.
    re: `${NOT_IDENT_BEFORE}(${CLASSIFIABLE_STEP_CALLS})\\(`,
    paths: WORKFLOW_BODY_PATHSPECS,
    skipComments: true,
    samples: {
      // DERIVED from the alternation, one pair per banned name, so a name added
      // to `CLASSIFIABLE_STEP_CALLS` is sampled in both directions without
      // anyone remembering to. It also keeps every literal here short: spelled
      // out, `  await stepTranscribeSyncOrFail(bytes);` is long enough that
      // biome's `noSecrets` entropy heuristic scores it as a credential, and
      // the formatter folds any concatenation written to dodge that.
      matches: CLASSIFIABLE_STEP_CALLS.split("|").map((name) => `  await ${name}(x);`),
      ignores: [
        // The remedy: the same name plus the suffix, which the trailing `(`
        // in the pattern is what excludes.
        ...CLASSIFIABLE_STEP_CALLS.split("|").map((name) => `  await ${name}OrFail(x);`),
        // Not a call: an import, a type position, a property.
        'import { stepGenerate } from "@alexkroman1/aai/step";',
        "  const opts: StepGenerateOptions = { system };",
      ],
    },
    remedy:
      'Inside a `"use step"` body, call the `*OrFail` sibling from\n' +
      "`@alexkroman1/aai/step-errors` — the same name plus that suffix, for\n" +
      "each of the callers this rule names.\n" +
      "\n" +
      "The DevKit decides its retry policy from WHICH error a step throws, and a\n" +
      "raw call throws the same thing for every failure. So a bad API key is\n" +
      "retried until the attempts run out, and a rate limit backs off for the\n" +
      "DevKit's default one second while the delay the gateway itself named sits\n" +
      "unread on the error. That last one is worst exactly where this SDK\n" +
      "encourages a fan-out: N steps hit the limit together, and a second later\n" +
      "all N ask again. The wrapper is the call plus `throwStepError`, nothing\n" +
      "else — a terminal failure raises `FatalError` and stops, a transient one\n" +
      "raises `RetryableError` carrying the far side's own `Retry-After`.\n" +
      "\n" +
      "The raw call is RIGHT where the failure is not simply a failure — a `404`\n" +
      'that means "already deleted", a `4xx` whose body decides which advice to\n' +
      "print. Baseline the line and say which case it is in a comment beside it;\n" +
      "`recap-workflow`'s `discardTranscript` is the worked example.\n" +
      "\n" +
      "Scoped to shipped `workflows/` bodies because those are what a user\n" +
      "copies, and because the SDK's own `sdk/step-errors.ts` calls all six —\n" +
      "being the wrappers.",
  },
  {
    id: 30,
    key: "rule30_nondeterministicWorkflowBody",
    label: "non-deterministic read in a shipped workflow body",
    // A CALL position, and the leading class excludes a preceding `.` as well as
    // an identifier character — without that, `client.fetch(` and `this.fetch(`
    // score as the global. `NOT_IDENT_BEFORE` cannot be reused for exactly that
    // reason: it admits `.`, right for `stepGenerate` and wrong for `fetch`.
    // Composed rather than written out, for rule 26's reason just above.
    re: `${NOT_MEMBER_BEFORE}(${NONDETERMINISTIC_READS})\\(`,
    paths: WORKFLOW_BODY_PATHSPECS,
    skipComments: true,
    samples: {
      matches: [
        "  const coin = Math.random() < 0.5 ? 'h' : 't';",
        "  const startedAt = Date.now();",
        "  const id = crypto.randomUUID();",
        "  const res = await fetch(url);",
        // First on the line, which is what the `^` alternative is for.
        "Date.now();",
        // `new Date(` — the spelling the rule was blind to. Both live
        // occurrences read like the first; the second proves the pattern does
        // not depend on `()` being empty.
        "  const filedAt = new Date().toISOString();",
        "  const at = new Date(raw).toISOString();",
      ],
      ignores: [
        // The FIRST remedy, sampled so the fix the message names is one the
        // rule is known to accept — `ctx` methods, naming no global at all.
        "  const startedAt = await ctx.now();",
        "  const jitter = await ctx.random();",
        "  const idempotencyKey = await ctx.uuid();",
        // The second remedy: the same read INSIDE a step callback, reached
        // through a helper the body cannot inline. A line-based scan cannot see
        // that boundary, so what it CAN see is that the body names a step
        // instead of a clock. The third is the `new Date(` half's remedy —
        // `file` is `link-digest`'s baselined step helper, reached from here.
        '  const startedAt = await ctx.step("startClock", startClock);',
        '  const id = await ctx.step("mintId", newId);',
        '  const filedAt = await ctx.step("file", () => file(digest));',
        // A METHOD of that name is not the global.
        "  const res = await client.fetch(url);",
        "  const body = await this.fetch(url);",
        // A type position and an import are not calls.
        'import { fetchTranscript } from "../lib/api.ts";',
        "  const at: ReturnType<typeof Date.now> = stamp;",
        // A different member of the same object.
        "  const iso = Date.parse(raw);",
        // `new` glued to a preceding identifier is a different NAME, and the
        // mandatory space in `new +Date` excludes it — so this holds even where
        // `NOT_MEMBER_BEFORE` cannot reach, e.g. first on a line.
        "  const next = renewDate(subscription);",
        // A constructor merely STARTING with `Date`; the trailing paren pins it.
        "  const window = new DateRange(from, to);",
      ],
    },
    remedy:
      "For a CLOCK, a RANDOM NUMBER or a UUID, call the method — each reads its\n" +
      "source once, journals the value, and answers every later walk from it:\n" +
      "\n" +
      "  const startedAt = await ctx.now();  // or ctx.uuid(), or ctx.random()\n" +
      "\n" +
      "For anything else — a `fetch`, a database read, a file — move the read\n" +
      "INSIDE a `ctx.step` callback and use the journaled value. A workflow body\n" +
      "is REPLAYED — the engine re-runs it from the top on every resume and\n" +
      "answers each `ctx.step` from the journal — so anything read at body level\n" +
      "is re-read on every walk and answers differently each time. A step's\n" +
      "internals are not replayed, only its result, which is what makes a step\n" +
      "the other place a non-deterministic read belongs:\n" +
      "\n" +
      '  const page = await ctx.step("fetchArticle", () => fetch(input.url));\n' +
      "\n" +
      "The three methods are BODY-LEVEL only — the engine refuses one inside a\n" +
      "`ctx.step`, and inside a step there is nothing to fix anyway, so write the\n" +
      "plain read there. `aai-runtime/workflow-replay-determinism.ts` argues it.\n\n" +
      "The sharp case is a read that reaches a step NAME. Measured on a body one\n" +
      "line long — a coin flip interpolated into a `ctx.step` name, followed by a\n" +
      "`ctx.sleep` — **7 of 10 runs charged twice and all 10 reported\n" +
      "`completed`**. `workflow-replay-divergence.ts` refuses that at runtime now;\n" +
      "this rule is the cheap half, and the only layer that sees the mistake\n" +
      "before it ships.\n" +
      "\n" +
      "It restores a guard that was LOST rather than inventing one: the DevKit's\n" +
      "build scan read the BUILT flow bundle, warned about an in-step read, and\n" +
      "was blind to the boundary it policed (`sdk/workflow-ctx.ts`).\n\n" +
      "`new Date(` counts, and counted late: the alternation shipped without it\n" +
      "and missed two live occurrences spelling the clock read that way because\n" +
      "what they want is an ISO string. A clock is a clock, so the spelling is\n" +
      "not a distinction the rule can afford to make.\n" +
      "\n" +
      "**The callback boundary is not decidable from a line**, so this rule bans\n" +
      "the call anywhere in a shipped `workflows/*.ts` and leaves the legitimate\n" +
      "case to the baseline — rule 26's contract, for the same corpus. Baseline a\n" +
      "line genuinely inside a step body and say so in a comment beside it; every\n" +
      "baselined entry is a step helper whose own comment already states the rule\n" +
      "(`timed`, `probeUpload`, `file`, `timestamp`, and the two `elapsedMs`\n" +
      "subtractions). Anything at BODY level is the bug. The `startClock`/`now`\n" +
      "helpers that used to head that list are GONE: they were the hand-rolled\n" +
      "`ctx.now()` the methods above replaced.",
  },
  {
    id: 32,
    key: "rule32_computedIdentity",
    label: "computed journal identity (a template-literal step/wait name)",
    // A BACKTICK immediately after the paren, then an interpolation somewhere
    // after it. Both halves are needed: a backtick-quoted name with no `${` is
    // a literal and fine, and an interpolation with no backtick is somebody
    // else's string.
    re: `\\.(${IDENTITY_CALLS})\\(\`[^\`]*\\$\\{`,
    paths: WORKFLOW_BODY_PATHSPECS,
    skipComments: true,
    samples: {
      matches: IDENTITY_CALLS.split("|").map((m) => `  await ctx.${m}(\`k-\${i}\`, f);`),
      ignores: [
        // The remedy, and what every shipped body already does.
        ...IDENTITY_CALLS.split("|").map((m) => `  await ctx.${m}("k", f);`),
        // A backtick-quoted name with nothing interpolated IS a literal.
        "  await ctx.step(`fetchArticle`, f);",
        // A bare identifier is the TYPE system's job: `Literal<Name>` refuses
        // one that widened to `string`, and one that did not is a const literal.
        "  await ctx.step(STEP_NAME, f);",
        // The name is a literal; it is the CALLBACK that interpolates.
        `  await ctx.step("post", () => post(\`${interp("base")}/x\`));`,
        // A different ctx method, and a plain template literal.
        "  const t = await ctx.now();",
        `  const url = \`${interp("base")}/x\`;`,
      ],
    },
    remedy:
      "Name a step or a wait with a plain string LITERAL. A journal identity is\n" +
      "a KEY and a body is replayed, so a computed one mints a key no earlier\n" +
      "walk reached — after which the engine either re-executes the step or\n" +
      "refuses the run.\n" +
      "\n" +
      "This is the hole `Literal<Name>` leaves open, which is why a rule is\n" +
      "needed at all. That constraint is `string extends Name ? never : Name`,\n" +
      "so it refuses a name that WIDENED — and a template literal's type is a\n" +
      "template-literal type rather than `string`, so a name written as a\n" +
      "template literal with an interpolation in it compiles cleanly. Verified\n" +
      "against the real `WorkflowCtx`; the samples below carry the shape.\n" +
      "\n" +
      "It is also rule 30's own headline defect, from the other end: that rule\n" +
      "bans the READ that feeds such a name and pays for the breadth with six\n" +
      "baselined step helpers, because a line cannot see the `ctx.step` callback\n" +
      "boundary. This one bans the NAME, needs no baseline, and stands at zero —\n" +
      "every step in all fourteen shipped templates is a plain literal.\n" +
      "\n" +
      "A fan-out does NOT need a computed name, which is the case an author will\n" +
      "think they need one for. Identity is (name, occurrence) and the counter is\n" +
      "per name, so N calls under one name are N distinct rows:\n" +
      '`ctx.step("transcribeSegment", …)` inside the loop is the shipped\n' +
      'seven-way fan-out. A label works the same way — one `ctx.sleep("poll", …)\n' +
      "across every iteration of a polling loop.\n" +
      "\n" +
      "`aai-cli/_workflow-determinism.ts` is this rule pointed at a USER's\n" +
      "project, warning at `aai build` and `aai deploy`; its module doc carries\n" +
      "why rule 30's reads half does not port there.",
  },
];
