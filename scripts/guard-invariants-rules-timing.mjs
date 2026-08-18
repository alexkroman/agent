/**
 * The TIMING rules — 3, 4, 19 and 21. One family, four remedies.
 *
 * They are grouped because they are the same question asked four ways ("how
 * is this code waiting?") and because they share a failure history: all of them
 * are substring guards over a language with syntax, and every gap found in
 * this gate has been in one of them.
 *
 * Rule 21 is the newest and the only one whose hazard is not the wait itself:
 * `expect.poll` waits correctly and reads the RUNNER's current test to do it,
 * which under `test.concurrent` a sibling has already cleared. It sits here
 * because the remedy is the same shape as the other three — a different wait
 * primitive, named.
 *
 * Three widenings landed together, each against LIVE occurrences the previous
 * pattern could not see:
 *
 *   - rule 3 was LINE-ANCHORED, so the multi-line `Promise.race([` Biome emits
 *     was invisible (3 occurrences);
 *   - rules 4 and 19 required a literal `(` after `new Promise`, so a `<T>`
 *     type argument evaded both (5 occurrences);
 *   - neither knew `setImmediate` (8 occurrences).
 *
 * Rule IDs are STABLE across this split: 6 stays retired, 15 stays reserved,
 * and nothing here was renumbered.
 */

import {
  IMMEDIATE_PROMISE,
  RACE_CONTINUES,
  RACE_TIMEOUT,
  SLEEP_PROMISE,
  TICK_PROMISE,
  TIMERS_PROMISES,
} from "./guard-invariants-ere.mjs";
import { SOURCE_PATHSPECS } from "./guard-invariants-scopes.mjs";

/** @type {import("./guard-invariants-rules.mjs").LineRule[]} */
export const TIMING_RULES = [
  {
    id: 3,
    key: "rule3_raceTimeout",
    label: "hand-rolled Promise.race timeout",
    re: `${RACE_TIMEOUT}|${RACE_CONTINUES}`,
    paths: SOURCE_PATHSPECS,
    skipComments: true,
    samples: {
      matches: [
        "  const won = await Promise.race([work, new Promise((_, r) => setTimeout(r, ms))]);",
        // The MULTI-LINE form, which the line-anchored pattern could not see —
        // two live occurrences in the fuzz harnesses, and the reason the second
        // alternative exists.
        "  const outcome = await Promise.race([",
        "    return Promise.race(",
      ],
      ignores: [
        "  const outcome = await Promise.race([work.then((value) => ({ value })), exited]);",
        "  return pTimeout(work, { milliseconds: ms });",
      ],
    },
    remedy:
      "Use `p-timeout` — it is already a dependency of aai, aai-cli,\n" +
      "aai-guest and aai-server. A race with no timer in it is fine: this rule\n" +
      "is about the hand-rolled timeout, not the race.\n\n" +
      "A race whose arguments run onto the NEXT line is reported WITHOUT the\n" +
      "gate being able to see whether a timer is among them — `git grep` is\n" +
      "line-based, and the line-anchored pattern this replaces was blind to the\n" +
      "wrapped shape Biome actually emits. Baseline the occurrence when there is\n" +
      "genuinely no timer in it: `aai-server/guest-readiness.ts` races the work\n" +
      "against the child's `exit`, and is the entry to copy.",
  },
  {
    id: 4,
    key: "rule4_inlineTickPromise",
    label: "inline new Promise(r => setTimeout(r, 0))",
    // `.*` between the two calls, NOT `[^)]*`. The arrow's own parameter list
    // closes a paren before `setTimeout` is reached
    // (`new Promise((resolve) => setTimeout(resolve, 0))`), so a negated-paren
    // class matches nothing at all — which is how the first version of this
    // rule reported 0 against five real occurrences. The optional `<T>` inside
    // `TICK_PROMISE` is the SECOND version of that same miss.
    re: `${TICK_PROMISE}|${IMMEDIATE_PROMISE}`,
    paths: SOURCE_PATHSPECS,
    skipComments: true,
    samples: {
      matches: [
        "    await new Promise((resolve) => setTimeout(resolve, 0));",
        "  return new Promise((r) => setTimeout(r, 0));",
        // A type argument, which the literal `(` requirement could not cross.
        "  return new Promise<void>((r) => setTimeout(r, 0));",
        // The other zero-length yield, which neither timer rule knew.
        "    await new Promise((r) => setImmediate(r));",
        "const flush = () => new Promise<void>((resolve) => setImmediate(resolve));",
      ],
      ignores: [
        "    await flush();",
        "    await tick();",
        "    await new Promise((r) => setTimeout(r, 50));",
        "  return new Promise<void>((r) => setTimeout(r, 250));",
      ],
    },
    remedy:
      "Use `flush()` for a microtask yield or `tick()` for a macrotask one,\n" +
      "both from aai/host/_test-utils.ts. Spelled inline it does not say which\n" +
      "it meant, and a LOCAL `flush` defined this way once shadowed the shared\n" +
      "export so one name meant two different waits.\n\n" +
      "`setImmediate` is the same yield reached by another name and is counted\n" +
      "here rather than by rule 19: it takes no delay, so it can never be a\n" +
      "sleep. SHIPPED source that yields deliberately is the legitimate baseline\n" +
      "entry — `host/tool-executor.ts` uses it between tool calls for its\n" +
      "I/O-phase semantics, and a test helper is not the remedy for production\n" +
      "code.",
  },
  {
    id: 19,
    key: "rule19_handRolledSleep",
    label: "hand-rolled sleep",
    // Two shapes in one rule because they are the same mistake reached from two
    // directions — hand-rolling the timer promise, and reaching for the ONE
    // built-in the test runner cannot drive.
    //
    // The nonzero delay is what distinguishes this from rule 4, which owns the
    // `, 0)` case (a yield, whose remedy is `flush()`/`tick()` — two different
    // waits that must not be spelled the same). `[1-9]` after the comma is the
    // whole difference: a literal 0 belongs to rule 4, and a NAMED delay
    // (`setTimeout(resolve, ms)`) is a sleep whatever it holds, so an identifier
    // matches here too.
    re: `${SLEEP_PROMISE}|${TIMERS_PROMISES}`,
    paths: SOURCE_PATHSPECS,
    skipComments: true,
    samples: {
      matches: [
        "    await new Promise((resolve) => setTimeout(resolve, 250));",
        "  return new Promise((r) => setTimeout(r, ms));",
        "  await new Promise((resolve) => setTimeout(resolve, (8 - index) * 20));",
        // The type argument AND a callback first argument — the two-level form
        // the flat `[^,)]*` could not cross. A real five-second wait in both
        // fuzz harnesses. Spelled in two halves because biome's `noSecrets`
        // scores the whole literal as high entropy, the same reason the ERE
        // fragments are named one at a time.
        `  new Promise<"x">((r) => ${'setTimeout(() => r("x"), 5000));'}`,
        '    import { setTimeout as sleep } from "node:timers/promises";',
      ],
      ignores: [
        "    await sleep(250);",
        "    await sleep(GUEST_DIAL_RETRY_MS, { unref: true });",
        // Rule 4's shapes, which this rule must NOT sweep in.
        "    await new Promise((resolve) => setTimeout(resolve, 0));",
        "  return new Promise<void>((r) => setTimeout(r, 0));",
        // A two-parameter executor supplying the comma.
        "    await new Promise((resolve, reject) => setTimeout(resolve, 0));",
        "    await new Promise((r) => setImmediate(r));",
        '    import { scheduler } from "node:timers/promises";',
      ],
    },
    remedy:
      "Use the `sleep` helper from @alexkroman1/aai/internal.\n" +
      "\n" +
      "There were FIVE spellings of this across four packages, two of them\n" +
      "byte-identical across a package boundary. That is the ordinary kind of\n" +
      "duplication; the reason this is a rule is that the five split into two\n" +
      "families differing in a property no reader can see at a call site.\n" +
      "\n" +
      "`vi.useFakeTimers()` replaces the global setTimeout and does NOT patch\n" +
      "node:timers/promises. Measured: a spec that advances the fake clock by\n" +
      "an hour never sees such a wait resolve. So the spelling silently decides\n" +
      "whether a poll loop can be tested at all, and no tier carries a retry —\n" +
      "a spec that waits out real milliseconds is the one that fails first on\n" +
      "a contended runner, naming the timing helper rather than the bug.\n" +
      "\n" +
      "The shared helper takes `{ unref }` (opt-in, because it is a claim that\n" +
      "abandoning the wait is correct) and `{ signal }` (resolving rather than\n" +
      "throwing, with the listener detached on every path so a loop against a\n" +
      "long-lived signal retains nothing).\n" +
      "\n" +
      "A zero-length wait is NOT this: that is rule 4, and the remedy there\n" +
      "names which of the two yields you meant.",
  },
  {
    id: 21,
    key: "rule21_expectPoll",
    label: "expect.poll (bound to the runner's current test)",
    // No prefix beyond the literal, because the point is the SPELLING: a
    // context-bound `expect` destructured from the test arguments is spelled
    // identically at the call site. No regex can tell the two apart, which is
    // the argument for banning the API rather than for policing where it is
    // reached from.
    re: "expect\\.poll\\(",
    paths: SOURCE_PATHSPECS,
    skipComments: true,
    // Every sample here is SHORT on purpose: spelled out at call-site length,
    // biome's `noSecrets` entropy heuristic scores them as credentials — the
    // same trap this module's header records rule 19 paying for.
    samples: {
      matches: ["    await expect.poll(() => n).toBe(0);", "  await expect.poll(read).toEqual(1);"],
      ignores: [
        "    await vi.waitFor(() => expect(n).toBe(0));",
        "    await vi.waitUntil(() => n > 0, { interval: 50 });",
        "    expect(n).toBe(0);",
        // The name is a hazard only on `expect`. A poll of one's own is fine.
        "    await pollUntilReady(url);",
      ],
    },
    remedy:
      "Use `vi.waitFor()` (retry an assertion) or `vi.waitUntil()` (retry a\n" +
      "predicate) — which is what AGENTS.md already asks for when polling for an\n" +
      "async result, so this rule only makes the existing preference mechanical.\n" +
      "Where the thing awaited is an EVENT the tool already records, take the\n" +
      "tool's own affordance instead: `page.waitForEvent(name, { predicate })`\n" +
      "cannot miss an event however brief it was, and needs no array to poll.\n" +
      "\n" +
      "`expect.poll` reads the runner's CURRENT TEST, which is a single\n" +
      "module-level variable in @vitest/runner — set before a test body runs and\n" +
      "cleared after. Under `test.concurrent` the siblings run interleaved, so\n" +
      "the first one to FINISH clears the pointer for every test still running,\n" +
      "and the global `expect.poll` throws `expect.poll() must be called inside\n" +
      "a test` rather than polling anything.\n" +
      "\n" +
      "That failure is INVISIBLE until it is not: it depends on which concurrent\n" +
      "sibling finishes first, so it passes locally and on the leg that happens\n" +
      "to schedule kindly. It took out both e2e legs of a Version Packages PR\n" +
      "and of main (`aai-cli/e2e.test.ts`, 20 concurrent tests) while the run\n" +
      "before it was green on the same code. `vi.waitFor` reads no such state,\n" +
      "so it is correct in a concurrent test and in a serial one alike.\n" +
      "\n" +
      "The context `expect` (`async ({ expect }) => …`) IS bound correctly and is\n" +
      "the upstream remedy — it is not the one here, because the two are spelled\n" +
      "the same at the call site. A rule that cannot see the difference would\n" +
      "have to trust a destructuring one screen up, and this repo has paid four\n" +
      "times for a guard that reports success over the shape it cannot see.",
  },
];
