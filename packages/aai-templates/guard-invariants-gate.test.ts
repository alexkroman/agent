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

/**
 * The shared ratchet ENGINE both baseline gates run on.
 *
 * Separate from `script` because this spec scrapes gate source: when the two
 * ratchets converged onto one engine, the `--update` refuse-to-raise assertion
 * stopped finding its string here and failed naming a mechanism that had only
 * MOVED. See the twin note in `escape-hatch-scope.test.ts`.
 */
const engine = import.meta.glob("../../scripts/_ratchet.mjs", {
  query: "?raw",
  import: "default",
  eager: true,
})["../../scripts/_ratchet.mjs"];

const script = import.meta.glob("../../scripts/guard-invariants.mjs", {
  query: "?raw",
  import: "default",
  eager: true,
})["../../scripts/guard-invariants.mjs"];

const baseline: Record<string, unknown> =
  Object.values(
    import.meta.glob<Record<string, unknown>>("../../scripts/guard-invariants-baseline.json", {
      import: "default",
      eager: true,
    }),
  )[0] ?? {};

interface RuleSamples {
  matches: string[];
  ignores: string[];
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
  Object.keys(import.meta.glob("../*/**/*.ts")).map((k) => k.replace(/^\.\.\//, "packages/")),
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
 */
const shippedLineRules = (): LineRule[] =>
  Object.values(
    import.meta.glob<LineRule[]>("../../scripts/guard-invariants-rules.mjs", {
      import: "LINE_RULES",
      eager: true,
    }),
  )[0] ?? [];

/**
 * One positive and one negative sample per rule, keyed by the rule's `key`.
 *
 * The positives are written to look like the real anti-pattern rather than
 * minimally satisfying the regex — a sample tuned to the pattern would pass
 * even if the pattern had drifted away from the code it is meant to catch.
 */
const SAMPLES: Record<
  string,
  { matches: string[]; ignores: string[]; multilineMatches?: string[] }
> = {
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
  rule3_raceTimeout: {
    matches: [
      "  const won = await Promise.race([work, new Promise((_, r) => setTimeout(r, ms))]);",
    ],
    // The form Biome actually produces once the race does not fit on one line,
    // which is how every real occurrence in this tree is written. See the
    // multi-line assertion that consumes this.
    multilineMatches: [
      [
        "  const won = await Promise.race([",
        "    work,",
        "    new Promise((_, reject) => setTimeout(reject, ms)),",
        "  ]);",
      ].join("\n"),
      [
        "    await Promise.race([",
        "      settled,",
        "      new Promise((resolve) => {",
        "        setTimeout(resolve, GRACE_MS);",
        "      }),",
        "    ]);",
      ].join("\n"),
    ],
    // The legitimate race this rule must not break: no timer in it.
    ignores: [
      "  const outcome = await Promise.race([work.then((value) => ({ value })), exited]);",
      "  return pTimeout(work, { milliseconds: ms });",
    ],
  },
  rule4_inlineTickPromise: {
    matches: [
      "    await new Promise((resolve) => setTimeout(resolve, 0));",
      "  return new Promise((r) => setTimeout(r, 0));",
      // A TYPE ARGUMENT, which a literal `(` after `new Promise` cannot cross —
      // five live occurrences across aai, aai-ui and the two fuzz harnesses.
      // Rule 4's own comment celebrates fixing a draft that "reported 0 against
      // five real occurrences"; the fixed version reports 0 against five
      // different ones, for an adjacent reason.
      "  return new Promise<void>((r) => setTimeout(r, 0));",
      // The OTHER zero-length yield, which neither timer rule knows: eight live
      // occurrences. It takes no delay, so it can only ever be rule 4's.
      "    await new Promise((r) => setImmediate(r));",
    ],
    // The 50ms twin is deliberately here AND in rule 19's `matches`: rule 4
    // owns the zero-length yield, rule 19 the nonzero sleep, and the samples
    // are only ever tested against their own rule. That the same line appears
    // on both sides is the split working, not a contradiction.
    ignores: ["    await flush();", "    await new Promise((r) => setTimeout(r, 50));"],
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
  rule19_handRolledSleep: {
    matches: [
      // A literal delay, a named one, and an EXPRESSION — the third is what the
      // first draft of the delay fragment could not see, and it is a real line
      // in a workflow fixture.
      "    await new Promise((resolve) => setTimeout(resolve, 250));",
      "  return new Promise((r) => setTimeout(r, ms));",
      "  await new Promise((resolve) => setTimeout(resolve, (8 - index) * 20));",
      // The type argument again, same gap as rule 4's.
      '    new Promise<"hung">((r) => setTimeout(r, 5000)),',
      // The other family: the one timer `vi.useFakeTimers()` cannot drive.
      '    import { setTimeout as sleep } from "node:timers/promises";',
      '    import { setTimeout as nodeSleep } from "node:timers/promises";',
    ],
    ignores: [
      "    await sleep(250);",
      "    await sleep(GUEST_DIAL_RETRY_MS, { unref: true });",
      "    await sleep(delayMs, omitUndefined({ signal }));",
      // Rule 4's shape, which this rule must NOT sweep in — a zero-length yield
      // has a different remedy (`flush()` vs `tick()`, and which one you meant).
      "    await new Promise((resolve) => setTimeout(resolve, 0));",
      "  return new Promise((r) => setTimeout(r, 0));",
      // A two-parameter executor supplying the comma. Without `[^,)]*` inside
      // the call the greedy `.*` reads `, r` as the delay and reports a yield as
      // a sleep.
      "    await new Promise((resolve, reject) => setTimeout(resolve, 0));",
      // Importing something else from the same module, which this rule has
      // nothing to say about.
      '    import { scheduler } from "node:timers/promises";',
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
const sampleFor = (rule: LineRule): RuleSamples | undefined => rule.samples ?? SAMPLES[rule.key];

describe("guard-invariants gate", () => {
  test("the script and baseline are readable", () => {
    expect(script, "scripts/guard-invariants.mjs not found").toBeTypeOf("string");
    expect(baseline._description, "the baseline has no _description").toBeTypeOf("string");
  });

  test("every line rule parses to a valid regex", () => {
    const rules = shippedLineRules();
    expect(
      rules.length,
      "no line rules parsed — has the rule shape changed?",
    ).toBeGreaterThanOrEqual(7);
    for (const { id, key, re } of rules) {
      expect(key, `rule ${id} parsed with an empty key`).not.toBe("");
      expect(() => new RegExp(re), `rule ${id}'s pattern is not a valid regex`).not.toThrow();
    }
  });

  test("every line rule has samples", () => {
    // A rule added without samples would be untested, which is the state this
    // suite exists to make impossible. Either source counts.
    for (const rule of shippedLineRules()) {
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
    const keys = new Set(shippedLineRules().map((r) => r.key));
    expect(keys.size, "no line rules parsed").toBeGreaterThanOrEqual(7);
    for (const key of Object.keys(SAMPLES)) {
      expect(keys, `SAMPLES has "${key}", which is not a shipped rule — retired?`).toContain(key);
    }
  });

  test.each(shippedLineRules())("rule $id ($key) matches its anti-pattern", (rule) => {
    const samples = sampleFor(rule);
    if (samples === undefined) expect.fail(`rule ${rule.key} has no samples`);
    for (const line of samples.matches) {
      expect(
        new RegExp(rule.re).test(line),
        `rule ${rule.key} does NOT match a line it must catch — the pattern is dead:\n  ${line}`,
      ).toBe(true);
    }
  });

  test.each(
    shippedLineRules().filter(({ key }) => (SAMPLES[key]?.multilineMatches?.length ?? 0) > 0),
  )("rule $id ($key) matches a REALISTIC multi-line occurrence", ({ key, re }) => {
    // The scan is `git grep -nIE`, which is LINE-BASED, so this asserts the
    // sample the way the gate would really see it: at least one line of it must
    // match on its own. A JS-side `dotAll` test would pass here and prove
    // nothing, because the shipped scanner can never look at two lines at once.
    //
    // Rule 3 is why this exists. Its only positive sample was a single line, so
    // the guard was green while the rule was blind to the wrapped form Biome
    // actually emits — the live occurrences are all written that way.
    const samples = SAMPLES[key]?.multilineMatches ?? [];
    for (const sample of samples) {
      expect(
        sample.split("\n").some((line) => new RegExp(re).test(line)),
        `rule ${key} sees NO line of an occurrence it must catch — a line-anchored\n` +
          `pattern cannot reach this shape:\n${sample}`,
      ).toBe(true);
    }
  });

  test.each(shippedLineRules())("rule $id ($key) spares its legitimate twin", (rule) => {
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
    // just `\b`.
    const banned = [
      ["\\b", "a word boundary — git's matcher does not implement it"],
      ["\\B", "a non-word-boundary — same GNU extension as \\b"],
      ["\\w", "a GNU character class; POSIX ERE spells it [A-Za-z0-9_]"],
      ["\\d", "a GNU character class; POSIX ERE spells it [0-9]"],
      ["\\s", "a GNU character class; POSIX ERE spells it [[:space:]]"],
      ["(?", "a JS-only group (lookaround or non-capturing); ERE has neither"],
      ["*?", "a lazy quantifier; ERE quantifiers are always greedy"],
      ["+?", "a lazy quantifier; ERE quantifiers are always greedy"],
    ] as const;
    const rules = shippedLineRules();
    expect(rules.length, "no line rules parsed").toBeGreaterThanOrEqual(7);
    for (const { id, re } of rules) {
      for (const [construct, why] of banned) {
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
    const rule16 = shippedLineRules().find((r) => r.id === 16);
    expect(rule16, "rule 16 is not in LINE_RULES").toBeTypeOf("object");
    expect(rule16?.paths.length, "rule 16 scans nothing").toBeGreaterThanOrEqual(10);
    expect(repoFiles.size, "no package sources discovered").toBeGreaterThan(100);
    for (const path of rule16?.paths ?? []) {
      expect(repoFiles, `rule 16 scans "${path}", which does not exist`).toContain(path);
    }
  });

  test("baseline keys name real rules", () => {
    const keys = new Set(shippedLineRules().map((r) => r.key));
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

  test("the gate is wired into both the local check and CI", () => {
    // The repo has been here before: the quality ratchets lived only in
    // check.sh, which CI never invokes, so `git push --no-verify` skipped them.
    const files: Record<string, string | undefined> = {
      "package.json": import.meta.glob("../../package.json", {
        query: "?raw",
        import: "default",
        eager: true,
      })["../../package.json"],
      "scripts/check.sh": import.meta.glob("../../scripts/check.sh", {
        query: "?raw",
        import: "default",
        eager: true,
      })["../../scripts/check.sh"],
      ".github/workflows/check.yml": import.meta.glob("../../.github/workflows/check.yml", {
        query: "?raw",
        import: "default",
        eager: true,
      })["../../.github/workflows/check.yml"],
    };
    for (const [path, text] of Object.entries(files)) {
      expect(text, `${path} not found`).toBeTypeOf("string");
      expect(text, `${path} no longer references check:invariants`).toContain("check:invariants");
    }
  });
});

/**
 * Rule 20 is a SCANNER, not a line rule, so the sample table above cannot reach
 * it — and a scanner is where the silent-blindness failure is worst: it reads
 * the real tree, and a healthy tree is exactly a tree with nothing to find. Its
 * whole success output is `0 ✓`, which is also what a scanner that had stopped
 * parsing frontmatter, or stopped finding `.changeset/*.md`, would print.
 *
 * So the per-file half is split out as `checkChangeset(file, source, known)` and
 * driven here with real samples. Rule 20's own subject is a gate that reports
 * success over a mistake — `pnpm changeset status` exits 0 on a typo'd package
 * name — so shipping it with a spec that could do the same would be the joke
 * writing itself.
 */
const changesets = Object.values(
  import.meta.glob<{
    checkChangeset: (
      file: string,
      source: string,
      known: Set<string>,
    ) => { file: string; line: number; text: string }[];
    checkChangesetConsumable: (
      file: string,
      source: string,
      versionable: Set<string>,
    ) => { file: string; line: number; text: string }[];
    workspacePackageNames: () => Set<string>;
    versionablePackageNames: () => Set<string>;
  }>("../../scripts/guard-invariants-changesets.mjs", { eager: true }),
)[0];

describe("guard-invariants rule 20 (changeset package names)", () => {
  const known = new Set(["@alexkroman1/aai", "aai-server"]);
  const check = (source: string) => changesets?.checkChangeset("c.md", source, known) ?? [];

  test.each([
    ["a package that does not exist", '---\n"@alexkroman1/aai-typo": patch\n---\n\nx\n'],
    ["a bump type that does not exist", '---\n"@alexkroman1/aai": pathc\n---\n\nx\n'],
    ["an unquoted unknown package", "---\naai-servr: patch\n---\n\nx\n"],
    ["no frontmatter at all", "just a summary\n"],
    ["frontmatter that never closes", '---\n"@alexkroman1/aai": patch\n\nx\n'],
  ])("flags %s", (_label, source) => {
    expect(check(source).length, "rule 20 found nothing in a bad changeset").toBeGreaterThan(0);
  });

  test.each([
    ["a valid single-package changeset", '---\n"@alexkroman1/aai": patch\n---\n\nx\n'],
    ["a private workspace package", '---\n"aai-server": minor\n---\n\nx\n'],
    ["an unquoted valid package", "---\naai-server: major\n---\n\nx\n"],
    // `pnpm changeset add --empty` is the documented way to say "no release".
    ["an empty frontmatter block", "---\n---\n\n"],
  ])("spares %s", (_label, source) => {
    expect(check(source), "rule 20 flagged a legitimate changeset").toEqual([]);
  });

  test("the workspace-name corpus is floored", () => {
    // Every name is checked by MEMBERSHIP in this set, so a derivation that has
    // gone blind must throw rather than let the comparison run against nothing.
    const names = changesets?.workspacePackageNames() ?? new Set();
    expect(names.size, "too few workspace packages discovered").toBeGreaterThanOrEqual(9);
    expect(names, "the SDK is not among the discovered packages").toContain("@alexkroman1/aai");
  });

  test("the rule is wired into the gate", () => {
    expect(script).toContain("scanChangesetPackageNames");
  });

  /**
   * The second half of rule 20: a changeset that names real packages and STILL
   * cannot move any of them. It wedges the release pipeline permanently and,
   * because the action only publishes when nothing is pending, stops publishing
   * altogether — which took production down, since the guest image installs the
   * SDK from npm at the version this repo declares.
   *
   * Driven with an explicit `versionable` set rather than the real config, so the
   * samples keep asserting the same thing after somebody flips
   * `privatePackages.version`.
   */
  describe("consumability", () => {
    // What it looks like with `privatePackages.version` off: the private ones
    // are real packages and are not versionable.
    const versionable = new Set(["@alexkroman1/aai"]);
    const consumable = (source: string) =>
      changesets?.checkChangesetConsumable("c.md", source, versionable) ?? [];

    test.each([
      ["only a non-versionable package", '---\n"aai-server": patch\n---\n\nx\n'],
      ["several, none versionable", '---\n"aai-server": patch\n"aai-guest": patch\n---\n\nx\n'],
    ])("flags a changeset naming %s", (_label, source) => {
      expect(consumable(source).length, "an inert changeset was not flagged").toBeGreaterThan(0);
      expect(consumable(source)[0]?.text).toContain("never be consumed");
    });

    test.each([
      ["a versionable package", '---\n"@alexkroman1/aai": patch\n---\n\nx\n'],
      [
        "a mix, at least one versionable",
        '---\n"@alexkroman1/aai": patch\n"aai-server": patch\n---\n\nx\n',
      ],
      // `--empty` names nothing, is consumed, and bumps nothing by design.
      ["nothing at all (--empty)", "---\n---\n\n"],
      // A malformed changeset is checkChangeset's finding; reporting it twice
      // would make one mistake look like two.
      ["malformed frontmatter", "no frontmatter here\n"],
    ])("spares a changeset naming %s", (_label, source) => {
      expect(consumable(source), "a legitimate changeset was flagged").toEqual([]);
    });

    test("the real config versions private packages, so nothing in the tree is inert", () => {
      // The fix for the incident, asserted as a property rather than trusted:
      // this repo writes changesets for its private packages (aai-server,
      // aai-studio-server, aai-guest…), so versioning them is what keeps those
      // changesets consumable.
      const real = changesets?.versionablePackageNames() ?? new Set<string>();
      expect(real, "the SDK is not versionable").toContain("@alexkroman1/aai");
      expect(
        real,
        "private packages are not versionable — changesets naming them would wedge the release",
      ).toContain("aai-server");
    });
  });
});
