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

/** Source roots the line rules walk. */
export const SOURCE_PATHSPECS = [
  "packages",
  "scripts",
  ":!packages/**/dist/**",
  ":!packages/**/*.md",
  ":!scripts/**/*.md",
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
    re: "\\.\\.\\.\\([^)]* !== undefined \\?",
    paths: SOURCE_PATHSPECS,
    skipComments: true,
    remedy:
      "Use `...omitUndefined({ x })` from @alexkroman1/aai/utils.\n" +
      "Baseline an occurrence only when the GUARD IS NOT THE VALUE —\n" +
      "`params.port !== undefined ? { AAI_GUEST_PORT: String(params.port) }`\n" +
      'would stringify undefined into "undefined", and\n' +
      "`opts.mode !== undefined ? { mode: 0o700 }` sets a different value from\n" +
      "the one it tests. Those are the only three in the repo.",
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
];
