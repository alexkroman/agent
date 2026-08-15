// Copyright 2026 the AAI authors. MIT license.
/**
 * Property test over the S2S stack — fast-check model-based commands
 * (`_s2s-fuzz-commands.ts`) against the real stack (`_s2s-fuzz-harness.ts`) over
 * a fake socket (`_s2s-fuzz-model.ts`).
 *
 * The scripted specs in `host/s2s.test.ts`, `host/s2s-events.test.ts`, and
 * `host/transports/s2s-transport.test.ts` each assert ONE interleaving, and each
 * stubs out a neighbouring layer — the transport specs mock `connectS2s`, the
 * wire specs mock the callbacks. Here the only fake is the SOCKET, so
 * `connectS2s`, `createS2sTransport`, and `createSessionCore` all run for real
 * with a recording `ClientSink` at the far end.
 *
 * That composition is the point — both bugs it found need two layers at once to
 * be visible, and every single-layer suite was green:
 *
 * - **In-band service errors were reported as FATAL while the session ran on.**
 *   A `session.error` with a non-expiry code closes nothing, so the run kept
 *   producing `tool_call`, `reply_done`, and audio afterwards — to a client that
 *   answers a fatal frame by releasing the microphone. Seeing it needs the wire
 *   layer (which frame), the transport (what it maps to) and the client contract
 *   (what fatal MEANS) in one place.
 * - **Retiring the session left the socket open.** When the service rejects a
 *   `session.resume` in band (`session_not_found`) nothing closes, so a retired
 *   transport went on relaying a live provider socket's frames to a client it
 *   had just told the call was over.
 *
 * A third suspicion — that `createSessionCore` discarded the tool results
 * `createS2sTransport`'s redelivery queue exists for — was DISPROVED here, which
 * is the other thing a property test is for. `onReplyDone` clears
 * `currentReplyId`, so the resume path does not report a cancel for a turn that
 * already ended, the reply object survives, and the result is queued and
 * redelivered.
 *
 * Three rules for extending it:
 *
 * - **Every oracle must be a property a real provider or client enforces.** A
 *   speech-state oracle was drafted and dropped for failing this: the default
 *   client does not latch `speech_started`, so "the session ended mid-speech" is
 *   not something anything downstream can observe.
 * - **The generator must not itself break a provider contract.** That is what
 *   the commands' `check()` is for; see `_s2s-fuzz-commands.ts`.
 * - **No timers.** Tool settlement and socket opening are COMMANDS, so when a
 *   tool settles relative to a drop is part of the generated plan instead of a
 *   race — which is what makes fast-check's shrinking and seed replay mean
 *   anything. The predecessor of this suite awaited real `setTimeout`s and could
 *   not re-run its own counterexamples.
 *
 * `COVERAGE_FLOORS` fails the suite when the runs stop reaching resumes, tool
 * calls that outlive a drop, or in-band retirement: an all-green property proves
 * nothing about a state it never entered. The `skip:*` counters exist because
 * the tool-answer oracle has broad exemptions that can silence it completely
 * while every other number still looks healthy — which is exactly what an early
 * draft did.
 */

import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { S2S_MAX_RESUME_ATTEMPTS } from "../../sdk/constants.ts";
import type { SessionEvent } from "../../sdk/protocol.ts";
import type { Cmd } from "./_s2s-fuzz-commands.ts";
import { createHarness, drain, type Harness } from "./_s2s-fuzz-harness.ts";
import type { CallRecord } from "./_s2s-fuzz-model.ts";
import { liveSessionCommands, retirementCommands } from "./_s2s-fuzz-plans.ts";
import { freshModel } from "./_s2s-fuzz-service.ts";

/**
 * Three properties, differing only in how much destruction each run may spend
 * (`ServiceModel.faultBudget`) — which is also what each one is FOR. One
 * combined property cannot serve both ends: at 2 faults per 40 commands a tool
 * call rarely survived to be answered (the central oracle ran 7 times out of 80
 * executions), and at 0 there are no resumes to redeliver across.
 */
/**
 * Run counts are sized by the COVERAGE FLOORS below, not by wall clock, and
 * they were tripled after measuring what the floors actually see.
 *
 * The whole harness is in memory — fake sockets, no timers — so 260 runs cost
 * 85ms, which made the run counts look generous and made every floor a coin
 * flip instead. Measured over 40 fresh runs at the old counts, **three failed
 * (7.5%)**, and on four different counters: `drop.withToolInFlight=0` (floor 1),
 * `fatalDrop=1` (floor 2), `toolAnsweredAcrossResume=4` (floor 6) and
 * `resume.withOutstandingTools=9` (floor 10). Two of those were also seen in
 * CI, on opposite OS legs, which is what prompted the measurement.
 *
 * The failure was never one mis-set number: several floors sat one sample above
 * the left tail of their distribution, and with eight of them the per-run
 * probability compounds. The fix is therefore to move the DISTRIBUTIONS right
 * rather than the floors down — a lower floor buys quiet by proving less, and
 * these floors are the difference between a live oracle and a decorative one
 * (see `toolAnsweredAcrossResume`). Counts scale about linearly with `runs`
 * while the relative spread narrows, so tripling puts every floor deep in the
 * tail at a cost of ~200ms.
 *
 * If a floor flakes again, re-measure with `S2S_FUZZ_COVERAGE=1` and raise
 * these numbers — do not lower the floor.
 */
const PROPERTIES = [
  /** Turns, tool calls, batched results — nothing destructive is legal at all. */
  { label: "turns", runs: 300, faultBudget: 0, retirement: false },
  /** Drops, resumes, and the tool results that have to survive them. */
  { label: "reconnects", runs: 360, faultBudget: 2, retirement: false },
  /** Fatal closes and in-band `session_not_found` — retirement must be FINAL. */
  { label: "retirement", runs: 120, faultBudget: 3, retirement: true },
] as const;

/** Total generated runs, for the floors below. */
const TOTAL_RUNS = PROPERTIES.reduce((sum, p) => sum + p.runs, 0);

type Coverage = Record<string, number>;

function hit(cov: Coverage, key: string): void {
  cov[key] = (cov[key] ?? 0) + 1;
}

function eventCount(h: Harness, type: SessionEvent["type"]): number {
  return h.events.filter((e) => e.type === type).length;
}

/**
 * Whether the service is still owed an answer for `call` — and, when it is not,
 * WHY, recorded as coverage. Those counters are load-bearing: the exemptions are
 * broad enough that a bug in one of them would silence the oracle entirely, and
 * "no violations" would then read as "the code is correct".
 */
function mustBeAnswered(call: CallRecord, h: Harness, linkReady: boolean): boolean {
  const skip = (why: string): false => {
    hit(h.cov, `skip:${why}`);
    return false;
  };
  if (call.replyEnded === null) return skip("turnStillOpen"); // results flush on reply.done
  if (call.replyEnded === "interrupted") return skip("interrupted"); // abandoned service-side
  if (h.excused.has(call.callId)) return skip("reset"); // the user stranded it
  if (h.declaredDead !== null) return skip("retired"); // no session left to answer on
  if (!linkReady) return skip("linkNotReady"); // nothing to send it on yet
  if (!h.settled.has(call.callId)) return skip("toolNotSettled"); // no result exists yet
  // Results flush per REPLY, as a batch: `SessionCore.onReplyDone` awaits the
  // whole turn promise (every tool the reply issued) before sending any of them.
  // So a settled call whose SIBLING is still running is a turn in progress, not
  // a stall — demanding an answer there is the oracle being wrong about the
  // contract, which is exactly what it did until fast-check shrank a two-tool
  // reply down for inspection.
  const siblingPending = [...h.link.calls.values()].some(
    (other) => other.replyId === call.replyId && !h.settled.has(other.callId),
  );
  if (siblingPending) return skip("siblingToolPending");
  return true;
}

/**
 * THE oracle: a tool call the service issued gets exactly one answer.
 *
 * Both halves are what a real provider enforces. Two `tool.result` frames for
 * one `call_id` is a protocol violation; zero leaves the service holding a turn
 * it can never continue, which the user experiences as an agent that goes silent
 * mid-conversation and stays that way until the idle timeout.
 */
function checkToolAnswers(h: Harness): string[] {
  const problems: string[] = [];
  const live = h.link.current();
  const linkReady = live !== undefined && !live.dead && live.sessionId !== null;
  for (const [id, call] of h.link.calls) {
    if (call.answers > 1) {
      problems.push(`tool ${id} answered ${call.answers} times — the service issued one call`);
    }
    if (!mustBeAnswered(call, h, linkReady)) continue;
    if (call.answers === 0) {
      problems.push(
        `tool ${id} never answered — the service is still awaiting it ` +
          `(issued on socket ${call.socketId}, survivedResume=${call.survivedResume})`,
      );
      continue;
    }
    hit(h.cov, "toolAnswered");
    if (call.survivedResume) hit(h.cov, "toolAnsweredAcrossResume");
  }
  return problems;
}

/** Per-socket frame shape: one handshake each, and nothing sent while closed. */
function checkSocketFrames(h: Harness): string[] {
  const problems: string[] = [];
  for (const sock of h.link.sockets) {
    if (sock.sentWhileNotOpen.length > 0) {
      problems.push(`socket ${sock.id} was written to while not OPEN: ${sock.sentWhileNotOpen[0]}`);
    }
    const updates = sock.sent.filter((f) => f.type === "session.update").length;
    const resumes = sock.sent.filter((f) => f.type === "session.resume").length;
    if (updates > 1 || resumes > 1 || (updates > 0 && resumes > 0)) {
      problems.push(
        `socket ${sock.id} sent ${updates} session.update and ${resumes} session.resume`,
      );
    }
  }
  for (const requested of h.link.resumeRequests) {
    if (!h.link.issuedSessionIds.has(requested)) {
      problems.push(`session.resume asked for ${requested}, which the service never issued`);
    }
  }
  return problems;
}

/** Retirement is final, and reconnecting is bounded. */
function checkRetirement(h: Harness): string[] {
  const problems: string[] = [];
  const fatal = h.events.filter(
    (e) => e.type === "error.reported" && e.code === "connection",
  ).length;
  if (fatal > 1) {
    problems.push(`${fatal} fatal connection errors for one session — the latch failed`);
  }
  if (h.socketsAtRetirement !== null && h.link.sockets.length > h.socketsAtRetirement) {
    problems.push("a socket was opened after the session was retired");
  }
  // A retired session must hold no socket. Not all fatal paths arrive from a
  // close: the service can reject a `session.resume` with `session_not_found` IN
  // BAND and leave the socket open, and the transport then held a live (billed)
  // provider session for a call it had just told the client was over. Checked
  // here rather than only after `stop()` — by then the teardown has closed
  // everything, which is precisely what hid this.
  if (h.declaredDead !== null) {
    for (const sock of h.link.sockets) {
      if (!sock.dead) {
        problems.push(`socket ${sock.id} still open after the session was retired`);
      }
    }
  }
  // Each reply that landed is real progress, which resets the resume budget by
  // design (see `startResume`) — so the bound has to grow with them.
  const bound = 1 + S2S_MAX_RESUME_ATTEMPTS + eventCount(h, "reply.completed") + h.link.calls.size;
  if (h.link.sockets.length > bound) {
    problems.push(`${h.link.sockets.length} sockets opened (bound ${bound}) — resume is looping`);
  }
  return problems;
}

/**
 * Oracles over the finished run. The streaming ones live in the harness's sink
 * (they can only fire at the moment an event reaches the client); these need the
 * whole run, and run BEFORE stop(), because stop() legitimately abandons work.
 */
function checkFinalState(h: Harness): string[] {
  return [...checkToolAnswers(h), ...checkSocketFrames(h), ...checkRetirement(h)];
}

async function stopAndCheckTeardown(h: Harness): Promise<string[]> {
  const problems: string[] = [];
  const outcome = await Promise.race([
    h.session.stop().then(() => "stopped" as const),
    new Promise<"hung">((r) => setTimeout(() => r("hung"), 5000)),
  ]);
  if (outcome === "hung") problems.push("stop() did not resolve within 5s");
  h.stopped = true;
  await drain();
  for (const sock of h.link.sockets) {
    if (!sock.dead) {
      problems.push(`socket ${sock.id} left open after stop() — a billed provider session`);
    }
  }
  return problems;
}

/**
 * Coverage floors — a table asserted in one go rather than an `expect` per line,
 * because the first missed floor would otherwise hide the rest and the
 * interesting failure is usually several at once (runs that stopped reaching
 * replies stop reaching everything downstream of them). Set well below measured
 * actuals: fast-check reruns are seeded per process, so these have to absorb
 * ordinary generation variance. A run that comes back GREENER is the thing to
 * distrust.
 */
const COVERAGE_FLOORS: Record<string, number> = {
  // One per run, plus one per completed resume.
  sessionReady: TOTAL_RUNS - 20,
  toolExecuted: 40,
  malformedDelivered: 40,
  clientCancel: 60,
  resumeCompleted: 20,
  // The tool-answer oracle: calls it CHECKED, and the subset that had to survive
  // a real `session.resume` to be answered. The second is the one that matters,
  // and the one that has been near zero through three separate mistakes — a
  // model that mis-tracked which socket held the session, a fault rate that
  // destroyed every turn before it finished, and a resume chain too long for
  // uniform picks to complete. It is the floor that stands between a live oracle
  // and a decorative one.
  toolAnswered: 18,
  toolAnsweredAcrossResume: 6,
  "resume.withOutstandingTools": 10,
  // Thin by nature: it needs a drop to land inside the window where the session
  // is executing a tool the service is still awaiting. Measured 2-9.
  "drop.withToolInFlight": 1,
  // The retirement property's two exits: a fatal close code, and the in-band
  // `session_not_found` rejection of a `session.resume` that found the
  // open-socket-after-retirement bug.
  fatalDrop: 2,
  sessionErrorExpired: 2,
  // Audio for a reply the client already cancelled — the one thing
  // `suppressAudioUntilReply` exists to drop.
  audioDuringSuppression: 15,
};

/** Counters that came in below their floor, for a single assertion. */
function floorsMissed(cov: Coverage): string[] {
  return Object.entries(COVERAGE_FLOORS)
    .filter(([key, floor]) => (cov[key] ?? 0) < floor)
    .map(([key, floor]) => `${key}=${cov[key] ?? 0} (floor ${floor})`);
}

describe("S2S stack — property test over event orderings", () => {
  test("global invariants hold across generated command sequences", async () => {
    const cov: Coverage = {};
    const unhandled: string[] = [];
    const onUnhandled = (e: unknown): void => {
      unhandled.push(String(e));
    };
    process.on("unhandledRejection", onUnhandled);

    /** One generated run: drive the commands, then check the finished session. */
    const runPlan = async (cmds: Iterable<Cmd>, faultBudget: number): Promise<void> => {
      const h = await createHarness(cov);
      // The streaming oracles throw from the sink; these are the end-of-run
      // ones. Both reach fast-check as a failed property, so it shrinks to the
      // shortest command sequence that still reproduces the finding.
      await fc.asyncModelRun(() => ({ model: freshModel(faultBudget), real: h }), cmds);
      await drain();
      const problems = [...checkFinalState(h), ...(await stopAndCheckTeardown(h))];
      if (problems.length > 0) throw new Error(problems.join("; "));
    };

    try {
      for (const spec of PROPERTIES) {
        const commands = spec.retirement ? retirementCommands() : liveSessionCommands();
        await fc.assert(
          fc.asyncProperty(commands, (cmds) => runPlan(cmds, spec.faultBudget)),
          { numRuns: spec.runs },
        );
      }
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }

    if (process.env.S2S_FUZZ_COVERAGE === "1") {
      console.log("coverage", JSON.stringify(cov, null, 2));
    }
    expect(unhandled).toEqual([]);
    expect(floorsMissed(cov)).toEqual([]);
  });
});
