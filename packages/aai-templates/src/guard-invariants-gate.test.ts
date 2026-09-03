// Copyright 2026 the AAI authors. MIT license.
/// <reference types="vite/client" />
/**
 * Every rule in `scripts/guard-invariants.mjs` must actually MATCH something.
 *
 * A guard whose entire success output is a checkmark fails silently: a pattern
 * that matches nothing prints `allowed=0 now=0 ✓` and reads exactly like a rule
 * being upheld. This repo has been bitten by that twice already — two
 * escape-hatch patterns used `\b`, which is a GNU extension git's matcher does
 * not implement, so they matched NOTHING for months while the gate reported
 * success over a tree holding 110 violations; and rule 4 here shipped its first
 * draft with `[^)]*` between `new Promise(` and `setTimeout(`, which cannot
 * cross the arrow's own parameter list, so it reported 0 against five real
 * occurrences.
 *
 * So this suite feeds each rule a POSITIVE sample — a line that must match —
 * and a NEGATIVE sample that must not, using the rule's own regex IMPORTED from
 * `scripts/guard-invariants-rules.mjs` rather than a copy. It is the same
 * reasoning as `test-assertion-gate.test.ts`: the gate's parser gets a spec
 * because the gate cannot report its own blindness.
 *
 * A third draft is worth recording, because it proves the point on itself. This
 * suite originally regex-scraped `re: "..."` out of the gate's source, and when
 * the rules moved into their own module it parsed ZERO rules — every per-rule
 * assertion went vacuous, and the only thing that caught it was the one
 * assertion with a floor (`toBeGreaterThanOrEqual(7)`). Hence the import, and
 * hence that floor.
 *
 * It lives in aai-templates for the reason the sibling gate specs do: this
 * package already owns the tests for repo-level scripts, and raw imports reach
 * them with no node types, which this package's tsconfig does not have.
 */

import { describe, expect, test } from "vitest";
import { ERE_UNSUPPORTED, GATE_WIRING, repoPathOf, sole } from "./_gate-support.ts";

/**
 * The shared ratchet ENGINE both baseline gates run on.
 *
 * Separate from `script` because this spec scrapes gate source: when the two
 * ratchets converged onto one engine, the `--update` refuse-to-raise assertion
 * stopped finding its string here and failed naming a mechanism that had only
 * MOVED. See the twin note in `escape-hatch-scope.test.ts`.
 */
const engine = sole(
  import.meta.glob("../../../scripts/_ratchet.mjs", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
);

const script = sole(
  import.meta.glob("../../../scripts/guard-invariants.mjs", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
);

const baseline: Record<string, unknown> =
  sole(
    import.meta.glob<Record<string, unknown>>("../../../scripts/guard-invariants-baseline.json", {
      import: "default",
      eager: true,
    }),
  ) ?? {};

interface RuleSamples {
  matches: string[];
  ignores: string[];
}

/**
 * A rule answered by a PARSE rather than by `git grep -E`.
 *
 * Its samples are SOURCE, not lines, which is why the `multilineMatches` field
 * this file used to carry is gone: that existed solely because rule 3's
 * positive sample could not be written in the wrapped form the code is written
 * in, and a line-based rule could only ever be asserted one line at a time.
 * A node rule's sample is parsed and scanned exactly the way the gate scans a
 * file, so there is one kind of sample and no second assertion.
 */
interface NodeRule {
  id: number;
  key: string;
  label: string;
  paths: string[];
  match: (node: object) => boolean;
  at?: (node: object) => object;
  samples?: RuleSamples;
}

interface LineRule {
  id: number;
  key: string;
  label: string;
  re: string;
  paths: string[];
  /**
   * Samples carried BY THE RULE, if it carries them.
   *
   * A widened pattern and the sample proving it widened otherwise land in two
   * packages, and rule 3 shipped for months with a single-line positive sample
   * while the rule was blind to the multi-line form the code is written in.
   * `SAMPLES` below is this file's table and stays as the fallback for every
   * rule that does not carry its own; `sampleFor` prefers the rule's.
   */
  samples?: RuleSamples;
}

/**
 * Every source file in the repo, for rule 16's pathspec check below.
 *
 * `query: "?raw"` is deliberately absent — only the KEYS are read, so eagerly
 * loading a few hundred modules' contents would be pure cost.
 */
const repoFiles = new Set(
  // Keys come back relative to THIS file, which Vite normalizes to the shortest
  // form (`../aai/host/session-core.ts`) — hence the rewrite rather than a
  // `../../packages/` pattern, whose keys are the same string either way.
  Object.keys(import.meta.glob("../../*/**/*.ts")).map(repoPathOf),
);

/**
 * The rules, IMPORTED — not scraped out of the source.
 *
 * `guard-invariants-rules.mjs` exists to be importable: it has no side effects,
 * where the gate itself runs a scan and calls `process.exit` on import. An
 * earlier draft of this suite regex-matched `re: "..."` out of the script, and
 * it broke in exactly the predicted way the moment the rules moved into their
 * own module — it parsed zero rules and every per-rule assertion went vacuous,
 * which is the blindness this file exists to prevent, in this file. Real values
 * cannot go stale or half-parse.
 *
 * Read once, as a value: the glob is an eager import, so nine call sites calling
 * it as a function only re-ran the `Object.values` and the `?? []` fallback.
 */
const shippedLineRules: LineRule[] =
  sole(
    import.meta.glob<LineRule[]>("../../../scripts/guard-invariants-rules.mjs", {
      import: "LINE_RULES",
      eager: true,
    }),
  ) ?? [];

/**
 * The NODE rules, imported the same way and for the same reason.
 *
 * They are a separate export because they are SCANNED differently and by
 * nothing else — same baseline, same budgets, same failure report — so every
 * assertion below that is about a rule's identity (a key, a baseline entry, a
 * sample) has to see both lists, and only the two that are about a PATTERN are
 * line-rule-shaped.
 */
const shippedNodeRules: NodeRule[] =
  sole(
    import.meta.glob<NodeRule[]>("../../../scripts/guard-invariants-rules.mjs", {
      import: "NODE_RULES",
      eager: true,
    }),
  ) ?? [];

/** Every rule with a baseline key, whichever engine answers it. */
const shippedRules: (LineRule | NodeRule)[] = [...shippedLineRules, ...shippedNodeRules];

/**
 * `matchesIn` from the node-rule ENGINE, so a sample is scanned exactly the way
 * a repo file is.
 *
 * A hand-rolled walk here would be a second implementation of the thing under
 * test, which is the mistake this suite's own third-draft note records in
 * another form — it used to regex-scrape the rules out of the gate's source.
 */
const astScan = sole(
  import.meta.glob<{
    matchesIn: (
      rule: Pick<NodeRule, "match" | "at">,
      file: string,
      source: string,
    ) => { file: string; line: number; text: string }[];
  }>("../../../scripts/_ast-scan.mjs", { eager: true }),
);

/**
 * One positive and one negative sample per rule, keyed by the rule's `key`.
 *
 * The positives are written to look like the real anti-pattern rather than
 * minimally satisfying the regex — a sample tuned to the pattern would pass
 * even if the pattern had drifted away from the code it is meant to catch.
 */
const SAMPLES: Record<string, RuleSamples> = {
  rule2_spreadTernary: {
    matches: [
      "    ...(body !== undefined ? { body } : {}),",
      "      ...(params.port !== undefined ? { AAI_GUEST_PORT: String(params.port) } : {}),",
      // All three spellings of one idiom. The rule shipped seeing only the
      // first, which is why it scored 8 raw hits against 45: the inverted
      // ternary and the `&&` form are the same conditional spread written by
      // authors who reached for a different operator, and both were invisible.
      // A pattern that sees one spelling of three reports a healthy count and
      // grades a fifth of the tree.
      "    ...(opts.name === undefined ? {} : { name: opts.name }),",
      "      ...(limits.cpu !== undefined && { cpu: limits.cpu }),",
      "    ...(opts.extraAppDbClusters !== undefined && {",
    ],
    ignores: [
      "    ...omitUndefined({ body }),",
      "    ...(flag ? { a: 1 } : { a: 2 }),",
      // Both are real lines, and both must stay spared for the same reason:
      // `omitUndefined` cannot express them. The first spreads an ARRAY, which
      // has no key to omit; the second tests a compound condition rather than
      // mere presence, so the guard is not the value.
      '        ...(opts.system === undefined ? [] : [{ role: "system", content: opts.system }]),',
      "    ...(opts.languages !== undefined && opts.languages.length > 0",
    ],
  },
  rule5_deleteProcessEnv: {
    matches: ['    delete process.env["AAI_API_KEY"];', "    delete process.env.AAI_API_KEY;"],
    ignores: ['    vi.stubEnv("AAI_API_KEY", undefined);'],
  },
  // No `rule6_templateStateCast` entry: rule 6 was retired when `ctx.state`
  // stopped existing, and its sample outlived it here for exactly as long as
  // nothing asserted the converse. "Every rule has samples" leaves dead samples
  // free to accumulate, each of them a positive/negative pair run against no
  // rule at all — see "every local sample names a shipped rule" below.
  rule11_hardcodedTmp: {
    matches: ["  const file = `/tmp/aai-bundle.mjs`;", '  harnessPath: "/tmp/harness.mjs",'],
    ignores: [
      "  const file = join(tmpdir(), name);",
      '  const dir = mkdtempSync(join(os.tmpdir(), "aai-"));',
    ],
  },
  rule8_handRolledOwnedMap: {
    matches: ["      if (held.refs === 0 && entries.get(key) === held) entries.delete(key);"],
    ignores: ["      release();", "      if (map.get(key) === mine) return;"],
  },
  rule9_handRolledKeyedLock: {
    matches: ["    const prev = tails.get(key) ?? Promise.resolve();"],
    ignores: ["    const release = await lock(key);"],
  },
  rule16_sessionCallbackName: {
    matches: [
      // The three shapes the surface was declared in — a method signature on
      // `SessionCore`, an optional one on `TransportCallbacks`, and a harness
      // stub. All three had to be edited to add one observer, which is the
      // multiplier the rule exists to hold.
      "  onUserTranscript(text: string): void;",
      "  onAgentTranscriptPartial?(text: string): void;",
      "    onSpeechStarted: vi.fn(),",
      "    onReplyDone: () => bindCore().onReplyDone(),",
      "  onSessionEnd?: (sessionId: string, sink?: ClientSink) => void;",
      "    onSpeechStopped() {",
    ],
    ignores: [
      // The surface that replaced them.
      "  report(event: TransportEventBody): void;",
      "    report: vi.fn(),",
      '      callbacks.report({ type: "speech.started" });',
      // A CALL of a local function, not a declaration of a surface. Both of
      // these are real lines in scoped files, and matching either would put
      // permanent noise in the baseline — `onWake` is `_timer.ts`'s, which is
      // also the worked example for "a utility taking an `on*` parameter is
      // ordinary decomposition, not a session surface".
      "        onReplyCompleted();",
      "  function onWake(): void {",
      "      onElapsed();",
      // A member ACCESS, which is how every remaining call site reads.
      "      opts.callbacks.onAudioChunk(bytes);",
    ],
  },
  rule17_openCodedRecordGuard: {
    matches: [
      // Both operand orders, and a dotted operand — three of the twelve sites
      // this replaced were the reversed form, so a one-way pattern would have
      // left a quarter of them representable.
      '  return typeof value === "object" && value !== null && !Array.isArray(value);',
      '  if (body !== null && typeof body === "object") {',
      '    const ok = typeof opts.input === "object" && opts.input !== null;',
      // The NEGATED DISJUNCTION, in both operand orders — and this is the form
      // the codebase actually writes, because the idiom appears as an early
      // return in a guard clause rather than as a boolean. The positive-only
      // pattern graded 8 lines while 28 of these went unseen: a 20:1 miss that
      // reported a clean ✓. Whichever polarity a rule is written in, the other
      // one is where the code lives.
      '  if (typeof value !== "object" || value === null) return null;',
      '  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {',
    ],
    ignores: [
      "  if (!isRecord(body)) return undefined;",
      // Each half ALONE is not this idiom and must stay spared — a bare
      // `typeof x !== "object"` is a type test, and a bare `x === null` is a
      // null check. Only the conjunction (or its negated disjunction) is the
      // duck-typing guard `isRecord` replaces.
      '  if (typeof value !== "object") return null;',
      "  if (value === null) return null;",
      // Ordinary narrowing of a union the compiler ALREADY knows, which is why
      // the `!== null` half is in the pattern. Both are real lines: the first is
      // `server.address()`'s `AddressInfo | string | null`, the second a
      // declared `exports` entry in `studio-build.ts`. Matching either would put
      // permanent noise in the baseline for checks that are not duck-typing.
      '        listenPort = typeof addr === "object" && addr ? addr.port : port;',
      '  return typeof root === "object" ? root.types : undefined;',
    ],
  },
  rule18_splitOnQuestionMark: {
    matches: [
      // Both halves — the truncating query cut and the path cut with its dead
      // fallback — and the parenthesised receiver, which is how three of the
      // path sites were written.
      '    const params = new URLSearchParams((req.url ?? "").split("?")[1] ?? "");',
      '    const url = req.url?.split("?")[0] ?? "/";',
      '    const url = (req.url ?? "/").split("?")[0] ?? "/";',
    ],
    ignores: [
      "    const params = requestQuery(req.url);",
      "    const url = requestPath(req.url);",
      // Splitting on something else entirely. The rule is about the "?" cut,
      // not about `split`, so neither of these may be swept in.
      '    const [name] = header.split(";");',
      '    const segments = pathname.split("/");',
    ],
  },
};

/**
 * The samples a rule is checked against: the rule's own where it carries them,
 * this file's table otherwise.
 */
const sampleFor = (rule: LineRule | NodeRule): RuleSamples | undefined =>
  rule.samples ?? SAMPLES[rule.key];

describe("guard-invariants gate", () => {
  test("the script and baseline are readable", () => {
    expect(script, "scripts/guard-invariants.mjs not found").toBeTypeOf("string");
    expect(baseline._description, "the baseline has no _description").toBeTypeOf("string");
  });

  test("every line rule parses to a valid regex", () => {
    expect(
      shippedLineRules.length,
      "no line rules parsed — has the rule shape changed?",
    ).toBeGreaterThanOrEqual(7);
    for (const { id, key, re } of shippedLineRules) {
      expect(key, `rule ${id} parsed with an empty key`).not.toBe("");
      expect(() => new RegExp(re), `rule ${id}'s pattern is not a valid regex`).not.toThrow();
    }
  });

  test("every rule has samples", () => {
    // A rule added without samples would be untested, which is the state this
    // suite exists to make impossible. Either source counts, and BOTH engines
    // are covered — a node rule added with no samples is exactly as invisible
    // as a line rule with a dead pattern.
    expect(shippedRules.length, "no rules parsed").toBeGreaterThanOrEqual(20);
    for (const rule of shippedRules) {
      expect(
        sampleFor(rule),
        `rule ${rule.id} (${rule.key}) has no positive/negative samples`,
      ).toBeTypeOf("object");
    }
  });

  test("every local sample names a shipped rule", () => {
    // The converse, and it was missing: `rule6_templateStateCast` sat in
    // `SAMPLES` after rule 6 was retired, so a positive and a negative sample
    // were being maintained, read and trusted while matching against nothing.
    // A dead sample is worse than no sample — it reads as coverage, and only
    // the "every rule has samples" direction was ever asserted.
    // Across BOTH kinds: a rule that migrates from grep to a parse keeps its
    // key and brings its own samples, so a stale entry here is the same dead
    // coverage rule 6's was — it just arrives by a new route.
    const keys = new Set(shippedRules.map((r) => r.key));
    expect(keys.size, "no rules parsed").toBeGreaterThanOrEqual(20);
    for (const key of Object.keys(SAMPLES)) {
      expect(keys, `SAMPLES has "${key}", which is not a shipped rule — retired?`).toContain(key);
    }
  });

  test.each(shippedLineRules)("rule $id ($key) matches its anti-pattern", (rule) => {
    const samples = sampleFor(rule);
    if (samples === undefined) expect.fail(`rule ${rule.key} has no samples`);
    for (const line of samples.matches) {
      expect(
        new RegExp(rule.re).test(line),
        `rule ${rule.key} does NOT match a line it must catch — the pattern is dead:\n  ${line}`,
      ).toBe(true);
    }
  });

  test.each(shippedLineRules)("rule $id ($key) spares its legitimate twin", (rule) => {
    const samples = sampleFor(rule);
    if (samples === undefined) expect.fail(`rule ${rule.key} has no samples`);
    for (const line of samples.ignores) {
      expect(
        new RegExp(rule.re).test(line),
        `rule ${rule.key} matches a line it must NOT flag:\n  ${line}`,
      ).toBe(false);
    }
  });

  test("no pattern uses a GNU-only regex construct", () => {
    // The patterns are validated HERE with JavaScript's `new RegExp` and
    // SHIPPED to `git grep -nIE` — POSIX ERE, whose GNU-extension support
    // varies by build. `\b` is the one already paid for: two escape-hatch
    // patterns carried one, matched nothing on the machines where git's matcher
    // does not implement it, and the gate reported success over a tree holding
    // 110 violations. So every construct ERE has no answer for is banned, not
    // just `\b` — from the one list `escape-hatch-scope.test.ts` bans over its
    // own patterns, so neither gate can be the one that missed an addition.
    expect(shippedLineRules.length, "no line rules parsed").toBeGreaterThanOrEqual(7);
    for (const { id, re } of shippedLineRules) {
      for (const [construct, why] of ERE_UNSUPPORTED) {
        expect(re, `rule ${id} uses ${construct} — ${why}`).not.toContain(construct);
      }
    }
  });

  test("rule 16's hand-kept path list names files that exist", () => {
    // Rule 16 is the one rule scoped to an explicit file list rather than to a
    // directory pathspec, because "declares the SESSION's callback surface" is
    // not derivable from a path — `transports/types.ts` does and its neighbour
    // `transports/pipeline-llm-stream.ts` does not. The price of that is a list
    // that a rename empties silently: a `git grep` pathspec matching nothing
    // reports `now=0 ✓`, which reads exactly like the rule being upheld.
    const rule16 = shippedLineRules.find((r) => r.id === 16);
    expect(rule16, "rule 16 is not in LINE_RULES").toBeTypeOf("object");
    expect(rule16?.paths.length, "rule 16 scans nothing").toBeGreaterThanOrEqual(10);
    expect(repoFiles.size, "no package sources discovered").toBeGreaterThan(100);
    for (const path of rule16?.paths ?? []) {
      expect(repoFiles, `rule 16 scans "${path}", which does not exist`).toContain(path);
    }
  });

  test("baseline keys name real rules", () => {
    const keys = new Set(shippedRules.map((r) => r.key));
    for (const key of Object.keys(baseline)) {
      if (key.startsWith("_")) continue;
      expect(keys, `the baseline names "${key}", which is not a shipped rule`).toContain(key);
    }
  });

  test("--update refuses to raise a count", () => {
    // Same contract as the escape-hatch ratchet: without this, every failure
    // would have a one-command bypass and the reviewable diff that gates a
    // deliberate increase would never be produced.
    expect(engine).toContain("refusing to RAISE");
  });

  test("the gate still runs on the shared ratchet engine", () => {
    // The assertion above now reads `_ratchet.mjs`, so alone it would pass for
    // a gate that had stopped using the engine — checking a file nothing runs.
    expect(script).toContain("_ratchet.mjs");
  });

  test("every node rule carries a match function and no dead pattern fields", () => {
    // A `re` or a `skipComments` on a node rule would be SILENTLY IGNORED —
    // `scanNodeGroups` never reads either — which is the gate's own recurring
    // failure shape wearing a new hat: a rule that looks configured and is not.
    expect(
      shippedNodeRules.length,
      "no node rules parsed — has the rule shape changed?",
    ).toBeGreaterThanOrEqual(6);
    for (const rule of shippedNodeRules) {
      expect(rule.key, `rule ${rule.id} parsed with an empty key`).not.toBe("");
      expect(rule.match, `rule ${rule.id} has no match function`).toBeTypeOf("function");
      expect(rule, `rule ${rule.id} carries an "re", which a node rule ignores`).not.toHaveProperty(
        "re",
      );
      expect(
        rule,
        `rule ${rule.id} carries "skipComments", which a node rule ignores — a comment is not a node`,
      ).not.toHaveProperty("skipComments");
    }
  });

  test("no rule id is claimed by both engines", () => {
    // Ids are stable identifiers quoted in commits and in the baseline's
    // history. A migration MOVES a rule between the two lists; a copy-paste
    // that left the original behind would double-count every occurrence
    // against one budget and read as a rule that suddenly regressed.
    const ids = shippedRules.map((r) => r.id).sort((a, b) => a - b);
    expect(new Set(ids).size, `a rule id appears twice: ${ids.join(", ")}`).toBe(ids.length);
  });

  test.each(shippedNodeRules)("rule $id ($key) matches its anti-pattern", (rule) => {
    const samples = sampleFor(rule);
    if (samples === undefined) expect.fail(`rule ${rule.key} has no samples`);
    for (const source of samples.matches) {
      expect(
        astScan?.matchesIn(rule, "sample.ts", source).length ?? 0,
        `rule ${rule.key} does NOT match source it must catch — the rule is dead:\n${source}`,
      ).toBeGreaterThan(0);
    }
  });

  test.each(shippedNodeRules)("rule $id ($key) spares its legitimate twin", (rule) => {
    const samples = sampleFor(rule);
    if (samples === undefined) expect.fail(`rule ${rule.key} has no samples`);
    for (const source of samples.ignores) {
      expect(
        astScan?.matchesIn(rule, "sample.ts", source) ?? [],
        `rule ${rule.key} matches source it must NOT flag:\n${source}`,
      ).toEqual([]);
    }
  });

  test("the gate scans both engines", () => {
    // The line half is asserted above by `_ratchet.mjs`. This is its twin: a
    // node rule that is defined, sampled and never SCANNED would pass every
    // assertion in this file while checking nothing in the tree.
    expect(script).toContain("scanNodeGroups");
    expect(script).toContain("NODE_RULES");
  });

  test("the gate is wired into both the local check and CI", () => {
    // The repo has been here before: the quality ratchets lived only in
    // the local check script, which CI never invokes, so `git push --no-verify`
    // skipped them.
    for (const [path, text] of Object.entries(GATE_WIRING)) {
      expect(text, `${path} not found`).toBeTypeOf("string");
      expect(text, `${path} no longer references check:invariants`).toContain("check:invariants");
    }
  });
});
