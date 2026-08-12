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

interface LineRule {
  id: number;
  key: string;
  label: string;
  re: string;
}

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
const SAMPLES: Record<string, { matches: string[]; ignores: string[] }> = {
  rule2_spreadTernary: {
    matches: [
      "    ...(body !== undefined ? { body } : {}),",
      "      ...(params.port !== undefined ? { AAI_GUEST_PORT: String(params.port) } : {}),",
    ],
    ignores: ["    ...omitUndefined({ body }),", "    ...(flag ? { a: 1 } : { a: 2 }),"],
  },
  rule3_raceTimeout: {
    matches: [
      "  const won = await Promise.race([work, new Promise((_, r) => setTimeout(r, ms))]);",
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
    ],
    ignores: ["    await flush();", "    await new Promise((r) => setTimeout(r, 50));"],
  },
  rule5_deleteProcessEnv: {
    matches: ['    delete process.env["AAI_API_KEY"];', "    delete process.env.AAI_API_KEY;"],
    ignores: ['    vi.stubEnv("AAI_API_KEY", undefined);'],
  },
  rule6_templateStateCast: {
    matches: ["    const state = ctx.state as { count?: number };"],
    ignores: ["    const state = counterSlot.get(ctx);"],
  },
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
};

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
    // suite exists to make impossible.
    for (const { id, key } of shippedLineRules()) {
      expect(SAMPLES[key], `rule ${id} (${key}) has no positive/negative samples`).toBeTypeOf(
        "object",
      );
    }
  });

  test.each(shippedLineRules())("rule $id ($key) matches its anti-pattern", ({ key, re }) => {
    const samples = SAMPLES[key];
    if (samples === undefined) expect.fail(`rule ${key} has no samples`);
    for (const line of samples.matches) {
      expect(
        new RegExp(re).test(line),
        `rule ${key} does NOT match a line it must catch — the pattern is dead:\n  ${line}`,
      ).toBe(true);
    }
  });

  test.each(shippedLineRules())("rule $id ($key) spares its legitimate twin", ({ key, re }) => {
    const samples = SAMPLES[key];
    if (samples === undefined) expect.fail(`rule ${key} has no samples`);
    for (const line of samples.ignores) {
      expect(
        new RegExp(re).test(line),
        `rule ${key} matches a line it must NOT flag:\n  ${line}`,
      ).toBe(false);
    }
  });

  test("no pattern uses \\b", () => {
    // `\b` is a GNU extension. `git grep -E` does not implement it, so a
    // pattern containing one matches nothing and the rule reports success
    // forever. Two escape-hatch patterns were dead this way for months.
    for (const { id, re } of shippedLineRules()) {
      expect(re, `rule ${id} uses \\b, which git's matcher does not implement`).not.toContain(
        "\\b",
      );
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
    expect(script).toContain("refusing to RAISE");
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
