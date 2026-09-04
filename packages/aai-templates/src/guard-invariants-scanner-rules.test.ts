// Copyright 2026 the AAI authors. MIT license.
/// <reference types="vite/client" />
/**
 * The SCANNER half of `scripts/guard-invariants.mjs` — rules 7, 12, 13 and 14,
 * the ones with no `re` to sample.
 *
 * Split out of `guard-invariants-gate.test.ts` when that file passed the
 * 700-line test cap, along the seam the rules themselves already have. A LINE
 * rule is a regex over one line and is specced by feeding it a positive sample
 * and a negative twin; a SCANNER rule walks the tree and answers a question
 * about it. Those need opposite treatment.
 *
 * Everything that reads `LINE_RULES` stayed in the sibling file, deliberately:
 * the exhaustiveness check ("every rule has samples") and the ERE-portability
 * ban have to see the WHOLE rule list, and a split that let either of them
 * quietly mean "every rule in this file" would be the vacuous-guard failure
 * this pair exists to prevent.
 *
 * What both files share is that failure mode: a scan finding nothing prints the
 * same checkmark as a rule being upheld. Rules 12, 13 and 14 are split into
 * PURE halves that can be exercised directly, so they get positive/negative
 * pairs of their own. Rule 7 is not — its scanner returns only `found`, never
 * the file count — so its corpus is re-derived here independently, which is the
 * only way a renamed directory fails rather than reporting zero.
 *
 * It lives in aai-templates for the reason its siblings do: this package owns
 * the tests for repo-level scripts, and raw imports reach them with no node
 * types, which this package's tsconfig does not have.
 */

import { describe, expect, test } from "vitest";
import { sole } from "./_gate-support.ts";

/**
 * The scanner rules' PURE halves, imported as real values.
 *
 * Rules 1, 7 and 12 have no `re` to sample, so the positive/negative discipline
 * the line rules get has to come from exercising the logic directly — and the
 * ones split into a pure half are split for exactly this. Rule 12 parses two
 * sources and diffs them, and every part of that can go quietly empty (a renamed
 * `GUEST_ROUTES` binding, a pathspec that stops matching, a prefix rule that
 * swallows everything). Rule 13 is a path computation, and a version that
 * resolved everything to "inside its template" would report the healthiest
 * possible tree while checking nothing. Rule 14 is the one where the difference
 * between "matches the name" and "resolves to the directory" IS the rule.
 *
 * ONE namespace glob rather than four `import: "<name>"` globs over the same
 * module: `import.meta.glob` is a compile-time transform, so four calls are four
 * static imports of one file to pick one binding out of each. Destructured with a
 * fallback, so every member stays possibly-absent and the "is importable" cases
 * below keep asserting it.
 */
const { findUndeclaredGuestRoutes, importEscapesTemplate, resolveAgainstFile, fixtureDirs } =
  sole(
    import.meta.glob<{
      findUndeclaredGuestRoutes: (
        literals: { file: string; line: number; literal: string }[],
        declared: Set<string>,
      ) => { file: string; line: number; text: string }[];
      importEscapesTemplate: (file: string, specifier: string) => boolean;
      resolveAgainstFile: (readerFile: string, specifier: string) => string;
      fixtureDirs: () => string[];
    }>("../../../scripts/guard-invariants-scanners.mjs", { eager: true }),
  ) ?? {};

/**
 * The SCANNER corpus that no floor and no sample protects.
 *
 * Rules 1 and 7 have no `re` to sample, and unlike 12/13/14 their scanners are
 * not split into a pure half — each derives its corpus from `git ls-files`
 * and returns only `found`, never the file count. So a directory rename, a
 * moved workflow or a changed extension makes the scanner report zero findings,
 * which is byte-identical to the rule being upheld.
 *
 * Rule 7 is the one where that has a security consequence: it is the pin that
 * keeps a floating `@v7` tag — and therefore every future version of somebody
 * else's code — out of the release job's npm token.
 *
 * This re-derives the corpus independently of the scanner (the same discipline
 * `api-surface-file.test.ts` uses), so an empty one fails HERE even while the
 * gate prints its checkmark.
 */
const workflowFiles: Record<string, string> = import.meta.glob<string>(
  "../../../.github/workflows/*.yml",
  { query: "?raw", import: "default", eager: true },
);

describe("rule 7 — every GitHub Action is SHA-pinned", () => {
  /** `uses:` lines naming a third-party action, i.e. ones with a ref to pin. */
  const pinnable: { file: string; spec: string }[] = Object.entries(workflowFiles).flatMap(
    ([file, text]) =>
      text
        .split("\n")
        .map((line) => /^\s*(?:-\s*)?uses:\s*(\S+)/.exec(line)?.[1])
        .filter((spec): spec is string => spec !== undefined)
        .filter((spec) => !(spec.startsWith("./") || spec.startsWith("docker://")))
        .map((spec) => ({ file, spec })),
  );

  test("the corpus is not empty", () => {
    // The floor the scanner does not have. Without it a renamed directory
    // makes rule 7 report `0 findings ✓` forever, over workflows holding
    // floating tags, on the rule that guards the release job's npm token.
    expect(Object.keys(workflowFiles).length, "no workflows found").toBeGreaterThanOrEqual(5);
    expect(pinnable.length, "no `uses:` lines found").toBeGreaterThanOrEqual(10);
  });

  test("every third-party action carries a 40-character commit SHA", () => {
    // Re-derived here rather than read off the scanner's empty result: a tag
    // is a mutable pointer, so `@v7` grants every future version of that code
    // the permissions of the job it runs in.
    for (const { file, spec } of pinnable) {
      const ref = spec.split("@")[1] ?? "";
      expect(/^[0-9a-f]{40}$/.test(ref), `${file}: "${spec}" is not pinned to a SHA`).toBe(true);
    }
  });
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
  const COMPAT = "packages/aai/src/sdk/protocol-compat.test.ts";

  test("the pure halves are importable", () => {
    expect(resolveAgainstFile, "resolveAgainstFile not exported").toBeTypeOf("function");
    expect(fixtureDirs, "fixtureDirs not exported").toBeTypeOf("function");
  });

  test("the historical bug: the only `compat-fixtures` string names a DIFFERENT package", () => {
    // This is the whole rule. `packages/aai-server/src/compat-fixtures/` outlived
    // its only reader by five commits while this string sat in the tree the
    // entire time, pointing at its own sibling — so a scan matching the NAME
    // finds a reader for the dead directory and reports a clean tree.
    expect(resolveAgainstFile?.(COMPAT, "compat-fixtures")).toBe(
      "packages/aai/src/sdk/compat-fixtures",
    );
    expect(resolveAgainstFile?.(COMPAT, "compat-fixtures")).not.toBe(
      "packages/aai-server/src/compat-fixtures",
    );
  });

  test("a CROSS-PACKAGE reader resolves, so a live directory is not flagged", () => {
    // aai-cli's e2e suite replays aai-ui's fixtures. A package-scoped scan
    // would report that directory as unread, which is a false positive on a
    // rule that carries no baseline — i.e. a blocked push.
    expect(
      resolveAgainstFile?.(
        "packages/aai-cli/src/_e2e-browser-test-utils.ts",
        "../../aai-ui/src/fixtures",
      ),
    ).toBe("packages/aai-ui/src/fixtures");
  });

  test("reading one FILE counts as reading its directory", () => {
    // `join(here, "fixtures/hello.pcm16")` names a file; the directory is what
    // the rule is about, so the scan credits every ancestor of the resolved
    // path and this is the resolution it does that to.
    expect(
      resolveAgainstFile?.(
        "packages/aai/src/host/integration/pipeline-reference.integration.test.ts",
        "fixtures/hello-how-are-you.pcm16",
      ),
    ).toBe("packages/aai/src/host/integration/fixtures/hello-how-are-you.pcm16");
  });

  // Resolved once: `fixtureDirs()` shells out to `git ls-files` and walks
  // every path it prints, and nothing between these two tests can change
  // what it answers.
  const dirs = fixtureDirs?.() ?? [];

  test("candidate discovery finds the real fixture directories", () => {
    // A discovery step that found nothing would report "0 ✓" — the same output
    // as the rule being upheld, which is the failure shape this whole suite
    // exists for. Nested candidates are separate: `fixtures/` and
    // `integration/fixtures/` are two directories, not one.
    expect(dirs).toContain("packages/aai/src/sdk/compat-fixtures");
    expect(dirs).toContain("packages/aai-ui/src/fixtures");
    expect(dirs).toContain("packages/aai-runtime/src/fixtures");
    expect(dirs).toContain("packages/aai-runtime/src/integration/fixtures");
  });

  test("the deleted aai-server fixture set is really gone", () => {
    // The one-time deletion this rule turns into a standing check.
    expect(dirs).not.toContain("packages/aai-server/src/compat-fixtures");
  });
});
