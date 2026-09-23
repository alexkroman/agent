// Copyright 2026 the AAI authors. MIT license.
/**
 * The TESTING rules — rules 33 and 34, over the repo's own test files.
 *
 * Its own scope, rather than a row in the shape module, because the corpus is
 * different from every other rule's: these walk `packages/**\/*.test.ts(x)`,
 * where every other family walks shipped source, the guest surface, the
 * templates or the gate scripts. A scope is the thing a rule module here is
 * organised by.
 *
 * ## Why a NODE rule, demonstrated
 *
 * This family is where the line/node choice is least arguable, and the evidence
 * is one command. `git grep -nE "expect(\.soft)?\((true|false)[,)]"` over the
 * test corpus returns TWO hits today and both are false:
 *
 *   - `aai-cli/_deno-output.scenario.test.ts` — a doc comment quoting the
 *     anti-pattern, in the very file whose fix added this rule.
 *   - `aai-studio-server/studio-template-contract.test.ts` — the STRING
 *     `"expect(true).toBe(true)"`, a fixture body written into a temp file for
 *     the eval harness to run. (It was `aai-evals/template-contract.test.ts`
 *     when this was measured; the file moved packages with the studio eval.)
 *
 * A line rule would therefore need `skipComments` plus something it does not
 * have for the string, so it would either fail on prose it cannot fix or need a
 * baseline entry per false positive — and a baselined false positive is budget
 * a real occurrence can later move into. A parse sees a comment as no node and
 * a string literal as a string. It reports 0.
 */

import { isConstantAssertion, isModuleMock } from "./guard-invariants-nodes.mjs";
import { TEST_FILE_PATHSPECS } from "./guard-invariants-scopes.mjs";

/**
 * Node rules over the test corpus.
 *
 * @type {import("./guard-invariants-rules.mjs").NodeRule[]}
 */
export const TESTING_RULES = [
  {
    id: 33,
    key: "rule33_constantAssertion",
    label: "assertion over a boolean literal (a skip spelled as a pass)",
    match: isConstantAssertion,
    paths: TEST_FILE_PATHSPECS,
    samples: {
      matches: [
        'expect.soft(true, "deno not on PATH — portability arm skipped").toBe(true);',
        "expect(true).toBe(true);",
        "expect(false).toBe(true);",
      ],
      ignores: [
        // The legitimate form: the GATE is a value, so the assertion can fail.
        "expect(HAVE_DENO).toBe(true);",
        "expect(await exists(html)).toBe(true);",
        "expect.soft(value, label).toBe(expected);",
        // `expect.assertions(2)` reaches `expect` through a member too, and its
        // argument is a literal — which is why this rule is scoped to BOOLEAN
        // literals rather than to literals.
        "expect.assertions(2);",
        // The two live grep false positives, as source. Neither is a call.
        'const body = "expect(true).toBe(true)";',
      ],
    },
    remedy:
      "Assert the VALUE, not a constant. `expect(cond).toBe(true)` where `cond`\n" +
      "is a real expression, or skip the suite out loud.\n" +
      "\n" +
      "An assertion over a literal cannot fail, and that is invisible at every\n" +
      "level anyone looks: it passes, it counts in the green total, and it shows\n" +
      "up in COVERAGE as an executed line. `check:test-assertions` cannot see it\n" +
      "either — that gate asks whether a test body contains an `expect` at all,\n" +
      "and this body does.\n" +
      "\n" +
      "It is here because it was paid for. `_deno-output.scenario.test.ts` used\n" +
      '`expect.soft(true, "deno not on PATH …")` as a stand-in for a skip, so\n' +
      "the only test proving `aai build --target deno` emits a directory that\n" +
      "BOOTS reported green on every CI leg while checking nothing — on the\n" +
      "branch that added the target.\n" +
      "\n" +
      "To skip on a missing runtime, copy `describeWithFfmpeg` from\n" +
      "`aai/host/ffmpeg.scenario.test.ts`: announce the skip, hand it to\n" +
      "`describe.skip`, and let an `AAI_REQUIRE_*` flag that CI sets turn the\n" +
      "skip into a hard failure. That way the skip is visible to a reader, the\n" +
      "coverage is honest, and a runner that was SUPPOSED to have the dependency\n" +
      "fails instead of passing quietly.",
  },
  {
    id: 34,
    key: "rule34_moduleMock",
    label: "vi.mock / vi.doMock (a missing seam, replaced by module surgery)",
    match: isModuleMock,
    paths: TEST_FILE_PATHSPECS,
    samples: {
      matches: [
        'vi.mock("./_ui.ts", () => ({ log: stubLog() }));',
        'vi.doMock("node:child_process", () => ({ spawn }));',
        // The computed spelling reaches the same call.
        'vi["mock"]("./a.ts", () => ({}));',
      ],
      ignores: [
        // A cast over a mock that already exists — the affordance check:hatches
        // credits with removing `as unknown as` casts, not a new replacement.
        "vi.mocked(run).mockClear();",
        "vi.fn();",
        'vi.spyOn(console, "log");',
        'const note = "vi.mock(\\"x\\")";',
      ],
    },
    remedy:
      "Give the code under test a SEAM and hand the fake through it, instead of\n" +
      "replacing a module for the whole file.\n" +
      "\n" +
      "A `vi.mock` is a record that the unit could not be tested as written: it\n" +
      "reaches for its collaborator by import, so the only way to substitute one\n" +
      "is to rewrite the module graph under it. That costs twice. The test couples\n" +
      "to a FILE PATH (move `_ui.ts` and twelve suites break, none of them about\n" +
      "the UI), and the factory is untyped against the real module, so a renamed\n" +
      "or newly required export compiles and fails at runtime — or worse, passes,\n" +
      "because the factory never exported it and the code's fallback ran.\n" +
      "\n" +
      "The repo has already paid this down once, which is the template to copy:\n" +
      "`aai-server` routes every line through `logger.ts`, and its specs silence\n" +
      "that with a capture helper instead of mocking a module. AGENTS.md's section on open\n" +
      "testability work names the same job still open in aai-studio-server and\n" +
      "aai-cli.\n" +
      "An injected dependency with a production default — `deps = { spawn }`, a\n" +
      "`serverEnv = process.env` parameter like `agentBootEnv`'s — is the usual\n" +
      "shape.\n" +
      "\n" +
      "Baselined per file: the existing ones are a to-do list, and a new one is a\n" +
      "hand edit to `guard-invariants-baseline.json` that a reviewer sees.",
  },
];
