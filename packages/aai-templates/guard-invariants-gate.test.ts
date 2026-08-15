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
 * Rule 12's decision function, imported as a real value.
 *
 * The scanner rules (1, 7, 10, 12) have no `re` to sample, so the
 * positive/negative discipline the line rules get has to come from exercising
 * the logic directly. Rule 12 is the one worth it: the others ask a single
 * yes/no question of a file, while this one parses two sources and diffs them,
 * and every part of that can go quietly empty — a renamed `GUEST_ROUTES`
 * binding, a pathspec that stops matching, a prefix rule that swallows
 * everything. It is split into a pure half for exactly this.
 */
const findUndeclaredGuestRoutes = Object.values(
  import.meta.glob<
    (
      literals: { file: string; line: number; literal: string }[],
      declared: Set<string>,
    ) => { file: string; line: number; text: string }[]
  >("../../scripts/guard-invariants-scanners.mjs", {
    import: "findUndeclaredGuestRoutes",
    eager: true,
  }),
)[0];

/**
 * Rule 13's decision function, imported as a real value — same treatment and
 * same reason as rule 12's above: it is a path computation, and a version that
 * resolved everything to "inside its template" would report the healthiest
 * possible tree while checking nothing.
 */
const importEscapesTemplate = Object.values(
  import.meta.glob<(file: string, specifier: string) => boolean>(
    "../../scripts/guard-invariants-scanners.mjs",
    { import: "importEscapesTemplate", eager: true },
  ),
)[0];

/**
 * Rule 14's two halves, imported as real values for the same reason as 12's and
 * 13's. This rule is the one where the difference between "matches the name" and
 * "resolves to the directory" IS the rule, so a resolver that quietly agreed with
 * every candidate would report a clean tree while the bug it was written for sat
 * in it.
 */
const resolveAgainstFile = Object.values(
  import.meta.glob<(readerFile: string, specifier: string) => string>(
    "../../scripts/guard-invariants-scanners.mjs",
    { import: "resolveAgainstFile", eager: true },
  ),
)[0];

const fixtureDirs = Object.values(
  import.meta.glob<() => string[]>("../../scripts/guard-invariants-scanners.mjs", {
    import: "fixtureDirs",
    eager: true,
  }),
)[0];

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

  describe("rule 12 — undeclared guest routes", () => {
    const at = (literal: string) => [{ file: "guest.ts", line: 1, literal }];
    const declared = new Set(["/ws", "/studio/chat", "/manage/status", "/manage/drain"]);

    test("the pure half is importable", () => {
      expect(findUndeclaredGuestRoutes, "findUndeclaredGuestRoutes not exported").toBeTypeOf(
        "function",
      );
    });

    test("flags a route the table does not declare", () => {
      // The real finding this rule was written for: `/studio/tools` served by
      // the guest and present in neither table.
      const found = findUndeclaredGuestRoutes?.(at("/studio/tools"), declared) ?? [];
      expect(found).toHaveLength(1);
      expect(found[0]?.text).toContain("/studio/tools");
    });

    test("spares a declared route", () => {
      expect(findUndeclaredGuestRoutes?.(at("/studio/chat"), declared)).toHaveLength(0);
    });

    test("spares the bare root, which is the default case and not a route", () => {
      expect(findUndeclaredGuestRoutes?.(at("/"), declared)).toHaveLength(0);
    });

    test("spares a prefix gate that has declared routes under it", () => {
      // `url.startsWith("/manage/")` — legitimate, because manageStatus and
      // manageDrain are both declared beneath it.
      expect(findUndeclaredGuestRoutes?.(at("/manage/"), declared)).toHaveLength(0);
    });

    test("flags a prefix gate with nothing declared under it", () => {
      // The case a literal-only scan misses: a new `startsWith` dispatch widens
      // the guest's surface without any single new route literal.
      const found = findUndeclaredGuestRoutes?.(at("/admin/"), declared) ?? [];
      expect(found).toHaveLength(1);
      expect(found[0]?.text).toContain("prefix dispatch");
    });

    test("an empty declared set flags everything rather than passing", () => {
      // If the GUEST_ROUTES parse ever returns nothing, the rule must not go
      // quiet. The scanner throws on a zero-route parse; this pins the
      // decision function's half of that contract.
      expect(findUndeclaredGuestRoutes?.(at("/ws"), new Set())).toHaveLength(1);
    });
  });

  describe("rule 13 — a template import escaping its template", () => {
    const PIZZA = "packages/aai-templates/templates/pizza-ordering";

    test("the pure half is importable", () => {
      expect(importEscapesTemplate, "importEscapesTemplate not exported").toBeTypeOf("function");
    });

    test("flags the real bug: a spec reaching up to the package's own helper", () => {
      // Five shipped templates had exactly this. It resolved in-tree, so every
      // gate passed, and `aai test` / `aai build` / `npm start` were broken for
      // every user who scaffolded one of them.
      expect(importEscapesTemplate?.(`${PIZZA}/agent.test.ts`, "../../_discovery.ts")).toBe(true);
    });

    test("spares a sibling in the same template", () => {
      expect(importEscapesTemplate?.(`${PIZZA}/agent.ts`, "./shared.ts")).toBe(false);
    });

    test("spares a tool reaching one level up, which is inside the template", () => {
      // The case a `../../`-substring rule gets right and a `../`-substring rule
      // gets wrong — depth is not the question, the boundary is.
      expect(importEscapesTemplate?.(`${PIZZA}/tools/add_pizza.ts`, "../shared.ts")).toBe(false);
    });

    test("flags a tool reaching TWO levels up, which is another template's business", () => {
      // Same number of dots as a legal import from `agent.ts`, one directory
      // deeper — which is why this is resolved rather than matched.
      expect(importEscapesTemplate?.(`${PIZZA}/tools/add_pizza.ts`, "../../retail/store.ts")).toBe(
        true,
      );
    });

    test("flags a climb that lands exactly ON the template root", () => {
      // `templates/pizza-ordering` itself is not `templates/pizza-ordering/…`,
      // so the prefix check has to reject it — an off-by-one here would silently
      // admit every escape that stops one segment short.
      expect(importEscapesTemplate?.(`${PIZZA}/tools/add_pizza.ts`, "../../pizza-ordering")).toBe(
        true,
      );
    });
  });

  describe("rule 14 — a fixture directory nothing reads", () => {
    const COMPAT = "packages/aai/sdk/protocol-compat.test.ts";

    test("the pure halves are importable", () => {
      expect(resolveAgainstFile, "resolveAgainstFile not exported").toBeTypeOf("function");
      expect(fixtureDirs, "fixtureDirs not exported").toBeTypeOf("function");
    });

    test("the historical bug: the only `compat-fixtures` string names a DIFFERENT package", () => {
      // This is the whole rule. `packages/aai-server/compat-fixtures/` outlived
      // its only reader by five commits while this string sat in the tree the
      // entire time, pointing at its own sibling — so a scan matching the NAME
      // finds a reader for the dead directory and reports a clean tree.
      expect(resolveAgainstFile?.(COMPAT, "compat-fixtures")).toBe(
        "packages/aai/sdk/compat-fixtures",
      );
      expect(resolveAgainstFile?.(COMPAT, "compat-fixtures")).not.toBe(
        "packages/aai-server/compat-fixtures",
      );
    });

    test("a CROSS-PACKAGE reader resolves, so a live directory is not flagged", () => {
      // aai-cli's e2e suite replays aai-ui's fixtures. A package-scoped scan
      // would report that directory as unread, which is a false positive on a
      // rule that carries no baseline — i.e. a blocked push.
      expect(resolveAgainstFile?.("packages/aai-cli/e2e.test.ts", "../aai-ui/fixtures")).toBe(
        "packages/aai-ui/fixtures",
      );
    });

    test("reading one FILE counts as reading its directory", () => {
      // `join(here, "fixtures/hello.pcm16")` names a file; the directory is what
      // the rule is about, so the scan credits every ancestor of the resolved
      // path and this is the resolution it does that to.
      expect(
        resolveAgainstFile?.(
          "packages/aai/host/integration/pipeline-reference.integration.test.ts",
          "fixtures/hello-how-are-you.pcm16",
        ),
      ).toBe("packages/aai/host/integration/fixtures/hello-how-are-you.pcm16");
    });

    test("candidate discovery finds the real fixture directories", () => {
      // A discovery step that found nothing would report "0 ✓" — the same output
      // as the rule being upheld, which is the failure shape this whole suite
      // exists for. Nested candidates are separate: `host/fixtures` and
      // `host/integration/fixtures` are two directories, not one.
      const dirs = fixtureDirs?.() ?? [];
      expect(dirs).toContain("packages/aai/sdk/compat-fixtures");
      expect(dirs).toContain("packages/aai-ui/fixtures");
      expect(dirs).toContain("packages/aai/host/fixtures");
      expect(dirs).toContain("packages/aai/host/integration/fixtures");
    });

    test("the deleted aai-server fixture set is really gone", () => {
      // The one-time deletion this rule turns into a standing check.
      expect(fixtureDirs?.() ?? []).not.toContain("packages/aai-server/compat-fixtures");
    });
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
