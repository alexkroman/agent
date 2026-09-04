// Copyright 2026 the AAI authors. MIT license.
/**
 * What an eval suite SAYS about itself before, and instead of, its cases.
 *
 * Three facts a reader of a green eval run needs and could not get anywhere
 * else: which model this run got, how many of the suite's cases that model will
 * actually be asked anything, and whether the answer to the second was NONE.
 *
 * The third is the one with a wrong answer available, and it was the answer:
 * measured on a scaffolded project whose two cases were both `{ live: true }`,
 * `aai eval --json` with no key printed `2 skipped`,
 * `{"ok":true,"data":{"passed":true}}` and exited **0**. So the honest thing the
 * authoring guide recommends — mark a claim no script can satisfy `live: true` —
 * is exactly what turns a keyless CI job into a green run of nothing.
 *
 * Its own module because both suite kinds owe all three (`describeEval` and
 * `describeWorkflowEval`), and because a fact stated one way from a session
 * suite and another way from a workflow suite is the drift
 * `_credential-verdict.ts` exists next door to prevent.
 *
 * @module
 */

import { expect, test } from "vitest";

/** How the suite is running, and why. */
export type EvalMode = "live" | "stub";

/**
 * Say which mode this run got — one line, every run, before any case.
 *
 * A DIRECT stderr write, not `console.warn`, and that is the whole point of the
 * function. Vitest INTERCEPTS `console` and hands what it captures to the
 * reporter, so whether the line is ever seen is the REPORTER's decision — and
 * vitest 4 picks that reporter for you: with `reporters` unset it resolves
 * `std-env`'s `isAgent ? "agent" : "default"`, and the agent reporter prints a
 * passing file's captured output nowhere. A scaffolded agent project sets no
 * `reporters`. So `aai eval` run BY AN AGENT — this repo's own studio coding
 * agent included — showed the line only when the run FAILED, which is the one
 * case where it does not matter.
 *
 * Measured on a scaffolded project, vitest 4.1.10, one passing case: with the
 * agent markers in the environment `console.warn` printed nothing while a
 * `process.stderr.write` beside it printed; with those markers stripped — a
 * human at a terminal — `console.warn` printed too. Pinning
 * `reporters: ["default"]` restores it as well, which is exactly why THIS repo
 * never saw it: `vitest.shared.ts` pins that value and every config here
 * spreads it.
 *
 * A stderr write is right rather than merely sufficient: it is the reporter's
 * job to decide what a TEST said, and not the reporter's job to decide whether
 * the harness may state what it just did. The trailing newline is ours for the
 * same reason — nothing is formatting this.
 */
export function announceEvalMode(line: string): void {
  process.stderr.write(`${line}\n`);
}

/**
 * The counts line: how many of the suite's cases this mode will actually run.
 *
 * The mode line above says which MODEL a run got and nothing about how much of
 * the suite that model will be asked anything. Those are different facts and the
 * second one has no other reader: vitest prints `2 skipped` per FILE, `aai eval`
 * reports `{"passed":true}` with no counts in it at all, and a suite whose every
 * case is `{ live: true }` therefore reported a green, zero-second, empty run.
 *
 * Emitted on every run, including the all-ran one, for the reason
 * {@link announceEvalMode} is: a number that appears only when something is
 * wrong is a number nobody learns to read.
 */
export function announceEvalCoverage(
  name: string,
  mode: EvalMode,
  declared: number,
  skipped: number,
): void {
  const model = mode === "live" ? "the live model" : "the scripted model";
  const because = mode === "live" ? "scripted-only" : "live-only";
  announceEvalMode(
    `eval: ${name} — ${declared - skipped} of ${declared} case(s) run against ${model}` +
      `${skipped === 0 ? "" : `; ${skipped} skipped as ${because}`}.`,
  );
}

/**
 * A suite that will run NOTHING fails, rather than reporting green.
 *
 * Measured on a scaffolded project whose two cases were both `{ live: true }`:
 * `aai eval --json` printed `↓ agent.eval.test.ts (2 tests | 2 skipped)`,
 * `{"ok":true,"data":{"passed":true}}` and exited **0**. So the honest thing the
 * authoring guide recommends — mark a claim no script can satisfy `live: true` —
 * is exactly what turns a keyless CI job into a green run of nothing, which this
 * repo's own eval guide names as the worst outcome available to a tier.
 *
 * The remedy is a case the OTHER mode can run, never a lower bar: a stub run is
 * what proves `agent.ts` still boots, its tools still resolve and this file still
 * drives a session, and a suite with no such case has opted out of the one check
 * a pipeline can make for free. Which is why this is unconditional rather than
 * gated on `AAI_REQUIRE_EVAL` — that variable asks for a LIVE measurement, and
 * the failure here is that nothing was measured at all.
 *
 * A suite that declared no cases whatsoever is left alone: vitest already fails a
 * file whose suite holds no test, and inventing a second failure for it would
 * report the same thing twice.
 */
export function registerEmptySuiteFailure(
  name: string,
  mode: EvalMode,
  declared: number,
  skipped: number,
): void {
  const reason = emptySuiteReason(mode, declared, skipped);
  if (reason === undefined) return;
  test(`${name} ran no cases`, () => {
    expect.fail(reason);
  });
}

/**
 * The decision {@link registerEmptySuiteFailure} acts on, as a pure function —
 * `undefined` when the suite ran something.
 *
 * Split out because the register half can only be tested by observing a FAILING
 * test, which is the one shape a suite cannot assert on from inside itself. Same
 * reason `resolveEvalMode` is a function rather than a branch inside
 * `describeEval`.
 */
export function emptySuiteReason(
  mode: EvalMode,
  declared: number,
  skipped: number,
): string | undefined {
  if (declared === 0 || skipped < declared) return undefined;
  const marker = mode === "live" ? "{ scripted: true }" : "{ live: true }";
  return (
    `all ${declared} case(s) are ${marker} and this run got the ${mode} model, so this ` +
    "eval measured nothing and would otherwise have passed. Give the suite at least one " +
    `case the ${mode} model can run — for a scripted run that means a \`stubReply\` ` +
    "chosen so the case still holds, which is what proves the agent, its tools and this " +
    "file all still work without a key."
  );
}
