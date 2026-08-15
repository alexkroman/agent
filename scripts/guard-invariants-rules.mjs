/**
 * The line-scanning rules `guard-invariants.mjs` enforces, as data.
 *
 * A separate module, with NO side effects, for two reasons:
 *
 *   1. **The gate's spec can import the real values.** An earlier draft had
 *      `packages/aai-templates/guard-invariants-gate.test.ts` regex-scrape
 *      `re: "..."` out of the script's source, which is fragile in the exact
 *      way that matters here — a rule whose shape drifted would silently stop
 *      being parsed, so the suite proving no rule is dead would itself go
 *      blind. It cannot import the gate instead, because importing that module
 *      runs the scan and calls `process.exit`.
 *   2. **The patterns can be COMPOSED.** Spelled out end to end, two of these
 *      regexes are long enough that biome's `noSecrets` entropy heuristic
 *      scores them as credentials — a POSIX ERE full of escaped character
 *      classes looks exactly like a high-entropy string. Building them from the
 *      named fragments below keeps every literal short, which is better than
 *      the alternative of a biome override: an `overrides` entry that matches a
 *      file also stops the root `formatter` settings applying to it, so the
 *      override reformatted the gate to biome's defaults (tabs, 80 columns)
 *      while still reporting it as a formatting error.
 *
 * Every pattern is handed to `git grep -E`, so it must be POSIX ERE. In
 * particular `\b` is a GNU extension that git's own matcher does not implement:
 * a pattern using one matches NOTHING and the rule reports success forever.
 * That is not a hypothetical — two `check-escape-hatches.mjs` patterns were
 * dead that way for months over a tree holding 110 violations, and
 * `guard-invariants-gate.test.ts` asserts against it.
 */

// --- ERE fragments ---------------------------------------------------------

// Named down to the character class. One more level of decomposition than
// reads naturally, and for a mechanical reason: biome's `noSecrets` scores a
// regex literal above ~20 characters as a high-entropy string, and the
// alternative — an `overrides` entry switching the rule off — also drops the
// root `formatter` settings for the file, so it reformatted this gate to
// biome's defaults while still reporting a formatting error. Short fragments
// cost a line each and are arguably clearer at the call site.
/** Characters a JavaScript identifier may start with. */
const ID_HEAD = "A-Za-z_$";
/** Characters a JavaScript identifier may continue with. */
const ID_TAIL = "A-Za-z0-9_$";
/** A JavaScript identifier. */
const IDENT = `[${ID_HEAD}][${ID_TAIL}]*`;
/** A dotted member path, e.g. `state.entries`. */
const MEMBER = `[${ID_HEAD}][${ID_TAIL}.]*`;
/** A parenthesised argument list with no nested parens. */
const ARGS = "\\([^)]*\\)";
/** A `.get(…)` call — the read half of both hand-rolled-map patterns. */
const MAP_GET = `\\.get${ARGS}`;
/** An `on*` handler name — the observer-callback naming convention. */
const ON_NAME = "on[A-Z][A-Za-z0-9]*";
/** ERE for a literal `&&`. */
const AND = " && ";
/** ERE for a literal `||` — the pipe is alternation, so both halves escape. */
const OR = " \\|\\| ";
/** `typeof X === "object"`, the positive half of rule 17. */
const TYPEOF_OBJECT = `typeof ${MEMBER} === "object"`;
/** `typeof X !== "object"`, the same test written as a guard clause. */
const NOT_TYPEOF_OBJECT = `typeof ${MEMBER} !== "object"`;
/** `X !== null`, the other positive half. */
const NOT_NULL = `${MEMBER} !== null`;
/** `X === null`, the guard-clause half. */
const IS_NULL = `${MEMBER} === null`;
/** The spread of a parenthesised expression — the head of rule 2's three shapes. */
const SPREAD_OPEN = "\\.\\.\\.\\([^)]*";
/** A literal `"?"` argument, escaped for ERE. */
const QUERY_ARG = '\\("\\?"\\)';
/** A `.split("?")` call — hand-cutting a request target into path and query. */
const SPLIT_ON_QUERY = `\\.split${QUERY_ARG}`;
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
 * A hand-rolled timer promise with a nonzero delay.
 *
 * `.*` before `setTimeout` for rule 4's documented reason — the executor's own
 * parameter list closes a paren, so a negated-paren class matches nothing. But
 * `[^,)]*` INSIDE the call, because the greedy `.*` would otherwise let a
 * two-parameter executor supply the comma: `new Promise((resolve, reject) =>
 * setTimeout(resolve, 0))` matches `, r` and would be reported as a sleep.
 */
const SLEEP_PROMISE = `new Promise\\(.*setTimeout\\([^,)]*, ?${NONZERO_DELAY}`;
/**
 * The aliased `node:timers/promises` sleep — the one timer `vi.useFakeTimers()`
 * cannot drive. Matched on the aliased IMPORT rather than the module specifier,
 * so a future caller wanting `scheduler.wait` from the same module is not caught
 * by a rule that has nothing to say about it.
 */
const TIMERS_PROMISES = `setTimeout as ${IDENT}`;
/** Line start plus indentation: where a property or method is DECLARED. */
const AT_LINE_START = "^ *";
/**
 * A property or method DECLARATION, as opposed to a call of one.
 *
 * `onFoo:` (a property), or `onFoo(args):`/`onFoo(args) {` (a signature or a
 * method). Deliberately NOT `onFoo();`, which is an ordinary call of a local
 * function — `_timer.ts`'s `onWake()` and `_pipeline-fuzz-model.ts`'s
 * `onReplyCompleted()` are both that, and neither declares a surface.
 */
const DECLARES = `(\\?)?(:|${ARGS} *(:|\\{))`;

/**
 * The modules that declare the SESSION's callback surfaces — rule 16's scope.
 *
 * An explicit list, and that is the answer to "scope by module role, not by
 * counting every `on*` in the package" rather than a shortcut around it. Role is
 * not derivable from a path here: `transports/types.ts` declares the session
 * boundary and `transports/pipeline-llm-stream.ts`, its neighbour, decomposes a
 * hot path with `on*` parameters — a glob over `transports/` would catch both and
 * a glob over `host/*.ts` would catch neither. The two things NOT in scope are in
 * scope for that reason: provider adapter contracts (`_s2s-dispatch.ts`'s
 * `S2sCallbacks`, `providers/**`'s `onSttPartial`/`onTtsAudio`) sit BELOW the
 * session and are what a new provider is written against, and utilities that take
 * an `on*` PARAMETER (`_timer.ts`) are ordinary function decomposition.
 *
 * `guard-invariants-gate.test.ts` asserts every path here exists, because a
 * hand-kept list's one real failure mode is a rename quietly emptying the rule.
 */
export const SESSION_SURFACE_PATHS = [
  "packages/aai/host/session-core.ts",
  "packages/aai/host/session-commands.ts",
  "packages/aai/host/transports/types.ts",
  "packages/aai/host/runtime-types.ts",
  "packages/aai/host/runtime-session-callbacks.ts",
  "packages/aai/host/runtime.ts",
  "packages/aai/host/ws-handler.ts",
  // The doubles. A per-name callback surface has a MULTIPLIER: every harness
  // standing in for the thing that fires a callback has to satisfy its whole
  // shape, and 78 of the original 157 occurrences were exactly that.
  "packages/aai/host/_test-utils.ts",
  "packages/aai/host/transports/_transport-recorder.ts",
  "packages/aai/host/transports/_pipeline-transport-harness.ts",
  "packages/aai/host/integration/_pipeline-fuzz-model.ts",
  "packages/aai/host/integration/_s2s-fuzz-harness.ts",
];

/**
 * Source roots the line rules walk.
 *
 * `:!scripts/` + `*.md` is not a duplicate of the doublestar line above it. A
 * git pathspec is fnmatch WITHOUT `FNM_PATHNAME`, so a `*` already crosses `/`
 * and the LITERAL SLASH in the doublestar form makes a subdirectory mandatory —
 * that glob excluded nothing at the `scripts/` top level, which is exactly where
 * a `README.md` would go. The same trap `check-file-length.mjs` documents at
 * length, where it had left ~29 files unmeasured while printing a checkmark. The
 * `packages/` exclusion needs no twin, and not by luck: every markdown file
 * under `packages/` is at least one directory deep. Verify either with
 * `git ls-files "<glob>"`, never by reading it.
 */
export const SOURCE_PATHSPECS = [
  "packages",
  "scripts",
  ":!packages/**/dist/**",
  ":!packages/**/*.md",
  ":!scripts/**/*.md",
  ":!scripts/*.md",
  // A frozen compatibility example is EXCLUDED FROM EVERY LINE RULE, not
  // exempted from one. `contracts/compatibility/<capability>/v<N>.ts` is an
  // authoring example written the way that epoch was authored, and
  // `pnpm typecheck` compiling it is the backward-compatibility gate — so
  // "fixing" one to satisfy a rule destroys the check it exists to be. The
  // awkwardness is load-bearing, which is also why the sweep that produced
  // these rules skipped the directory by design.
  //
  // It has to be a pathspec rather than a `SELF_REFERENTIAL` entry: an
  // exemption is per file AND per rule, so the next widened rule re-opens
  // the same hole. Rule 2's widening did exactly that — four reviewers
  // reported `workflow/v5.ts` independently, each proposing a per-rule
  // exemption, and the next rule would have collected a fifth report.
  ":!packages/*/contracts/compatibility/**",
];

/**
 * @typedef {object} LineRule
 * @property {number} id      Stable rule number, quoted in the baseline and in commits.
 * @property {string} key     Baseline key.
 * @property {string} label   Short name for the summary line.
 * @property {string} re      POSIX ERE handed to `git grep -E`.
 * @property {string[]} paths Pathspecs to scan.
 * @property {boolean} skipComments Drop matches on comment-only lines.
 * @property {string} remedy  What to do instead — printed on failure.
 */

/** @type {LineRule[]} */
export const LINE_RULES = [
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
    id: 3,
    key: "rule3_raceTimeout",
    label: "hand-rolled Promise.race timeout",
    re: "Promise\\.race\\(.*setTimeout",
    paths: SOURCE_PATHSPECS,
    skipComments: true,
    remedy:
      "Use `p-timeout` — it is already a dependency of aai, aai-cli,\n" +
      "aai-guest and aai-server. A race with no timer in it is fine: this rule\n" +
      "is about the hand-rolled timeout, not the race.",
  },
  {
    id: 4,
    key: "rule4_inlineTickPromise",
    label: "inline new Promise(r => setTimeout(r, 0))",
    // `.*` between the two calls, NOT `[^)]*`. The arrow's own parameter list
    // closes a paren before `setTimeout` is reached
    // (`new Promise((resolve) => setTimeout(resolve, 0))`), so a negated-paren
    // class matches nothing at all — which is how the first version of this
    // rule reported 0 against five real occurrences.
    re: "new Promise\\(.*setTimeout\\(.*, ?0\\)",
    paths: SOURCE_PATHSPECS,
    skipComments: true,
    remedy:
      "Use `flush()` for a microtask yield or `tick()` for a macrotask one,\n" +
      "both from aai/host/_test-utils.ts. Spelled inline it does not say which\n" +
      "it meant, and a LOCAL `flush` defined this way once shadowed the shared\n" +
      "export so one name meant two different waits.",
  },
  {
    id: 5,
    key: "rule5_deleteProcessEnv",
    label: "delete process.env",
    re: "delete process\\.env",
    paths: SOURCE_PATHSPECS,
    skipComments: true,
    remedy:
      "Use `vi.stubEnv(name, undefined)`. `unstubEnvs` (set in\n" +
      "vitest.shared.ts) reverses it before each test, so there is nothing to\n" +
      "restore by hand — and a hand-rolled restore is what rots: deepgram.test.ts\n" +
      'wrote back a captured `undefined`, which env coercion turns into "undefined".',
  },
  // Rule 6 is RETIRED: `ctx.state` no longer exists, so `ctx.state as T` is
  // unrepresentable rather than discouraged. It banned that cast in a template,
  // on the finding that all five stateful ones had taken it — a tool learned the
  // state shape only from an annotated context, so a second module either
  // restated the annotation or cast. Session state is a `sessionSlot` now, which
  // types and stores its own value in the module that declares it, and there is
  // no bag left to cast.
  //
  // The NUMBER stays retired rather than being reused, per this file's stable-id
  // rule: 6 appears in commit messages and in the baseline's history, and a later
  // rule inheriting it would make both misleading.
  {
    id: 11,
    key: "rule11_hardcodedTmp",
    label: "hardcoded /tmp path",
    // A `/tmp/...` string literal. `"` and a backtick both start one here.
    re: '["`]/tmp/',
    // SHIPPED source only. The hazard is a real filesystem write, and a spec
    // handing `"/tmp/watched"` to a fake chokidar never touches the disk — eight
    // files' worth of those made the first draft of this rule pure noise.
    paths: [...SOURCE_PATHSPECS, ":!packages/**/*.test.ts", ":!packages/**/_*test-utils.ts"],
    skipComments: true,
    remedy:
      "Use `join(tmpdir(), …)` from node:os + node:path.\n" +
      "On Windows a bare `/tmp/x` is DRIVE-RELATIVE — it resolves to `D:\\tmp\\x`,\n" +
      "which does not exist — so every write there fails with ENOENT. Two shipped\n" +
      "modules had it (`workflow-serve.ts`, `harness-bundle.ts`) and both run on\n" +
      "the developer's own machine under `aai dev`, not only in the Linux guest.\n" +
      "Baseline an occurrence only when the path is INSIDE a container by\n" +
      "construction — `modal-agent-sandbox.ts`'s remote paths name a location in\n" +
      "the Linux sandbox, where `/tmp` is the correct literal and `tmpdir()` would\n" +
      "wrongly describe the host.",
  },
  {
    id: 8,
    key: "rule8_handRolledOwnedMap",
    label: "hand-rolled owned-map eviction",
    re: `${MAP_GET} === ${IDENT}\\) ${MEMBER}\\.delete\\(`,
    paths: SOURCE_PATHSPECS,
    skipComments: true,
    remedy:
      "Use `createOwnedMap()` from @alexkroman1/aai/internal. `claim(key, value)`\n" +
      "returns the only release for that claim, so an async teardown settling\n" +
      "after the key was re-claimed (reconnect resume, redeploy) cannot evict\n" +
      "the successor's entry.",
  },
  {
    id: 9,
    key: "rule9_handRolledKeyedLock",
    label: "hand-rolled per-key promise chain",
    re: `${MAP_GET} \\?\\? Promise\\.resolve\\(\\)`,
    paths: SOURCE_PATHSPECS,
    skipComments: true,
    remedy:
      "Use `createKeyedLock()` / `withLock()` from @alexkroman1/aai, or\n" +
      "`slot.update` for the ctx.state case. The parts that get missed are\n" +
      "dropping the drained entry BY OWNERSHIP and resolving your own place in\n" +
      "the chain when you abandon a timed-out acquire.",
  },
  {
    id: 16,
    key: "rule16_sessionCallbackName",
    label: "session callback name (report an event)",
    re: `${AT_LINE_START}${ON_NAME}${DECLARES}`,
    paths: SESSION_SURFACE_PATHS,
    skipComments: true,
    remedy:
      "Add the EVENT to `packages/aai/sdk/protocol-events.ts` and report it —\n" +
      "`SessionCore.report(event)` and `TransportCallbacks.report(event)` take the\n" +
      "protocol's own vocabulary, so a new thing the session observes costs one\n" +
      "union member and one `case`. A new `on*` costs a declaration on the type, a\n" +
      "forward in `runtime-session-callbacks.ts`, and a stub in each of the four\n" +
      "harnesses that stand in for the thing that fires it — which is the\n" +
      "multiplier that put 157 of these across eleven files.\n\n" +
      "A name is legitimate exactly when there IS NO EVENT for it, and every\n" +
      "baselined occurrence is one of three kinds:\n" +
      "  - BINARY AUDIO (`onAudio`, `onAudioChunk`). 384 kbps of PCM, deliberately\n" +
      "    outside the event vocabulary — see `protocol-events.ts`, and note the\n" +
      "    retained stream is why: audio in it would be minutes of samples per call\n" +
      "    in the tenant's own Postgres.\n" +
      "  - NO EVENT EXISTS (`onReplyStarted` — the wire has `reply.completed` and\n" +
      "    `reply.cancelled` and no `reply.started`; `onSessionReady` — a provider's\n" +
      "    own resume token, which nothing on the wire describes).\n" +
      "  - LIFECYCLE THE CALLER MUST ACT ON (`onOpen`/`onClose`/`onSessionEnd`/\n" +
      "    `onSinkCreated`/`onToolResult`). These release state or settle a pending\n" +
      "    call; an observe-only hook could not, which is the same distinction\n" +
      "    `SessionEventContext` draws by carrying no `send`.\n\n" +
      "Minting an event to dodge this rule is worse than the callback: an event is\n" +
      "AUTHOR-VISIBLE (`agent({ events })`) and retained, so it is a promise.",
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
];
