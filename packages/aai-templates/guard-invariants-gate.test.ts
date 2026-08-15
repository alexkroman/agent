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

interface LineRule {
  id: number;
  key: string;
  label: string;
  re: string;
  paths: string[];
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
