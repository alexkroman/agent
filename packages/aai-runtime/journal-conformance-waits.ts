// Copyright 2026 the AAI authors. MIT license.
/**
 * The {@link JournalStore} contract's second half: sleeps and hooks — "may this
 * wait still be answered".
 *
 * Split from `journal-conformance-cases.ts` at the seam the platform's own store
 * already splits on (`platform-workflow-journal-hooks.ts`). The entry point and
 * the whole argument are in `journal-conformance.ts`.
 *
 * Two of the five drifts a review found live here, and both are about a verdict
 * rather than a value: `closeHook` was not a compare-and-set, so two replays of
 * one body took different branches; and `wakeSleeps` let `""` stand in for a
 * missing correlation id on two backends out of three.
 *
 * @internal
 */

import { describe, expect, test } from "vitest";
import { type JournalArm, keysFor, runOf } from "./journal-conformance-cases.ts";
import { JournalConflictError } from "./workflow-journal-types.ts";

/** Far enough out that no case's wall-clock reads it as elapsed. */
const FAR = 60_000;

/**
 * The sleep/hook half of the contract.
 *
 * @internal
 */
export function journalWaitConformance(arm: JournalArm): void {
  describe(`journal conformance (waits): ${arm.label}`, () => {
    describe("claimSleep decides a deadline ONCE", () => {
      test("the first write wins and every later call is a READ", async () => {
        // A body is replayed, so `ctx.sleep("poll", 60_000)` is evaluated again on every
        // delivery. Storing the newly-computed deadline each time pushes it 60
        // seconds further out per replay and the run never wakes.
        const journal = arm.journal();
        const { runId } = keysFor(arm);
        await journal.createRun(runOf({ runId }));
        const at = Date.now() + FAR;
        const first = await journal.claimSleep(runId, "wait#0", at, undefined);
        const second = await journal.claimSleep(runId, "wait#0", at + FAR, "review");
        expect(first.wakeAt).toBe(at);
        expect(second).toEqual(first);
      });

      test("a sleep declared with NO correlation id reads back with none", async () => {
        const journal = arm.journal();
        const { runId } = keysFor(arm);
        await journal.createRun(runOf({ runId }));
        const record = await journal.claimSleep(runId, "wait#0", Date.now() + FAR, undefined);
        expect(record.correlationId).toBeUndefined();
        expect(record.woken).toBe(false);
      });

      test("a correlation id and a kind are stored and read back", async () => {
        const journal = arm.journal();
        const { runId } = keysFor(arm);
        await journal.createRun(runOf({ runId }));
        const record = await journal.claimSleep(
          runId,
          "approve#0",
          Date.now() + FAR,
          "review",
          "hookTimeout",
        );
        expect(record).toEqual({
          wakeAt: record.wakeAt,
          woken: false,
          correlationId: "review",
          kind: "hookTimeout",
        });
      });

      test("kind defaults to sleep", async () => {
        const journal = arm.journal();
        const { runId } = keysFor(arm);
        await journal.createRun(runOf({ runId }));
        const record = await journal.claimSleep(runId, "wait#0", Date.now() + FAR, undefined);
        expect(record.kind).toBe("sleep");
      });

      test("two concurrent claims of one key agree on one deadline", async () => {
        const journal = arm.journal();
        const { runId } = keysFor(arm);
        await journal.createRun(runOf({ runId }));
        const at = Date.now() + FAR;
        const [a, b] = await Promise.all([
          journal.claimSleep(runId, "wait#0", at, undefined),
          journal.claimSleep(runId, "wait#0", at + 5000, undefined),
        ]);
        expect(a).toEqual(b);
      });
    });

    describe("readSleeps answers the whole run in one read", () => {
      test("a run with no waits reads back an empty list, not a throw", async () => {
        // The replay engine takes this read at the TOP of every walk, before it
        // knows whether the body waits at all — so the ordinary answer for most
        // runs is nothing, and a backend that threw would fail every delivery of
        // every wait-free workflow.
        const journal = arm.journal();
        const { runId } = keysFor(arm);
        await journal.createRun(runOf({ runId }));
        expect(await journal.readSleeps(runId)).toEqual([]);
      });

      test("every wait comes back, ordered by key, with its own claimSleep record", async () => {
        // The whole point of the bulk read is that a walk may answer an elapsed
        // wait WITHOUT claiming it, so what it hands back has to be exactly what
        // the claim would have — field for field, both kinds, per key.
        const journal = arm.journal();
        const { runId } = keysFor(arm);
        await journal.createRun(runOf({ runId }));
        const at = Date.now() + FAR;
        const b = await journal.claimSleep(runId, "poll#1", at, "batch");
        const a = await journal.claimSleep(runId, "poll#0", at - 1000, undefined);
        const deadline = await journal.claimSleep(
          runId,
          "hookTimeout#0",
          at,
          undefined,
          "hookTimeout",
        );
        expect(await journal.readSleeps(runId)).toEqual([
          { ...deadline, key: "hookTimeout#0" },
          { ...a, key: "poll#0" },
          { ...b, key: "poll#1" },
        ]);
      });

      test("a wake is VISIBLE to it, which is the fact a snapshot may act on", async () => {
        // `woken` is the monotonic flag the engine short-circuits an elapsed wait
        // on. A backend whose bulk read did not carry it would leave every walk
        // round-tripping, silently.
        const journal = arm.journal();
        const { runId } = keysFor(arm);
        await journal.createRun(runOf({ runId }));
        await journal.claimSleep(runId, "nap#0", Date.now() + FAR, undefined);
        expect(await journal.wakeSleeps(runId, undefined)).toBe(1);
        expect((await journal.readSleeps(runId)).map((record) => record.woken)).toEqual([true]);
      });

      test("a run that does not exist reads back nothing", async () => {
        // Unlike the four CLAIM methods, this is defined for a run with no
        // record: the engine reaches it before the body runs, and "no waits" is
        // the honest answer to a question about a run that has none.
        expect(await arm.journal().readSleeps(`${arm.uid()}-absent`)).toEqual([]);
      });
    });

    describe("wakeSleeps answers what THIS call changed", () => {
      test("a bare wake reaches ordinary sleeps and NOT a hook's deadline", async () => {
        // A `waitFor(token, { timeoutMs })` journals its deadline through the
        // same primitive as `ctx.sleep`, and without the `kind` test the "send it
        // now" call a tool makes to cut a SCHEDULE short also closed any pending
        // approval window on the run.
        const journal = arm.journal();
        const { runId } = keysFor(arm);
        await journal.createRun(runOf({ runId }));
        const at = Date.now() + FAR;
        await journal.claimSleep(runId, "nap#0", at, undefined, "sleep");
        await journal.claimSleep(runId, "approve#0", at, "review", "hookTimeout");
        expect(await journal.wakeSleeps(runId, undefined)).toBe(1);
        expect((await journal.claimSleep(runId, "nap#0", at, undefined)).woken).toBe(true);
        expect((await journal.claimSleep(runId, "approve#0", at, "review")).woken).toBe(false);
      });

      test("named correlation ids reach exactly the waits that declared one", async () => {
        const journal = arm.journal();
        const { runId } = keysFor(arm);
        await journal.createRun(runOf({ runId }));
        const at = Date.now() + FAR;
        await journal.claimSleep(runId, "a#0", at, "review", "hookTimeout");
        await journal.claimSleep(runId, "b#0", at, "audit", "hookTimeout");
        expect(await journal.wakeSleeps(runId, ["review"])).toBe(1);
        expect((await journal.claimSleep(runId, "b#0", at, "audit")).woken).toBe(false);
      });

      test("an EMPTY-STRING correlation id does not reach a wait that declared none", async () => {
        // The contract is "the waits declared with one of those ids", and a wait
        // declared with none was not declared with `""`. Two of the three
        // backends used to fold the two together (`?? ""` and
        // `coalesce(correlation_id, '')`), so an author whose id list happened to
        // contain an empty string woke every uncorrelated sleep on the run — and
        // the same fold makes a wait genuinely declared `""` indistinguishable
        // from one declared nothing, which is the absence bug in the other
        // direction.
        const journal = arm.journal();
        const { runId } = keysFor(arm);
        await journal.createRun(runOf({ runId }));
        await journal.claimSleep(runId, "nap#0", Date.now() + FAR, undefined, "sleep");
        expect(await journal.wakeSleeps(runId, [""])).toBe(0);
      });

      test("an already-woken wait is not counted a second time", async () => {
        // The number is what this call CHANGED, which is what makes `0` an answer
        // a caller can act on rather than a tie between "nothing was waiting" and
        // "I woke something twice".
        const journal = arm.journal();
        const { runId } = keysFor(arm);
        await journal.createRun(runOf({ runId }));
        await journal.claimSleep(runId, "nap#0", Date.now() + FAR, undefined);
        expect(await journal.wakeSleeps(runId, undefined)).toBe(1);
        expect(await journal.wakeSleeps(runId, undefined)).toBe(0);
      });

      test("an ELAPSED wait is not one this call stopped", async () => {
        const journal = arm.journal();
        const { runId } = keysFor(arm);
        await journal.createRun(runOf({ runId }));
        await journal.claimSleep(runId, "nap#0", Date.now() - FAR, undefined);
        expect(await journal.wakeSleeps(runId, undefined)).toBe(0);
      });

      test("a run nobody started, and a run with no waits, both answer 0", async () => {
        const journal = arm.journal();
        const { runId } = keysFor(arm);
        const missing = keysFor(arm);
        await journal.createRun(runOf({ runId }));
        expect(await journal.wakeSleeps(runId, undefined)).toBe(0);
        expect(await journal.wakeSleeps(missing.runId, undefined)).toBe(0);
      });
    });

    describe("claimHook opens ONE window per key", () => {
      test("a fresh window is neither delivered nor closed", async () => {
        const journal = arm.journal();
        const { runId, token } = keysFor(arm);
        await journal.createRun(runOf({ runId }));
        // `closed` is spelled out rather than merely falsy. It is the field that
        // decides which of two branches a replay takes, and a backend answering
        // `undefined` where the others answer `false` is the same absence
        // ambiguity this table exists to remove — one that is invisible to every
        // truthiness test in the engine right up until somebody writes
        // `closed === false`.
        const record = await journal.claimHook(runId, "ask#0", token);
        expect(record.token).toBe(token);
        expect(record.delivered).toBe(false);
        expect(record.closed).toBe(false);
        expect(record.payload).toBeUndefined();
      });

      test("a re-claim by the same run and key is the ordinary REPLAY path", async () => {
        const journal = arm.journal();
        const { runId, token } = keysFor(arm);
        await journal.createRun(runOf({ runId }));
        const first = await journal.claimHook(runId, "ask#0", token);
        expect(await journal.claimHook(runId, "ask#0", token)).toEqual(first);
      });

      /**
       * The refusal is typed, and `toThrow()` alone is not the claim.
       *
       * The engine reads `JournalConflictError` to decide between failing the run
       * and treating the store as unavailable and retrying the delivery — see
       * `workflow-replay-journal-failure.ts` — so an arm that refuses with a
       * plain `Error` has a conflicted run retried until its budget runs out
       * while every other arm fails it at once. That is invisible to a
       * `toThrow()`, which is what these two asserted for as long as they
       * existed, and it is exactly the kind of per-arm divergence this table is
       * for.
       */
      test("a token another RUN holds is refused, as a typed CONFLICT", async () => {
        // Two waits sharing a token means one signal resolves whichever the store
        // happens to find and the other waits forever — a bug worth failing the
        // run over rather than resolving arbitrarily.
        const journal = arm.journal();
        const one = keysFor(arm);
        const two = keysFor(arm);
        await journal.createRun(runOf({ runId: one.runId }));
        await journal.createRun(runOf({ runId: two.runId }));
        await journal.claimHook(one.runId, "ask#0", one.token);
        await expect(journal.claimHook(two.runId, "ask#0", one.token)).rejects.toSatisfy(
          JournalConflictError.is,
        );
      });

      test("a token another KEY of the same run holds is refused too", async () => {
        const journal = arm.journal();
        const { runId, token } = keysFor(arm);
        await journal.createRun(runOf({ runId }));
        await journal.claimHook(runId, "ask#0", token);
        await expect(journal.claimHook(runId, "ask#1", token)).rejects.toSatisfy(
          JournalConflictError.is,
        );
      });
    });

    describe("deliverHook is addressed by TOKEN and answers once", () => {
      test("it answers the run that was waiting, and the payload is readable", async () => {
        const journal = arm.journal();
        const { runId, token } = keysFor(arm);
        await journal.createRun(runOf({ runId }));
        await journal.claimHook(runId, "ask#0", token);
        expect(await journal.deliverHook(token, { approved: true })).toBe(runId);
        const record = await journal.claimHook(runId, "ask#0", token);
        expect(record.delivered).toBe(true);
        expect(record.payload).toEqual({ approved: true });
      });

      test("a typed-JSON payload survives", async () => {
        const journal = arm.journal();
        const { runId, token } = keysFor(arm);
        await journal.createRun(runOf({ runId }));
        await journal.claimHook(runId, "ask#0", token);
        const payload = { sig: new Uint8Array([4, 5]), at: new Date(1_700_000_000_002) };
        await journal.deliverHook(token, payload);
        expect((await journal.claimHook(runId, "ask#0", token)).payload).toEqual(payload);
      });

      test("a token nobody holds is the ORDINARY answer, not an error", async () => {
        const journal = arm.journal();
        const { token } = keysFor(arm);
        expect(await journal.deliverHook(token, {})).toBeUndefined();
      });

      test("a second signal is refused, and the FIRST payload stands", async () => {
        const journal = arm.journal();
        const { runId, token } = keysFor(arm);
        await journal.createRun(runOf({ runId }));
        await journal.claimHook(runId, "ask#0", token);
        await journal.deliverHook(token, "first");
        expect(await journal.deliverHook(token, "second")).toBeUndefined();
        expect((await journal.claimHook(runId, "ask#0", token)).payload).toBe("first");
      });

      test("two concurrent signals: exactly one wins", async () => {
        const journal = arm.journal();
        const { runId, token } = keysFor(arm);
        await journal.createRun(runOf({ runId }));
        await journal.claimHook(runId, "ask#0", token);
        const answers = await Promise.all([
          journal.deliverHook(token, "a"),
          journal.deliverHook(token, "b"),
        ]);
        expect(answers.filter((a) => a !== undefined)).toEqual([runId]);
      });
    });

    describe("closeHook has exactly TWO verdicts", () => {
      test("true when the window is closed by this call", async () => {
        const journal = arm.journal();
        const { runId, token } = keysFor(arm);
        await journal.createRun(runOf({ runId }));
        await journal.claimHook(runId, "ask#0", token);
        expect(await journal.closeHook(runId, "ask#0")).toBe(true);
        expect((await journal.claimHook(runId, "ask#0", token)).closed).toBe(true);
      });

      test("true again when it was already closed", async () => {
        const journal = arm.journal();
        const { runId, token } = keysFor(arm);
        await journal.createRun(runOf({ runId }));
        await journal.claimHook(runId, "ask#0", token);
        await journal.closeHook(runId, "ask#0");
        expect(await journal.closeHook(runId, "ask#0")).toBe(true);
      });

      test("true when the window is GONE entirely", async () => {
        // A terminal run has already given its tokens back, so no signal can be
        // taken and the caller's timeout stands.
        const journal = arm.journal();
        const { runId } = keysFor(arm);
        const missing = keysFor(arm);
        await journal.createRun(runOf({ runId }));
        expect(await journal.closeHook(runId, "never#0")).toBe(true);
        expect(await journal.closeHook(missing.runId, "never#0")).toBe(true);
      });

      test("FALSE once the window was answered, and the answer stands", async () => {
        // Unconditional, this prevented only half the divergence it exists to
        // prevent: the engine reads the deadline, then closes, and a signal
        // landing between the two left THIS walk taking the timed-out branch
        // while every later replay read `delivered: true` and took the answered
        // one. The boolean is what the caller branches on.
        const journal = arm.journal();
        const { runId, token } = keysFor(arm);
        await journal.createRun(runOf({ runId }));
        await journal.claimHook(runId, "ask#0", token);
        await journal.deliverHook(token, { approved: true });
        expect(await journal.closeHook(runId, "ask#0")).toBe(false);
        const record = await journal.claimHook(runId, "ask#0", token);
        expect(record.delivered).toBe(true);
        expect(record.payload).toEqual({ approved: true });
      });

      test("a closed window refuses every later signal", async () => {
        const journal = arm.journal();
        const { runId, token } = keysFor(arm);
        await journal.createRun(runOf({ runId }));
        await journal.claimHook(runId, "ask#0", token);
        await journal.closeHook(runId, "ask#0");
        expect(await journal.deliverHook(token, "late")).toBeUndefined();
        expect((await journal.claimHook(runId, "ask#0", token)).delivered).toBe(false);
      });
    });

    describe("a TERMINAL run gives its hook tokens back", () => {
      test("a DERIVED token serves the next run once the first one settles", async () => {
        // A token is held for as long as its run might still be answered, and no
        // longer. Held past that, a derived token — which is what the SDK tells
        // authors to use — served exactly one run ever: the second claim hit the
        // conflict, which is not a suspend, so the saga compensated.
        const journal = arm.journal();
        const one = keysFor(arm);
        const two = keysFor(arm);
        const shared = `derived-${one.token}`;
        await journal.createRun(runOf({ runId: one.runId, status: "running" }));
        await journal.claimHook(one.runId, "ask#0", shared);
        await journal.setStatus(one.runId, "completed", { output: 1 });
        await journal.createRun(runOf({ runId: two.runId, status: "running" }));
        const record = await journal.claimHook(two.runId, "ask#0", shared);
        expect(record.token).toBe(shared);
        expect(record.delivered).toBe(false);
      });

      test("a signal for a settled run's token is refused", async () => {
        const journal = arm.journal();
        const { runId, token } = keysFor(arm);
        await journal.createRun(runOf({ runId, status: "running" }));
        await journal.claimHook(runId, "ask#0", token);
        await journal.setStatus(runId, "failed", { error: { message: "gave up" } });
        expect(await journal.deliverHook(token, "late")).toBeUndefined();
      });

      test("a NON-terminal move keeps the token — that is the whole point of a hook", async () => {
        const journal = arm.journal();
        const { runId, token } = keysFor(arm);
        await journal.createRun(runOf({ runId, status: "pending" }));
        await journal.claimHook(runId, "ask#0", token);
        expect(await journal.setStatus(runId, "running")).toBe(true);
        expect(await journal.deliverHook(token, "still here")).toBe(runId);
      });
    });
  });
}
