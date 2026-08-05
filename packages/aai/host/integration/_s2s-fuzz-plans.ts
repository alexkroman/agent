// Copyright 2026 the AAI authors. MIT license.
/**
 * The weighted command pools the S2S property test's three properties draw from.
 *
 * Weights matter more than they look, and every number here was measured rather
 * than guessed — see the comments inside `commandPool`. The short version: the
 * interesting states are DEEP (ready → reply → tool call → drop → resume →
 * answer), the commands that are ILLEGAL in a given state cost a slot without
 * doing anything, and every destructive event is a chance to strand the tool call
 * the suite's central oracle is about.
 *
 * @internal Test infrastructure, not part of any public API.
 */

import fc from "fast-check";
import {
  AgentText,
  Audio,
  CancelThenStrayAudio,
  ClientAudio,
  ClientCancel,
  ClientReset,
  type Cmd,
  Drop,
  Malformed,
  OpenSocket,
  Ready,
  ReplyDone,
  ReplyStart,
  SessionError,
  SettleTool,
  SocketError,
  SpeechStart,
  SpeechStop,
  ToolCall,
  ToolTurnAcrossResume,
  UserFinal,
  UserPartial,
} from "./_s2s-fuzz-commands.ts";

/** Repeat an entry — how `fc.commands` expresses relative weight. */
function times<T>(n: number, arb: fc.Arbitrary<T>): fc.Arbitrary<T>[] {
  return Array.from({ length: n }, () => arb);
}

/**
 * The command pool.
 *
 * Weights matter more than they look. The interesting states are DEEP (ready →
 * reply → tool call → drop → resume → answer), and everything between a drop and
 * the next `openSocket`+`ready` pair is spent on commands whose target socket is
 * gone — so the gateway commands carry the most weight, and a drop is a minority
 * pick rather than an even one.
 *
 * `withFatal` is the difference between the suite's two properties. A session
 * that has been retired swallows every command after it (and exempts every
 * outstanding tool call from the answer oracle), so mixing the session-killing
 * commands into the deep exploration meant ~2 retirements per run and
 * `toolExecuted` in the teens across 120 runs. They get their own property
 * instead, whose oracles are the retirement ones.
 */
function commandPool(withFatal: boolean): fc.Arbitrary<Cmd>[] {
  const asUpdated = fc.boolean();
  return [
    // Weighted for the state the run spends most of its time in, which is NOT
    // the post-drop one: a `tool.call` makes the service's outstanding call the
    // turn's continuation point, so `ReplyStart`, `Ready`, `OpenSocket`, and
    // `AgentText` are all illegal until it is answered. Weighting the recovery
    // commands heavily (they were 10 of 57 entries) burnt those slots on skipped
    // commands, and runs ended before `reply.done` was ever picked:
    // `skip:turnStillOpen` was the dominant outcome and `toolAnswered` sat at 6
    // out of 81 executions.
    ...times(8, fc.constantFrom(new ReplyDone(false), new ReplyDone(false), new ReplyDone(true))),
    ...times(
      8,
      fc.boolean().map((ok) => new SettleTool(ok)),
    ),
    ...times(4, fc.constant(new ReplyStart())),
    ...times(4, fc.constant(new ToolCall())),
    // Back to heavy: these two are the ONLY way back to a usable session after a
    // drop, and they are illegal (so free) at every other moment. At weight 2
    // most runs never completed the resume their own drop had started —
    // `resumeCompleted` was 8 across 260 runs.
    ...times(5, fc.constant(new OpenSocket())),
    ...times(
      5,
      asUpdated.map((u) => new Ready(u)),
    ),
    ...times(2, fc.constant(new Audio())),
    fc.constant(new AgentText()),
    fc.constant(new SpeechStart()),
    fc.constant(new SpeechStop()),
    fc.constant(new UserPartial()),
    ...times(2, fc.constant(new UserFinal())),
    ...times(2, fc.constant(new ClientAudio())),
    // Everything below abandons work in flight — ONE entry each. A reset strands
    // outstanding calls and a drop aborts the reply's tools, so at even weight
    // the runs spend themselves recovering.
    fc.constant(new ClientCancel()),
    ...times(2, fc.constant(new CancelThenStrayAudio())),
    fc.constant(new ClientReset()),
    fc.nat(9).map((i) => new Malformed(i)),
    fc.nat(3).map((i) => new Drop(true, i)),
    ...times(3, fc.constant(new ToolTurnAcrossResume())),
    fc.constant(new SocketError()),
    fc.constant(new SessionError(false)),
    ...(withFatal
      ? [fc.nat(1).map((i) => new Drop(false, i)), fc.constant(new SessionError(true))]
      : []),
  ];
}

/**
 * A session that is never retired. Used for two of the suite's three properties,
 * which differ only in the `faultBudget` they are run with: at 0 every
 * destructive command is illegal, giving deep turn/tool coverage; at 2 the drops
 * and resumes appear. One pool, because they are the same state machine.
 */
export function liveSessionCommands(): fc.Arbitrary<Iterable<Cmd>> {
  return fc.commands(commandPool(false), {
    maxCommands: 40,
    size: "large",
  });
}

/**
 * The same, plus the two commands that retire the session: a fatal close code,
 * and the in-band `session_not_found` rejection of a `session.resume` that found
 * the open-socket-after-retirement bug. Shorter, because everything after the
 * retirement is a no-op by design — what it is checking is that the retirement
 * is FINAL.
 */
export function retirementCommands(): fc.Arbitrary<Iterable<Cmd>> {
  return fc.commands(commandPool(true), {
    maxCommands: 24,
    size: "large",
  });
}
