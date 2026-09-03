// Copyright 2026 the AAI authors. MIT license.
/**
 * The TIMING rules — 3, 4, 19, 21, 23 and 31 — and the repo's first NODE rules.
 *
 * They are grouped because they are the same question asked six ways ("how is
 * this code waiting?") and because they share a failure history: this file used
 * to open by saying "all of them are substring guards over a language with
 * syntax, and every gap found in this gate has been in one of them." That
 * sentence was the argument for parsing, and it is why this family went first.
 *
 * ## What the migration changed
 *
 * Each rule now carries a `match(node)` over a parsed AST instead of an `re`
 * handed to `git grep -E`. `scripts/_ast-scan.mjs` carries the engine and the
 * cost; `guard-invariants-nodes.mjs` carries the predicates. The rules keep
 * their ids, their baseline keys and their recorded budgets, because a rule's
 * NUMBER is a stable identifier and the engine underneath it is not part of
 * that identity.
 *
 * Four things stopped being true, all of them recorded here as defects first:
 *
 *   - **A wrapped call is visible.** Rule 21's pattern was `expect\.poll\(`,
 *     and Biome writes `await expect` + newline + `.poll(` the moment the call
 *     does not fit. Two live occurrences — `aai-cli/dev-workflow.scenario` and
 *     `aai-server/session-state.scenario` — sat in two scenario suites while
 *     the gate printed `allowed=0 now=0` and a checkmark. Rule 21's own remedy
 *     records that this API took out both e2e legs of a Version Packages PR.
 *   - **A block body is visible.** Rules 4 and 19 required the executor and its
 *     timer on ONE line. `aai-ui/_react-test-utils.ts` writes its `tick()` as a
 *     three-line block and says so in a doc comment — "the one occurrence in
 *     this package was in no baseline and reported by nothing" — blaming the
 *     type argument, which had since been fixed. The block was the real reason.
 *   - **Rule 3 stopped over-reporting.** Its multi-line alternative was
 *     `Promise\.race\(\[?$`, which by construction cannot see whether a timer
 *     is among the elements, so a timer-free race was a legitimate baseline
 *     entry (`aai-server/guest-readiness.ts`). The parse looks at the elements.
 *     A timeout arm HOISTED to a variable is out of the race's reach and needs
 *     no special case: standalone, it is a hand-rolled sleep and rule 19 has it.
 *   - **`skipComments` went away.** A comment is not a node, so nothing here
 *     needs the `isCommentOnly` heuristic — and this module needs no
 *     `SELF_REFERENTIAL` entry either, where all four ERE rule modules do,
 *     because a remedy quoting the anti-pattern is a string literal.
 *
 * The samples came with it. A line rule's positive sample is a LINE, so the
 * sample proving rule 3 saw the wrapped form could not be written in it — this
 * file's own history records the rule shipping for months with a single-line
 * sample while blind to the shape the code is written in. A node rule's samples
 * are source the spec parses, so they are written the way the code is written.
 *
 * Rule IDs are STABLE: 6 stays retired, 15 stays reserved, and 26 and 30 remain
 * in `-rules-workflow.mjs` where an earlier split put them.
 */

import { walk } from "./_ast-scan.mjs";
import {
  asyncListener,
  isCallOfMember,
  isJitteredWindow,
  isTimersPromisesSleep,
  promiseWait,
} from "./guard-invariants-nodes.mjs";
import { SOURCE_PATHSPECS } from "./guard-invariants-scopes.mjs";

/** @type {import("./guard-invariants-rules.mjs").NodeRule[]} */
export const TIMING_RULES = [
  {
    id: 3,
    key: "rule3_raceTimeout",
    label: "hand-rolled Promise.race timeout",
    match(node) {
      if (!isCallOfMember(node, "Promise", "race")) return false;
      let timer = false;
      walk(node.arguments, (inner) => {
        if (timer) return false;
        if (promiseWait(inner) !== undefined) timer = true;
      });
      return timer;
    },
    paths: SOURCE_PATHSPECS,
    samples: {
      matches: [
        "const won = await Promise.race([work, new Promise((_, r) => setTimeout(r, ms))]);",
        // The wrapped form Biome emits, which the line-anchored pattern could
        // not see and its replacement could only guess at.
        [
          "const won = await Promise.race([",
          "  work,",
          "  new Promise((_, reject) => setTimeout(reject, ms)),",
          "]);",
        ].join("\n"),
        [
          "await Promise.race([",
          "  settled,",
          "  new Promise((resolve) => {",
          "    setTimeout(resolve, GRACE_MS);",
          "  }),",
          "]);",
        ].join("\n"),
      ],
      ignores: [
        "const outcome = await Promise.race([work.then((value) => ({ value })), exited]);",
        "const settled = await pTimeout(work, { milliseconds: ms });",
        // The entry this rule's baseline used to carry: a real race with no
        // timer in it, over-reported because a line-based pattern cannot look
        // inside the brackets. It is not a violation and is not exempted — the
        // rule simply answers correctly now.
        ["const ready = await Promise.race([", "  probe(),", "  exited,", "]);"].join("\n"),
      ],
    },
    remedy:
      "Use `p-timeout` — it is already a dependency of aai, aai-cli,\n" +
      "aai-guest and aai-server. A race with no timer in it is fine: this rule\n" +
      "is about the hand-rolled timeout, not the race.\n" +
      "\n" +
      "The timer is found by looking INSIDE the race's arguments, so the\n" +
      "wrapped form Biome emits is reported and a timer-free race is not —\n" +
      "the line-based version could do neither, and carried a baselined\n" +
      "occurrence that was never a violation. A timeout arm assigned to a\n" +
      "variable first is out of this rule's reach and needs none: standalone,\n" +
      "it is a hand-rolled sleep and rule 19 reports it.",
  },
  {
    id: 4,
    key: "rule4_inlineTickPromise",
    label: "inline new Promise(r => setTimeout(r, 0))",
    match: (node) => promiseWait(node) === "yield",
    paths: SOURCE_PATHSPECS,
    samples: {
      matches: [
        "await new Promise((resolve) => setTimeout(resolve, 0));",
        "const yielded = new Promise<void>((r) => setTimeout(r, 0));",
        // The other zero-length yield. It takes no delay, so it can only ever
        // be rule 4's and never rule 19's.
        "await new Promise((r) => setImmediate(r));",
        // The BLOCK body, which is how `aai-ui/_react-test-utils.ts` writes its
        // `tick()` — invisible to a pattern requiring both calls on one line,
        // and the occurrence that file's own doc comment says was "in no
        // baseline and reported by nothing".
        ["const tick = () => new Promise<void>((r) => {", "  setTimeout(r, 0);", "});"].join("\n"),
      ],
      ignores: [
        "await flush();",
        "await tick();",
        // Rule 19's shape: a real delay has a different remedy.
        "await new Promise((r) => setTimeout(r, 50));",
        // SCHEDULED WORK rather than a yield. The timer's callback does
        // something before it settles, so `flush()`/`tick()` cannot replace it
        // — `host/step-files.test.ts` defers a read exactly this way, and the
        // line-based rule had no way to tell the two apart.
        // Spelled a fragment per line rather than as one literal: at call-site
        // length biome's `noSecrets` entropy heuristic scores a sample as a
        // credential, which is the same tax `guard-invariants-ere.mjs` records
        // paying to name its fragments one at a time.
        [
          `const deferred = new ${"Promise<number>"}${"((resolve) => {"}`,
          "  setTimeout(() => {",
          "    inFlight -= 1;",
          "    resolve(bytes);",
          "  }, 0);",
          "});",
        ].join("\n"),
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
      "code.\n\n" +
      "A promise whose timer callback does WORK before it settles is not this\n" +
      "and is not reported: that is a deferral, and neither yield replaces it.",
  },
  {
    id: 19,
    key: "rule19_handRolledSleep",
    label: "hand-rolled sleep",
    // Two shapes in one rule because they are the same mistake reached from two
    // directions — hand-rolling the timer promise, and reaching for the ONE
    // built-in the test runner cannot drive.
    match: (node) => promiseWait(node) === "sleep" || isTimersPromisesSleep(node),
    paths: SOURCE_PATHSPECS,
    samples: {
      matches: [
        "await new Promise((resolve) => setTimeout(resolve, 250));",
        "const waited = new Promise((r) => setTimeout(r, ms));",
        "await new Promise((resolve) => setTimeout(resolve, (8 - index) * 20));",
        // A settler reached through a wrapper — the real five-second wait in
        // both fuzz harnesses, which the flat argument class could not cross.
        // In two halves, for the entropy reason the sample above carries.
        `const hung = new Promise<"x">((r) => ${'setTimeout(() => r("x"), 5000));'}`,
        'import { setTimeout as sleep } from "node:timers/promises";',
      ],
      ignores: [
        "await sleep(250);",
        "await sleep(GUEST_DIAL_RETRY_MS, { unref: true });",
        // Rule 4's shapes, which this rule must NOT sweep in.
        "await new Promise((resolve) => setTimeout(resolve, 0));",
        "await new Promise((resolve, reject) => setTimeout(resolve, 0));",
        "await new Promise((r) => setImmediate(r));",
        'import { scheduler } from "node:timers/promises";',
        // A rename of `setTimeout` from ANY OTHER module. The line-based rule
        // keyed on the substring alone and would have reported this one.
        'import { setTimeout as raf } from "./_timer.ts";',
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
    match: (node) => isCallOfMember(node, "expect", "poll"),
    // Report at `.poll` rather than at the call's own start: wrapped, the call
    // begins on an `await expect` line that names nothing a reader can act on.
    at: (node) => node.callee.property,
    paths: SOURCE_PATHSPECS,
    samples: {
      matches: [
        "await expect.poll(() => n).toBe(0);",
        // The WRAPPED form, which is what Biome emits once the poll options do
        // not fit on one line, and what the line-based rule reported 0 for
        // against two live occurrences in two scenario suites.
        [
          "await expect",
          "  .poll(async () => (await read()).length, { timeout: 10_000 })",
          "  .toBe(1);",
        ].join("\n"),
      ],
      ignores: [
        "await vi.waitFor(() => expect(n).toBe(0));",
        "await vi.waitUntil(() => n > 0, { interval: 50 });",
        "expect(n).toBe(0);",
        // The name is a hazard only on `expect`. A poll of one's own is fine.
        "await pollUntilReady(url);",
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
      "times for a guard that reports success over the shape it cannot see.\n" +
      "\n" +
      "This rule spent its whole life as a line pattern that could not see\n" +
      "`await expect` with `.poll(` on the next line, and reported 0 over two\n" +
      "live occurrences. It is a node rule now.",
  },
  {
    id: 23,
    key: "rule23_asyncEventListener",
    label: "async function as an event listener",
    // Here rather than in `-rules-state.mjs` because the family question is the
    // one this module asks — "how is this code waiting?" — with the answer
    // "it isn't, and neither is anyone else". Rule 21 already established that
    // a rule belongs here when the REMEDY is a different way of handing off an
    // async result, even when the hazard is not the wait itself.
    match: (node) => asyncListener(node) !== undefined,
    paths: SOURCE_PATHSPECS,
    samples: {
      matches: [
        'ws.on("message", async (raw) => { await handle(raw); });',
        'signal.addEventListener("abort", async () => { await drain(); });',
        'emitter.once("open", async function reconnect() { await dial(); });',
        "target.addListener(EVENTS.data, async (chunk) => { await write(chunk); });",
        // A listener with an OPTIONS argument after it — the hazard with a
        // third argument, which the event-name character class could not reach.
        'signal.addEventListener("abort", async () => { await drain(); }, { once: true });',
      ],
      ignores: [
        // The remedy: a sync listener that hands the promise somewhere.
        'ws.on("message", (raw) => { void handle(raw).catch(report); });',
        'signal.addEventListener("abort", () => controller.abort());',
        'emitter.on("data", onData);',
        // `once` as the node:events HELPER, which awaits and is the correct
        // spelling. It is a bare call, not a registration on an object.
        'const [chunk] = await once(stream, "data");',
        // A hono handler: the framework awaits it, and the `async` sits in the
        // THIRD argument position rather than the listener's.
        'app.on("GET", "/health", async (c) => c.text("ok"));',
      ],
    },
    remedy:
      "Keep the listener SYNCHRONOUS and hand the promise to something that\n" +
      "observes it:\n" +
      "\n" +
      '  emitter.on("data", (chunk) => { void handle(chunk).catch(report); });\n' +
      "\n" +
      "or wrap the whole body in try/catch so the listener cannot reject at all.\n" +
      "\n" +
      "An `async` listener returns a promise to the emitter, and an emitter\n" +
      "DISCARDS what a listener returns. So a throw inside it does not fail the\n" +
      "operation it belongs to — it becomes an unhandled rejection with no\n" +
      "session, no request and no turn attached to it, which on the platform is\n" +
      "a whole-process crash rather than one degraded session. That is not\n" +
      "hypothetical here: it is the shape of the cartesia-js TTS bug in\n" +
      "packages/aai/CHANGELOG.md, where a socket error with no `error` listener\n" +
      "bound took down the host.\n" +
      "\n" +
      "Biome's `noMisusedPromises` is ON and does NOT cover this. Measured: it\n" +
      "reports an async callback passed to a locally-declared `() => void`\n" +
      "parameter, and reports nothing for `EventEmitter.on` or\n" +
      "`AbortSignal.addEventListener`, whose types come from `@types/node` and\n" +
      "`lib.dom`. The same blind spot hides every floating promise returned by a\n" +
      "`node:` builtin (`writeFile`, `pipeline`, `finished`, `setTimeout` from\n" +
      "node:timers/promises). This rule closes the half a scan can see; the\n" +
      "other half is a documented limitation in AGENTS.md, because the\n" +
      "floating-call form is indistinguishable from an arrow expression body\n" +
      "that legitimately RETURNS the promise.",
  },
  {
    id: 31,
    key: "rule31_handRolledJitter",
    label: "hand-rolled jittered backoff",
    match: isJitteredWindow,
    paths: SOURCE_PATHSPECS,
    samples: {
      matches: [
        "const wait = window / 2 + Math.random() * (window / 2);",
        "const wait = Math.random() * (window / 2) + window / 2;",
        "const wait = span / 3 + Math.random() * (span / 3);",
      ],
      ignores: [
        "const wait = jitteredBackoff(attempt, { baseMs: UPLOAD_RETRY_BASE_MS });",
        // The DOUBLING on its own is legitimate and must not be swept in.
        "const delay = Math.min(EVENTS_RETRY_MS * 2 ** (failures - 1), EVENTS_RETRY_MAX_MS);",
        "const size = Math.min(UPLOAD_PART_BYTES, UPLOAD_CHUNK_BYTES * 2 ** n);",
        // A bare draw, with no window to spread over, is a different thing.
        "const pick = items[Math.floor(Math.random() * items.length)];",
      ],
    },
    remedy:
      "Use `jitteredBackoff` from @alexkroman1/aai/internal.\n" +
      "\n" +
      "There were THREE byte-identical copies of this, in two packages, and two\n" +
      "of them had even named their local function `retryDelay`:\n" +
      "`sdk/_upload-retry.ts`, `sdk/_upload-resume.ts` and\n" +
      "`aai-runtime/_upload-blobs-brokered.ts`. Each carried its own comment\n" +
      "explaining why the jitter is there, which is this repo's standing tell\n" +
      "that the explanation IS the function.\n" +
      "\n" +
      "The rule is on the JITTER rather than on the doubling because the\n" +
      "doubling is legitimate alone — `use-event-stream.ts` reconnects on the\n" +
      "same window with no jitter and asserts its gaps exactly, and\n" +
      "`_upload-byte-util.ts` doubles bytes rather than milliseconds. What a\n" +
      "copy gets wrong is the spread: callers that failed together retry\n" +
      "together, so a fixed schedule brings a fan-out's parts, two browser tabs\n" +
      "or a claim's concurrent probes back to one still-recovering far side at\n" +
      "the same instant — which is how a transient failure becomes a sustained\n" +
      "one. The shared helper draws uniformly from the lower half of the\n" +
      "window, so the wait still grows and never exceeds the window a caller\n" +
      "budgeted for.\n" +
      "\n" +
      "It deliberately does NOT read `Retry-After`: a far side that names a\n" +
      "delay knows something the arithmetic cannot, so prefer the header and\n" +
      "fall through to this — which is what `_upload-retry.ts` does.",
  },
];
