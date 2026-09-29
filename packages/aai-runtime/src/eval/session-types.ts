// Copyright 2026 the AAI authors. MIT license.
/**
 * The TYPES of the text-driven eval session: one turn, the session handle, and
 * what opening one takes.
 *
 * Split out of `session.ts` at the 500-line source cap, on the seam the module
 * already had — the declarations a case READS versus the machinery that drives
 * a runtime. `session.ts` re-exports every name here, so where a reader imports
 * them from did not move.
 *
 * @module
 */

import type { SessionCall, SessionEvent } from "@alexkroman1/aai";
import type { LlmProvider } from "@alexkroman1/aai/llm";
import type { HostGenerateFn } from "../generate.ts";
import type { HostAgentOptions } from "../host-agent-options.ts";
import type { EvalToolCall } from "./events.ts";

/**
 * One turn: what the agent did between an utterance and the end of its reply.
 *
 * `say()` hands one back because "on that turn" is most of the meaning of almost
 * every claim an eval makes. `calledTool("get_weather")` over a whole call is a
 * much weaker statement than the same thing about the reply to one question, and
 * a whole-run reader cannot express the stronger one without hand-slicing the
 * event list — which is how an eval comes to assert against the GREETING, a real
 * turn that lands in `said()` before the case has said anything at all.
 */
export type EvalTurn = {
  /** The agent's committed reply, joined — what the caller was told. */
  readonly text: string;
  /** This turn's events, from the committed utterance to the terminator. */
  readonly events: readonly SessionEvent[];
  /**
   * This turn's tool calls, in call order, each with its result — minus the
   * `think` builtin's scratchpad calls (an authored `think` stays). `events`
   * still carries every call.
   */
  readonly toolCalls: readonly EvalToolCall[];
  /**
   * The reply ended on its own terms (`reply.completed`) rather than being
   * cancelled. A cancelled reply is a finding, not a failure of the harness.
   */
  readonly completed: boolean;
  /**
   * The `error.reported` events this turn carried — what the RUNTIME said went
   * wrong. Only `code: "tool"` can appear here, since a turn the pipeline failed
   * is refused before a case sees it (`_turn-faults.ts`); `errorsIn` over
   * `session.events()` is the unfiltered list.
   */
  readonly errors: readonly SessionEvent<"error.reported">[];
  /**
   * A tool ended the session during this turn — the agent HUNG UP
   * (`endSession(ctx)`, a phone agent's `end_call`). `false` for a turn that
   * left the line open.
   *
   * The reply is still here: by default `endSession` lets the reply finish, so
   * the goodbye is this turn's `text` and `completed` is `true`; with
   * `{ afterReply: false }` the turn is what was said before the line went
   * dead. It is the harness's report of the END, which is the claim a hang-up
   * case makes — "it called `end_call`" is a claim about a tool's name, and a
   * tool of that name that forgot to call `endSession` passes it.
   *
   * Optional because a caller implementing `SimulationTarget` builds turns of
   * its own; {@link openEvalSession}'s `say()` always sets it, and the text
   * agent (which has no line to hang up) never does. Read it as `=== true`.
   */
  readonly endedSession?: boolean;
};

/**
 * One live eval session.
 *
 * @sealed
 */
export type EvalSession = {
  /**
   * This session's id — what its tools read as `ctx.sessionId`.
   *
   * Exposed because it is what a tool CORRELATES a durable run with, so a case
   * asserting "the run it started is this conversation's" needs both halves.
   */
  readonly id: string;
  /**
   * The reason the agent's `sessionContext` REFUSED this session, or
   * `undefined` for a session it let through.
   *
   * A value rather than a throw from {@link openEvalSession}, because a
   * refusal is often the CLAIM a case exists to make: a calling agent's
   * `sessionContext` refuses a stream whose `call` parameter names no call it
   * placed, and a case pinning that needs a session to read the answer off —
   * a throw would land before `describeEval` hands the case its session, and
   * the case could only ever fail. It is decided exactly where production
   * decides it (the runtime's own `sessionContext` step, before the
   * transport starts), so a refused session never reached the model and never
   * spoke: `said()` is empty and {@link EvalSession.say} REJECTS, naming the
   * reason. A case that did not expect a refusal therefore still fails at its
   * first `say()`, with the app's own words in the message.
   */
  readonly refused: string | undefined;
  /**
   * The agent ENDED this session: a tool called `endSession(ctx)`. Read live —
   * `false` until then.
   *
   * The end is the session's ordinary stop, exactly as a real connection's
   * close produces it: the log is flushed and `onSessionEnd` fires when the
   * agent hangs up, not when the case closes the session. The turn that hung
   * up returns only once that hook has SETTLED (or 10 seconds have passed), so
   * a case asserts what the hook wrote with no polling; `close()` waits the
   * same way for a hook its own stop fires. From then on
   * {@link EvalSession.say} REJECTS — nobody is on the line — and
   * {@link EvalSession.sayAll} stops after the turn that ended it.
   */
  readonly ended: boolean;
  /**
   * Commit a user turn, wait for the reply to end, and hand back that turn.
   *
   * Waits for a reply TERMINATOR rather than for a timer, which is what makes a
   * case deterministic despite a live model: the next `say()` cannot begin
   * inside the previous turn, so a recorded tool order is the agent's and not
   * the harness's.
   *
   * @throws When the session was {@link EvalSession.refused | refused}, or has
   *   {@link EvalSession.ended | ended} — each naming which.
   */
  say(text: string): Promise<EvalTurn>;
  /**
   * Say every line in order, waiting out each reply, and hand back every turn.
   *
   * Byte-identical in three shipped templates before it was published
   * (`emergency-dispatch-agent`, `retail-orders-agent`, `travel-concierge-agent`), each under a doc reaching
   * the same conclusion independently — which is the tell that it is the
   * harness's concept rather than any template's. The conclusion is the reason
   * to reach for this rather than a list of `say()` calls: a case over several
   * turns must assert about the turn a MECHANISM fired in, never about turn
   * number two, because how many turns an agent takes to get somewhere is the
   * model's business and it measurably varies — `retail-orders-agent`'s desk reads the order
   * back before it stages, so its staging call has landed in turn two, three
   * and four across live runs. A case pinned to a turn index is a flake with a
   * misleading name.
   *
   * `turnCalling`, `toolCallsInTurns` and `describeTurn` (`eval/turns.ts`, published on
   * the same subpath) are what read the result without pinning an index.
   *
   * Strictly sequential, like the caller it stands for: each line is committed
   * only once the reply to the previous one has ended, so a recorded tool order
   * is the agent's and not the harness's. And it stops after a turn that ENDED
   * the session ({@link EvalTurn.endedSession}), so it hands back fewer turns
   * than lines when the agent hangs up early — a caller does not talk to a dead
   * line. Assert on {@link EvalSession.ended} when WHEN it hung up matters.
   */
  sayAll(lines: readonly string[]): Promise<readonly EvalTurn[]>;
  /** Every event this session has emitted, in stream order. */
  events(): readonly SessionEvent[];
  /**
   * Every committed reply so far, INCLUDING the greeting — the agent's opening
   * line is a real turn and is in the session's history, so it is in this list
   * too. Prefer the {@link EvalTurn} `say()` returns for a claim about one
   * reply.
   */
  said(): readonly string[];
  /** The tool calls so far, in call order, each with its result. */
  toolCalls(): readonly EvalToolCall[];
  close(): Promise<void>;
};

/**
 * What {@link openEvalSession} takes.
 *
 * The fields every way of running an agent shares are {@link HostAgentOptions};
 * what they mean HERE:
 *
 * - `providerEnv` defaults to {@link EvalSessionOptions.env} with any credential
 *   it does not carry filled in from this machine's own environment — the trust
 *   decision `aai dev` makes, and right here for the same reason: an eval runs
 *   on the developer's box against their own key. A value in `env` always wins.
 * - `runCode` backs the `run_code` builtin. Without one it permanently refuses,
 *   as it does off-platform. What that COSTS was measured on the three tutor
 *   templates: their headline feature was unevaluable, because the agent calls
 *   `run_code`, reads "only available in the sandboxed runtime", and then does
 *   the arithmetic in its head — so a case could assert the CALL and never the
 *   answer. An eval on a developer's own machine may supply an executor; a
 *   deployed agent still cannot.
 * - `fetch` keeps a case off the network — a scripted `visit_webpage` really
 *   visits.
 * - `toolTimeoutMs` defaults to the session's own 30s; a tool that outruns it
 *   otherwise measures the deadline instead of the agent.
 * - `workflows`: without one, a workflow-declaring agent gets the client the
 *   runtime builds over the real engine, and every `start()` through it throws —
 *   a body imported through a test runner was never through the compiler's
 *   transform. Build one with `openEvalWorkflows({ agent })` and pass its
 *   `client`; `describeEval` does that for you. The engine under it is not
 *   durable — no journal, no replay, no retry. See `eval/workflow-engine.ts`
 *   before writing a claim about a run.
 * - `logger` defaults to silent. Pass `consoleLogger` when diagnosing a case.
 */
export interface EvalSessionOptions extends HostAgentOptions {
  /**
   * The agent's own env, i.e. what its tools read as `ctx.env`. Defaults to
   * empty: a tool that needs a value gets it here, and nothing is inherited
   * implicitly.
   */
  readonly env?: Record<string, string>;
  /** Override the LLM the case runs on. Defaults to the agent's own. */
  readonly llm?: LlmProvider;
  readonly turnTimeoutMs?: number;
  /**
   * The client id this session's device connected with — what
   * `sessionClientId(ctx)` answers, and what `sessionContext` and
   * `onSessionEnd` receive as `clientId`.
   *
   * Recorded where a device's `?client=` is recorded, under the session id
   * before the session is built, so the runtime derives from it exactly what it
   * derives for a device: the session is BOUND to the client, and its prior
   * sessions (none, in a fresh eval runtime) are what the history restore
   * reads. Without it a speaker agent whose tools key reminders and calls by
   * client id refuses every one of them, and a case had to reach for the
   * runtime's own recorder on a non-authoring subpath to get past that.
   */
  readonly clientId?: string;
  /**
   * The phone number the client reported — what `sessionClientPhone(ctx)`
   * answers, and what the `text_me` builtin's `allowedSmsRecipient` check sees.
   *
   * Written the way a person writes it (`"+1 503 555 0100"`) and normalized to
   * E.164 by the same rule the socket's `?phone=` goes through. Where the socket
   * DROPS a number that is not E.164, this THROWS: a device's typo is a
   * stranger's input, and an eval's is the author's own, which a silent drop
   * would turn into a case measuring an agent with no number at all.
   */
  readonly phone?: string;
  /**
   * The placed phone call this session IS — what `sessionContext` and
   * `onSessionEnd` receive as `call`, and `sessionCall(ctx)` answers.
   *
   * The same record a carrier's `start` frame produces on `WS /phone`
   * (Twilio's `callSid` as `callId`, its `<Parameter>`s as `parameters`), put
   * through the same seam: recorded under the session id before the session is
   * built, and read by the runtime's own `sessionContext` step. So the hook's
   * `refuse`, `instructions` and `greeting` take effect exactly as they do for
   * a real call — a refusal lands on {@link EvalSession.refused}, an answered
   * greeting is the one the session opens with. A call is all the runtime
   * derives from the phone path above the audio boundary; the μ-law codec and
   * the carrier socket are below it, and an eval drives neither.
   */
  readonly call?: SessionCall;
}

/**
 * {@link EvalSessionOptions} plus the host-only `generate` seam.
 *
 * `generate` was a public field — what tool code calls as `ctx.generate` —
 * whose one caller is `describeEval`'s `stubGenerate`, in this package; the
 * reason it must be separate from the turn's script is in
 * `HostRuntimeOptions.generate`. Reached through
 * {@link openEvalSessionWithSeams} by a relative import, never re-exported.
 *
 * @internal
 */
export type HostEvalSessionOptions = EvalSessionOptions & {
  /** What tool code calls as `ctx.generate`. Absent, it is the agent's own LLM. */
  readonly generate?: HostGenerateFn;
};
