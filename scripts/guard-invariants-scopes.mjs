/**
 * WHERE each `guard-invariants` rule looks — the five corpora, in one place.
 *
 * Split out of `guard-invariants-rules.mjs` at the 500-line cap, and the seam
 * is the one the gate's own history argues for: every scope here is something
 * `assertScanCorpus` must FLOOR, and three of the five were unfloored precisely
 * because they were spelled inline on a rule where nobody counting the floors
 * would see them. Named and exported, they are countable.
 *
 * A git pathspec is fnmatch WITHOUT `FNM_PATHNAME`, so a `*` already crosses
 * `/`. Verify any glob here with `git ls-files "<glob>"`, never by reading it.
 */

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
/**
 * The one file declaring `ToolContext` — the per-CALL context handed to every
 * tool body, and the type rule 24 keeps from growing.
 *
 * A single path rather than a glob, because "is this the tool context" is not
 * derivable from a filename; the gate spec asserts it exists so a rename cannot
 * silently empty the corpus.
 */
export const TOOL_CONTEXT_PATHS = ["packages/aai/src/sdk/tool-context.ts"];

/**
 * The platform-neutral channel message shape — `ChannelMessage` and
 * `ChannelSection`, the fields every channel kind must render.
 *
 * One file, for the reason `TOOL_CONTEXT_PATHS` is one: role is not derivable
 * from a path, and the gate spec asserts it exists so a rename cannot empty the
 * corpus silently.
 */
export const CHANNEL_MESSAGE_PATHS = ["packages/aai/src/sdk/channels/channel-types.ts"];

export const SESSION_SURFACE_PATHS = [
  "packages/aai-runtime/src/session-core.ts",
  "packages/aai-runtime/src/session-commands.ts",
  "packages/aai-runtime/src/transports/types.ts",
  "packages/aai-runtime/src/runtime-types.ts",
  "packages/aai-runtime/src/runtime-session-callbacks.ts",
  "packages/aai-runtime/src/runtime.ts",
  "packages/aai-runtime/src/ws-handler.ts",
  // The doubles. A per-name callback surface has a MULTIPLIER: every harness
  // standing in for the thing that fires a callback has to satisfy its whole
  // shape, and 78 of the original 157 occurrences were exactly that.
  "packages/aai/src/host/_test-utils.ts",
  "packages/aai-runtime/src/transports/_transport-recorder.ts",
  "packages/aai-runtime/src/transports/_pipeline-transport-harness.ts",
  "packages/aai-runtime/src/integration/_pipeline-fuzz-model.ts",
  "packages/aai-runtime/src/integration/_s2s-fuzz-harness.ts",
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
 * under `packages/` is at least one directory deep.
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
  ":!packages/*/src/contracts/compatibility/**",
];

/**
 * SHIPPED source only — a THIRD corpus, walked by rules 11 and 27.
 *
 * Named and exported rather than spelled inline on the rule, because neither
 * `assertScanCorpus` call covered it — the gate floored `SOURCE_PATHSPECS` and
 * rule 16's file list and left the ~1,027 files rule 11 actually walks
 * unfloored. That is the Windows-portability rule, the one whose regressions
 * are invisible on every machine that runs CI, so a silently-empty scan there
 * is the least detectable of the family.
 *
 * Both rules here are about a hazard only REAL execution has, which is what
 * makes the test exclusion part of the definition rather than noise reduction.
 * Rule 11's is a filesystem write, and a spec handing `"/tmp/watched"` to a
 * fake chokidar never touches the disk — eight files' worth of those made the
 * first draft of that rule pure noise. Rule 27's is a resource whose lifetime
 * outlives its scope, and in a spec the dispose call is routinely the SUBJECT
 * (`test("Symbol.asyncDispose releases the audio resources")`) or a stimulus
 * ("the sandbox dies, the client re-brokers") rather than a teardown anybody
 * should have written as `using`.
 *
 * **`*.test.tsx` was in the corpus for as long as it existed**, and the name
 * says it should not have been: 41 studio-client and aai-ui suites, measured
 * with `git ls-files` against the pathspec list. It cost rule 11 nothing only
 * because none of them writes a `/tmp` literal — but the exclusion beside it
 * has always been `*.test.ts`, so a `.tsx` spec was one extension away from
 * every finding this corpus exists to keep out, and rule 27 would have opened
 * with two baselined test files on day one. The `_*test-utils.ts` twin needs
 * no `.tsx` spelling: there is no such file, and `git ls-files` says so.
 */
export const SHIPPED_SOURCE_PATHSPECS = [
  ...SOURCE_PATHSPECS,
  ":!packages/**/*.test.ts",
  ":!packages/**/*.test.tsx",
  ":!packages/**/_*test-utils.ts",
];

/**
 * Rule 13's scope, exported for the same reason: it had no floor at all.
 *
 * And this half is SILENT where the grep half is not — `git ls-files` exits 0
 * on a pathspec that matches nothing, where `git grep` exits 1. A rename of
 * `templates/` therefore left the scanner walking zero of 175 files and
 * printing `rule 13  template import escaping its template  0 ✓`.
 */
/**
 * Rule 28's scope: the gate scripts themselves.
 *
 * BOTH spellings, and the reason is the trap `check-file-length.mjs` documents
 * and this repo has now paid for three times: a git pathspec is fnmatch WITHOUT
 * `FNM_PATHNAME`, so `*` already crosses `/` and the literal slash in
 * `scripts/**` + `/` + `*.mjs` makes a subdirectory MANDATORY. On its own that
 * glob matched only `scripts/starter-eval/` and not one of the ~60 files at the
 * top level of `scripts/` — which is every gate this rule is about.
 *
 * That subdirectory is gone (its corpus is `packages/aai-evals` now), so the
 * nested spelling resolves ZERO and `scripts/*.mjs` alone resolves all 69 —
 * it crosses `/`, so it always covered the nested file too. Both stay: the
 * corpus floor below is on the COMBINED set, and the pair is what stops the
 * next nested script from being invisible. Verify with `git ls-files`.
 *
 * `.sh` is deliberately absent. A shell script has no `process.argv` and its own
 * `$1`-shaped hazards are a different rule; `check.sh` was the one that mattered
 * and it is `check.mjs` now.
 */
export const SCRIPT_PATHSPECS = ["scripts/*.mjs", "scripts/**/*.mjs"];

export const TEMPLATE_PATHSPECS = ["packages/aai-templates/templates"];

/**
 * Rule 33's scope: this repo's own test files.
 *
 * `.tsx` is listed separately and not folded into a brace pattern, because a
 * git pathspec is fnmatch and the 43 `.test.tsx` files are all in `aai-ui` and
 * `aai-studio-client` — the two packages whose specs render components, which
 * is exactly where a tautological assertion would be least noticed.
 *
 * Both globs already require a directory under `packages/`, which every test
 * file has, so neither hits the missing-`scripts/*.mjs` trap that
 * {@link SCRIPT_PATHSPECS} records. Verified with `git ls-files`: 807 + 43.
 */
export const TEST_FILE_PATHSPECS = ["packages/**/*.test.ts", "packages/**/*.test.tsx"];

/**
 * Rule 26's scope: the shipped WORKFLOW BODIES — every `workflows/*.ts` in a
 * template.
 *
 * A directory rather than a file list, and unlike rules 12 and 16 the role IS
 * derivable from the path: `workflows/` is where the WDK builder looks for a
 * `"use step"` body, so a module there is a step module by construction. That
 * is also why the rule cannot simply scan every file naming `stepGenerate` —
 * the SDK's own `sdk/step-errors.ts` calls all six of them, which is what the
 * wrappers ARE.
 *
 * `*` crosses `/` in a pathspec, so this reaches `templates/x/workflows/y.ts`
 * and would also reach a nested one. `git ls-files` it rather than reading it.
 */
export const WORKFLOW_BODY_PATHSPECS = ["packages/aai-templates/templates/*/workflows/*.ts"];

/**
 * Rule 12's scope: the files that make up the GUEST'S HTTP SURFACE.
 *
 * **`packages/aai-guest` alone is not it, and that was the rule's live gap.**
 * Measured: the guest package holds 8 route literals while `GUEST_ROUTES`
 * declares 15. The other seven — `/health`, `/websocket`, `/phone`,
 * `/client-config`, `/workflows`, `/session-events` and the
 * `/.well-known/workflow/v1/` prefix — are implemented in `packages/aai/src/host`
 * and BUNDLED BY the guest, which is where the surface actually grows. Adding
 * `if (url === "/metrics")` to `host/server.ts` is served by every guest and
 * was invisible to the rule written to catch exactly that.
 *
 * A file list rather than a directory glob, for rule 16's reason: "serves an
 * HTTP route" is not derivable from a path, and a glob over `host/` would drag
 * in every module that happens to hold a slash-leading string. The corpus floor
 * in the gate is what stops a rename emptying it silently.
 */
/**
 * The `aai-runtime` modules that DECLARE a route the guest serves.
 *
 * Named separately from the pathspecs below because rule 12 reads them twice
 * and for opposite purposes: they are scanned for INLINE literals (which is the
 * gap the rule exists for — a route added to `server.ts` is served by every
 * guest), and they are read again to resolve the `export const` a table entry in
 * `server-routes.ts` references. One list, so a module can never be scanned
 * without also being resolvable, which would report its own declaration as a
 * violation.
 */
export const RUNTIME_ROUTE_SOURCES = [
  "packages/aai-runtime/src/server.ts",
  "packages/aai-runtime/src/server-routes.ts",
  "packages/aai-runtime/src/telephony/telephony-server.ts",
  "packages/aai-runtime/src/session-events-api.ts",
  "packages/aai-runtime/src/workflow-serve.ts",
  "packages/aai-runtime/src/workflow-queue-dispatch.ts",
];

export const GUEST_SURFACE_PATHSPECS = [
  // TypeScript only. A route literal is code, never config, and the bare
  // `packages/aai-guest` this replaced matched every file in the package —
  // including `turbo.json`, whose `"extends": ["//"]` is turbo's workspace-root
  // sentinel and which this rule read as a prefix dispatch with no declared
  // route under it. A false positive on a config file is how a rule gets
  // muted rather than fixed.
  //
  // Both spellings, and NOT as a style choice: a git pathspec is fnmatch
  // WITHOUT FNM_PATHNAME, so the literal slash in `**/*.ts` makes a
  // subdirectory mandatory. Most of this package's source sits directly in
  // `src/`, so `packages/aai-guest/src/**/*.ts` alone MISSES it — verified
  // with `git ls-files`. That is the same trap `check-file-length`'s
  // `scripts/**/*.mjs` fell into; the corpus floor below is what turns a
  // future recurrence into a failure instead of a checkmark.
  "packages/aai-guest/src/*.ts",
  "packages/aai-guest/src/**/*.ts",
  ":!packages/aai-guest/dist/**",
  // Both spellings again: the suites sit directly in `src/`, which
  // `src/**/*.test.ts` does not match on its own.
  ":!packages/aai-guest/src/*.test.ts",
  ":!packages/aai-guest/src/**/*.test.ts",
  ...RUNTIME_ROUTE_SOURCES,
  "packages/aai/src/sdk/workflow-api-client.ts",
];

/**
 * Rule 29's scope: the RUNTIME's own shipped source.
 *
 * `packages/aai-runtime` and nothing else, and the narrowness is the rule being
 * honest rather than the rule being weak. The remedy — `egressFetch`, the pooled
 * HTTP/1.1 fetch in `_egress-fetch.ts` — is a module of THIS package, so a
 * `globalThis.fetch` fallback in `aai-cli`, `aai-server` or `aai-studio-server`
 * (there are five, all single small JSON calls made outside a guest) has no
 * remedy to point at, and a baselined occurrence with no fix available is a
 * rule that trains readers to ignore it.
 *
 * Widen it the day one of those packages grows a pool of its own. What makes
 * this the right corpus TODAY is that the fan-out shape lives here: a part
 * claim's 32 concurrent bucket probes, a workflow's window reads, and a
 * long-lived run-event stream, all to one origin.
 *
 * Both pathspec shapes for the trap this file opens with — a git pathspec is
 * fnmatch WITHOUT `FNM_PATHNAME`, so the literal slash in `**` + `/` + `*.ts`
 * makes a subdirectory mandatory, and most of this package's modules sit directly
 * in `src/`. `git ls-files` it rather than reading it.
 */
export const RUNTIME_EGRESS_PATHSPECS = [
  "packages/aai-runtime/src/*.ts",
  "packages/aai-runtime/src/**/*.ts",
  ":!packages/aai-runtime/dist/**",
  ":!packages/aai-runtime/src/*.test.ts",
  ":!packages/aai-runtime/src/**/*.test.ts",
  ":!packages/aai-runtime/src/_*test-utils.ts",
  ":!packages/aai-runtime/src/contracts/**",
];

/**
 * The floors under every scan — see `_ratchet.mjs` on why they measure the
 * CORPUS.
 *
 * EIGHT of them, because the rules walk eight different scopes and only two
 * were floored. Each number is set well below the measured actual, recorded beside
 * it, so ordinary movement in the tree does not trip a floor while a scan that
 * has gone blind does.
 *
 * The three that were missing are the interesting ones. Rule 11's is a THIRD
 * source corpus (shipped source only) that neither existing call covered, and
 * it is the Windows-portability rule — the one whose regressions are invisible
 * on every machine that runs CI. Rules 12 and 13 derive their corpus from
 * `git ls-files`, which exits **0** on a pathspec matching nothing where
 * `git grep` exits 1: that asymmetry is exactly why the grep-based rules
 * announced their own blindness and these two could not.
 *
 * A TABLE rather than seven near-identical calls, so a new scope is one row and
 * cannot be added without a floor — which is how three of these came to be
 * missing: they were spelled inline on a rule, where nobody counting floors
 * would see them.
 *
 * **It lives HERE rather than in the gate, beside the corpora it floors**, which
 * is the same argument one level up: the gate reached the 500-line cap and this
 * was the seam the file already had, and a floor spelled in a different module
 * from the pathspecs it measures is how three of them went missing in the first
 * place. Data only — this module stays side-effect-free so the gate's own spec
 * can import it without running a scan.
 */
export const SCAN_CORPORA = [
  { what: "the line-rule source scan", pathspecs: SOURCE_PATHSPECS, minFiles: 800 }, // ~1,530
  { what: "rules 11+27's shipped-source scan", pathspecs: SHIPPED_SOURCE_PATHSPECS, minFiles: 600 }, // 1,224
  // An explicit file list, so every entry must resolve — the floor IS its length.
  {
    what: "rule 16's session-surface file list",
    pathspecs: SESSION_SURFACE_PATHS,
    minFiles: SESSION_SURFACE_PATHS.length,
  },
  { what: "rule 12's guest HTTP-surface scan", pathspecs: GUEST_SURFACE_PATHSPECS, minFiles: 20 }, // 32
  { what: "rule 13's template scan", pathspecs: TEMPLATE_PATHSPECS, minFiles: 100 }, // 175
  { what: "rule 33's test-file scan", pathspecs: TEST_FILE_PATHSPECS, minFiles: 600 }, // 850
  {
    what: "rule 26's shipped workflow-body scan",
    pathspecs: WORKFLOW_BODY_PATHSPECS,
    minFiles: 15,
  }, // 24
  // Both pathspec shapes: the nested one resolves ZERO now and `scripts/*.mjs`
  // carries the whole corpus — see SCRIPT_PATHSPECS for why the pair stays.
  { what: "rule 28's gate-script scan", pathspecs: SCRIPT_PATHSPECS, minFiles: 50 }, // 69
  // Both pathspec shapes again — most of this package's modules sit at the top
  // level, so the doublestar form alone misses them.
  {
    what: "rule 29's runtime-egress scan",
    pathspecs: RUNTIME_EGRESS_PATHSPECS,
    minFiles: 120,
  }, // 210
];
