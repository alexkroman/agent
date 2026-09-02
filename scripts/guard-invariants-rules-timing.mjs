/**
 * The TIMING rules — 3, 4, 19, 21 and 23 — plus the two WORKFLOW-BODY rules,
 * 26 and 30.
 *
 * The timing five are grouped because they are the same question asked five
 * ways ("how is this code waiting?") and because they share a failure history:
 * all of them are substring guards over a language with syntax, and every gap
 * found in this gate has been in one of them.
 *
 * Rule 21's hazard is not the wait itself: `expect.poll` waits correctly and
 * reads the RUNNER's current test to do it, which under `test.concurrent` a
 * sibling has already cleared. It sits here because the remedy is the same
 * shape as the other four — a different wait primitive, named. Rule 23 is the
 * `async` listener, whose promise the emitter discards.
 *
 * **26 and 30 are a PAIR and are here together.** Neither is about waiting;
 * they are the two rules over `WORKFLOW_BODY_PATHSPECS`, both answering "what
 * may a shipped `workflows/` body contain?", and both settling the same
 * undecidable-from-a-line question the same way — the `ctx.step` callback
 * boundary is invisible to `git grep`, so each bans the call anywhere in the
 * corpus and leaves the legitimate case to the baseline WITH a reason at the
 * occurrence. 30 arrived in `-rules-shape.mjs`, which is the module its author
 * owned rather than the one it belongs to; the id is unchanged by the move,
 * `LINE_RULES` being sorted by id rather than by module order.
 *
 * Three widenings landed together, each against LIVE occurrences the previous
 * pattern could not see:
 *
 *   - rule 3 was LINE-ANCHORED, so the multi-line `Promise.race([` Biome emits
 *     was invisible (3 occurrences);
 *   - rules 4 and 19 required a literal `(` after `new Promise`, so a `<T>`
 *     type argument evaded both (5 occurrences);
 *   - neither knew `setImmediate` (8 occurrences).
 *
 * Rule IDs are STABLE across this split: 6 stays retired, 15 stays reserved,
 * and nothing here was renumbered.
 */

import {
  ASYNC_LISTENER,
  CLASSIFIABLE_STEP_CALLS,
  IMMEDIATE_PROMISE,
  NOT_IDENT_BEFORE,
  RACE_CONTINUES,
  RACE_TIMEOUT,
  SLEEP_PROMISE,
  TICK_PROMISE,
  TIMERS_PROMISES,
} from "./guard-invariants-ere.mjs";
import { SOURCE_PATHSPECS, WORKFLOW_BODY_PATHSPECS } from "./guard-invariants-scopes.mjs";

/**
 * Rule 30's banned reads, one alternation.
 *
 * The five a workflow body must not perform at body level: three spellings'
 * worth of clock, an id, and the network.
 *
 * **`new +Date` is the one the rule shipped BLIND to**, and it was blind to it
 * by decision rather than by oversight — the fragment's own doc recorded the
 * omission and deferred the measurement. The measurement: two live occurrences,
 * both `new Date().toISOString()`, spelled that way rather than `Date.now()`
 * only because the value wanted is an ISO string. That difference is nothing to
 * the rule. A clock read at body level answers differently on every replay, so
 * a step NAME built from one re-executes the step — the failure rule 30 exists
 * for, reached by the spelling it could not see.
 *
 * The `+` is load-bearing in both directions. TypeScript requires whitespace
 * between `new` and the class, so demanding it costs no real occurrence; and it
 * is what keeps `renewDate(` out on the mandatory space alone, without leaning
 * on `NOT_MEMBER_BEFORE`. The trailing `\\(` in the rule does the rest:
 * `new DateRange(` is a different constructor and does not match.
 *
 * BUILT from an array rather than spelled as one literal, for
 * `CLASSIFIABLE_STEP_CALLS`'s reason: end to end this alternation is long
 * enough that biome's `noSecrets` entropy heuristic scores it as a credential,
 * and the formatter folds any concatenation written to dodge that.
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

/** @type {import("./guard-invariants-rules.mjs").LineRule[]} */
export const TIMING_RULES = [
  {
    id: 3,
    key: "rule3_raceTimeout",
    label: "hand-rolled Promise.race timeout",
    re: `${RACE_TIMEOUT}|${RACE_CONTINUES}`,
    paths: SOURCE_PATHSPECS,
    skipComments: true,
    samples: {
      matches: [
        "  const won = await Promise.race([work, new Promise((_, r) => setTimeout(r, ms))]);",
        // The MULTI-LINE form, which the line-anchored pattern could not see —
        // two live occurrences in the fuzz harnesses, and the reason the second
        // alternative exists.
        "  const outcome = await Promise.race([",
        "    return Promise.race(",
      ],
      ignores: [
        "  const outcome = await Promise.race([work.then((value) => ({ value })), exited]);",
        "  return pTimeout(work, { milliseconds: ms });",
      ],
    },
    remedy:
      "Use `p-timeout` — it is already a dependency of aai, aai-cli,\n" +
      "aai-guest and aai-server. A race with no timer in it is fine: this rule\n" +
      "is about the hand-rolled timeout, not the race.\n\n" +
      "A race whose arguments run onto the NEXT line is reported WITHOUT the\n" +
      "gate being able to see whether a timer is among them — `git grep` is\n" +
      "line-based, and the line-anchored pattern this replaces was blind to the\n" +
      "wrapped shape Biome actually emits. Baseline the occurrence when there is\n" +
      "genuinely no timer in it: `aai-server/guest-readiness.ts` races the work\n" +
      "against the child's `exit`, and is the entry to copy.",
  },
  {
    id: 4,
    key: "rule4_inlineTickPromise",
    label: "inline new Promise(r => setTimeout(r, 0))",
    // `.*` between the two calls, NOT `[^)]*`. The arrow's own parameter list
    // closes a paren before `setTimeout` is reached
    // (`new Promise((resolve) => setTimeout(resolve, 0))`), so a negated-paren
    // class matches nothing at all — which is how the first version of this
    // rule reported 0 against five real occurrences. The optional `<T>` inside
    // `TICK_PROMISE` is the SECOND version of that same miss.
    re: `${TICK_PROMISE}|${IMMEDIATE_PROMISE}`,
    paths: SOURCE_PATHSPECS,
    skipComments: true,
    samples: {
      matches: [
        "    await new Promise((resolve) => setTimeout(resolve, 0));",
        "  return new Promise((r) => setTimeout(r, 0));",
        // A type argument, which the literal `(` requirement could not cross.
        "  return new Promise<void>((r) => setTimeout(r, 0));",
        // The other zero-length yield, which neither timer rule knew.
        "    await new Promise((r) => setImmediate(r));",
        "const flush = () => new Promise<void>((resolve) => setImmediate(resolve));",
      ],
      ignores: [
        "    await flush();",
        "    await tick();",
        "    await new Promise((r) => setTimeout(r, 50));",
        "  return new Promise<void>((r) => setTimeout(r, 250));",
      ],
    },
    remedy:
      "Use `flush()` for a microtask yield or `tick()` for a macrotask one,\n" +
      "both from aai/host/_test-utils.ts. Spelled inline it does not say which\n" +
      "it meant, and a LOCAL `flush` defined this way once shadowed the shared\n" +
      "export so one name meant two different waits.\n\n" +
      "`setImmediate` is the same yield reached by another name and is counted\n" +
      "here rather than by rule 19: it takes no delay, so it can never be a\n" +
      "sleep. SHIPPED source that yields deliberately is the legitimate baseline\n" +
      "entry — `host/tool-executor.ts` uses it between tool calls for its\n" +
      "I/O-phase semantics, and a test helper is not the remedy for production\n" +
      "code.",
  },
  {
    id: 19,
    key: "rule19_handRolledSleep",
    label: "hand-rolled sleep",
    // Two shapes in one rule because they are the same mistake reached from two
    // directions — hand-rolling the timer promise, and reaching for the ONE
    // built-in the test runner cannot drive.
    //
    // The nonzero delay is what distinguishes this from rule 4, which owns the
    // `, 0)` case (a yield, whose remedy is `flush()`/`tick()` — two different
    // waits that must not be spelled the same). `[1-9]` after the comma is the
    // whole difference: a literal 0 belongs to rule 4, and a NAMED delay
    // (`setTimeout(resolve, ms)`) is a sleep whatever it holds, so an identifier
    // matches here too.
    re: `${SLEEP_PROMISE}|${TIMERS_PROMISES}`,
    paths: SOURCE_PATHSPECS,
    skipComments: true,
    samples: {
      matches: [
        "    await new Promise((resolve) => setTimeout(resolve, 250));",
        "  return new Promise((r) => setTimeout(r, ms));",
        "  await new Promise((resolve) => setTimeout(resolve, (8 - index) * 20));",
        // The type argument AND a callback first argument — the two-level form
        // the flat `[^,)]*` could not cross. A real five-second wait in both
        // fuzz harnesses. Spelled in two halves because biome's `noSecrets`
        // scores the whole literal as high entropy, the same reason the ERE
        // fragments are named one at a time.
        `  new Promise<"x">((r) => ${'setTimeout(() => r("x"), 5000));'}`,
        '    import { setTimeout as sleep } from "node:timers/promises";',
      ],
      ignores: [
        "    await sleep(250);",
        "    await sleep(GUEST_DIAL_RETRY_MS, { unref: true });",
        // Rule 4's shapes, which this rule must NOT sweep in.
        "    await new Promise((resolve) => setTimeout(resolve, 0));",
        "  return new Promise<void>((r) => setTimeout(r, 0));",
        // A two-parameter executor supplying the comma.
        "    await new Promise((resolve, reject) => setTimeout(resolve, 0));",
        "    await new Promise((r) => setImmediate(r));",
        '    import { scheduler } from "node:timers/promises";',
      ],
    },
    remedy:
      "Use the `sleep` helper from @alexkroman1/aai/internal.\n" +
      "\n" +
      "There were FIVE spellings of this across four packages, two of them\n" +
      "byte-identical across a package boundary. That is the ordinary kind of\n" +
      "duplication; the reason this is a rule is that the five split into two\n" +
      "families differing in a property no reader can see at a call site.\n" +
      "\n" +
      "`vi.useFakeTimers()` replaces the global setTimeout and does NOT patch\n" +
      "node:timers/promises. Measured: a spec that advances the fake clock by\n" +
      "an hour never sees such a wait resolve. So the spelling silently decides\n" +
      "whether a poll loop can be tested at all, and no tier carries a retry —\n" +
      "a spec that waits out real milliseconds is the one that fails first on\n" +
      "a contended runner, naming the timing helper rather than the bug.\n" +
      "\n" +
      "The shared helper takes `{ unref }` (opt-in, because it is a claim that\n" +
      "abandoning the wait is correct) and `{ signal }` (resolving rather than\n" +
      "throwing, with the listener detached on every path so a loop against a\n" +
      "long-lived signal retains nothing).\n" +
      "\n" +
      "A zero-length wait is NOT this: that is rule 4, and the remedy there\n" +
      "names which of the two yields you meant.",
  },
  {
    id: 21,
    key: "rule21_expectPoll",
    label: "expect.poll (bound to the runner's current test)",
    // No prefix beyond the literal, because the point is the SPELLING: a
    // context-bound `expect` destructured from the test arguments is spelled
    // identically at the call site. No regex can tell the two apart, which is
    // the argument for banning the API rather than for policing where it is
    // reached from.
    re: "expect\\.poll\\(",
    paths: SOURCE_PATHSPECS,
    skipComments: true,
    // Every sample here is SHORT on purpose: spelled out at call-site length,
    // biome's `noSecrets` entropy heuristic scores them as credentials — the
    // same trap this module's header records rule 19 paying for.
    samples: {
      matches: ["    await expect.poll(() => n).toBe(0);", "  await expect.poll(read).toEqual(1);"],
      ignores: [
        "    await vi.waitFor(() => expect(n).toBe(0));",
        "    await vi.waitUntil(() => n > 0, { interval: 50 });",
        "    expect(n).toBe(0);",
        // The name is a hazard only on `expect`. A poll of one's own is fine.
        "    await pollUntilReady(url);",
      ],
    },
    remedy:
      "Use `vi.waitFor()` (retry an assertion) or `vi.waitUntil()` (retry a\n" +
      "predicate) — which is what AGENTS.md already asks for when polling for an\n" +
      "async result, so this rule only makes the existing preference mechanical.\n" +
      "Where the thing awaited is an EVENT the tool already records, take the\n" +
      "tool's own affordance instead: `page.waitForEvent(name, { predicate })`\n" +
      "cannot miss an event however brief it was, and needs no array to poll.\n" +
      "\n" +
      "`expect.poll` reads the runner's CURRENT TEST, which is a single\n" +
      "module-level variable in @vitest/runner — set before a test body runs and\n" +
      "cleared after. Under `test.concurrent` the siblings run interleaved, so\n" +
      "the first one to FINISH clears the pointer for every test still running,\n" +
      "and the global `expect.poll` throws `expect.poll() must be called inside\n" +
      "a test` rather than polling anything.\n" +
      "\n" +
      "That failure is INVISIBLE until it is not: it depends on which concurrent\n" +
      "sibling finishes first, so it passes locally and on the leg that happens\n" +
      "to schedule kindly. It took out both e2e legs of a Version Packages PR\n" +
      "and of main (`aai-cli/e2e.test.ts`, 20 concurrent tests) while the run\n" +
      "before it was green on the same code. `vi.waitFor` reads no such state,\n" +
      "so it is correct in a concurrent test and in a serial one alike.\n" +
      "\n" +
      "The context `expect` (`async ({ expect }) => …`) IS bound correctly and is\n" +
      "the upstream remedy — it is not the one here, because the two are spelled\n" +
      "the same at the call site. A rule that cannot see the difference would\n" +
      "have to trust a destructuring one screen up, and this repo has paid four\n" +
      "times for a guard that reports success over the shape it cannot see.",
  },
  {
    id: 23,
    key: "rule23_asyncEventListener",
    label: "async function as an event listener",
    // Here rather than in `-rules-state.mjs` because the family question is the
    // one this module asks — "how is this code waiting?" — with the answer
    // "it isn't, and neither is anyone else". Rule 21 already established that
    // a rule belongs here when the REMEDY is a different way of handing off an
    // async result, even when the hazard is not the wait itself.
    re: ASYNC_LISTENER,
    paths: SOURCE_PATHSPECS,
    skipComments: true,
    samples: {
      matches: [
        '  ws.on("message", async (raw) => {',
        '  signal.addEventListener("abort", async () => {',
        '  emitter.once("open", async function reconnect() {',
        "  target.addListener(EVENTS.data, async (chunk) => {",
      ],
      ignores: [
        // The remedy: a sync listener that hands the promise somewhere.
        '  ws.on("message", (raw) => { void handle(raw).catch(report); });',
        '  signal.addEventListener("abort", () => controller.abort());',
        '  emitter.on("data", onData);',
        // `once` as the node:events HELPER, which awaits and is the correct
        // spelling. No leading dot, so the pattern cannot reach it.
        '  const [chunk] = await once(stream, "data");',
        // A hono handler: the framework awaits it, and the `async` sits in the
        // THIRD argument position. The event-name class cannot cross the comma.
        '  app.on("GET", "/health", async (c) => c.text("ok"));',
      ],
    },
    remedy:
      "Keep the listener SYNCHRONOUS and hand the promise to something that\n" +
      "observes it:\n" +
      "\n" +
      '  emitter.on("data", (chunk) => { void handle(chunk).catch(report); });\n' +
      "\n" +
      "or wrap the whole body in try/catch so the listener cannot reject at all.\n" +
      "\n" +
      "An `async` listener returns a promise to the emitter, and an emitter\n" +
      "DISCARDS what a listener returns. So a throw inside it does not fail the\n" +
      "operation it belongs to — it becomes an unhandled rejection with no\n" +
      "session, no request and no turn attached to it, which on the platform is\n" +
      "a whole-process crash rather than one degraded session. That is not\n" +
      "hypothetical here: it is the shape of the cartesia-js TTS bug in\n" +
      "packages/aai/CHANGELOG.md, where a socket error with no `error` listener\n" +
      "bound took down the host.\n" +
      "\n" +
      "Biome's `noMisusedPromises` is ON and does NOT cover this. Measured: it\n" +
      "reports an async callback passed to a locally-declared `() => void`\n" +
      "parameter, and reports nothing for `EventEmitter.on` or\n" +
      "`AbortSignal.addEventListener`, whose types come from `@types/node` and\n" +
      "`lib.dom`. The same blind spot hides every floating promise returned by a\n" +
      "`node:` builtin (`writeFile`, `pipeline`, `finished`, `setTimeout` from\n" +
      "node:timers/promises). This rule closes the half a line-based scan can\n" +
      "see; the other half is a documented limitation in AGENTS.md, because the\n" +
      "floating-call form is indistinguishable from an arrow expression body\n" +
      "that legitimately RETURNS the promise.",
  },
  {
    id: 26,
    key: "rule26_unclassifiedStepCall",
    label: "raw step call in a shipped workflow body",
    // A call position. The wrappers themselves are excluded by the trailing
    // `\\(`: their names are the banned name plus `Classified`, so the paren
    // never follows. See both fragments' docs.
    re: `${NOT_IDENT_BEFORE}(${CLASSIFIABLE_STEP_CALLS})\\(`,
    paths: WORKFLOW_BODY_PATHSPECS,
    skipComments: true,
    samples: {
      // DERIVED from the alternation, one pair per banned name, so a name added
      // to `CLASSIFIABLE_STEP_CALLS` is sampled in both directions without
      // anyone remembering to. It also keeps every literal here short: spelled
      // out, `  await stepTranscribeSyncClassified(bytes);` is long enough that
      // biome's `noSecrets` entropy heuristic scores it as a credential, and
      // the formatter folds any concatenation written to dodge that.
      matches: CLASSIFIABLE_STEP_CALLS.split("|").map((name) => `  await ${name}(x);`),
      ignores: [
        // The remedy: the same name plus the suffix, which the trailing `(`
        // in the pattern is what excludes.
        ...CLASSIFIABLE_STEP_CALLS.split("|").map((name) => `  await ${name}Classified(x);`),
        // Not a call: an import, a type position, a property.
        'import { stepGenerate } from "@alexkroman1/aai/step";',
        "  const opts: StepGenerateOptions = { system };",
      ],
    },
    remedy:
      'Inside a `"use step"` body, call the `*Classified` sibling from\n' +
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
    // an identifier character — without that, `client.fetch(` and
    // `this.fetch(` score as the global. `NOT_IDENT_BEFORE` cannot be reused
    // here for exactly that reason: it admits `.`, which is right for
    // `stepGenerate` (never a method) and wrong for `fetch`.
    //
    // Composed rather than written out, for rule 26's reason just above:
    // spelled as one literal this alternation is long enough that biome's
    // `noSecrets` entropy heuristic scores it as a credential, and the formatter
    // folds any concatenation written to dodge that.
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
        // `new Date(` — the spelling the rule was blind to while the fragment's
        // doc recorded the omission. Both live occurrences read exactly like
        // the first of these; the second proves the pattern does not depend on
        // `()` being empty.
        "  const filedAt = new Date().toISOString();",
        "  const at = new Date(raw).toISOString();",
      ],
      ignores: [
        // The remedy: the same read, INSIDE a step callback, reached through a
        // helper the body cannot inline. A line-based scan cannot see the
        // callback boundary — see the remedy — so what it can see is that the
        // body names a step instead of a clock. The third is the remedy for the
        // `new Date(` half specifically: `file` is the baselined step helper in
        // `link-digest`, and this is the line its body is reached from.
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
        // mandatory space in `new +Date` is what excludes it — so this holds
        // even where `NOT_MEMBER_BEFORE` cannot reach, e.g. first on a line.
        "  const next = renewDate(subscription);",
        // A constructor whose name merely STARTS with `Date`. The trailing
        // paren is what pins the name exactly.
        "  const window = new DateRange(from, to);",
      ],
    },
    remedy:
      "Move the read INSIDE a `ctx.step` callback and use the journaled value.\n" +
      "\n" +
      "A workflow body is REPLAYED — the engine re-runs it from the top on every\n" +
      "resume and answers each `ctx.step` from the journal — so anything read at\n" +
      "body level is re-read on every walk and answers differently each time. A\n" +
      "step's internals are not replayed, only its result, which is what makes a\n" +
      "step the one place a clock, a random number, a uuid or a network read\n" +
      "belongs:\n" +
      "\n" +
      '  const startedAt = await ctx.step("startClock", () => Date.now());\n' +
      "\n" +
      "The sharp case is a read that reaches a step NAME. Measured on a body one\n" +
      "line long — a coin flip interpolated into the name a `ctx.step` is given,\n" +
      "followed by a `ctx.sleep` — **7 of 10 runs charged twice and all 10\n" +
      "reported `completed`**. `workflow-replay-divergence.ts` refuses that at\n" +
      "runtime now, and this rule is the cheap half: the runtime check is the only\n" +
      "layer that sees a name read from a config table, and this is the only layer\n" +
      "that sees the mistake before it ships.\n" +
      "\n" +
      "It restores a guard that was LOST rather than inventing one. The DevKit's\n" +
      "build scan tried and went with the DevKit — see `sdk/workflow-ctx.ts`,\n" +
      "which records that it read the BUILT flow bundle, warned about a `Date.now()`\n" +
      "INSIDE a step callback, and was blind to the boundary it existed to police.\n" +
      "\n" +
      "`new Date(` counts, and counted late: the alternation shipped without it\n" +
      "and missed two live occurrences that spell the clock read that way because\n" +
      "what they want is an ISO string. A clock is a clock — on replay it answers\n" +
      "differently, which is the whole hazard, so the spelling is not a\n" +
      "distinction the rule can afford to make.\n" +
      "\n" +
      "**The callback boundary is not decidable from a line**, so this rule bans\n" +
      "the call anywhere in a shipped `workflows/*.ts` and leaves the legitimate\n" +
      "case to the baseline — rule 26's contract, the rule just above, for the\n" +
      "same corpus. Baseline a line that is genuinely inside a step body and say\n" +
      "so in a comment beside it; every baselined entry is a step helper whose\n" +
      "own comment already states the rule (`startClock`, `now`, `timed`,\n" +
      "`probeUpload`, `file`, `timestamp`). Anything at BODY level is the bug,\n" +
      "not an exception.",
  },
];
