// Copyright 2026 the AAI authors. MIT license.
/**
 * The pipeline transport's SESSION lifecycle — everything that happens once
 * per call rather than once per turn: opening the providers, the greeting,
 * the two unrecoverable provider failures, and both ways a session ends.
 *
 * Split from pipeline-transport.ts, which keeps turn orchestration. The line
 * between them is the one the rest of that file is organized around: a turn
 * can fail without ending the session (see "A failing TURN is not a failing
 * SESSION" in `packages/aai/CLAUDE.md`), and every path in HERE is the other kind.
 * Keeping them apart is what stops a turn-level fix reaching for `terminate`.
 *
 * ## The phase is a statechart, and "stopped" is spelled once
 *
 * What was here was the shape `../../session/ws-lifecycle.ts` was written to
 * remove: an `audioReady` latch, a NULLABLE `startPromise` standing in for
 * "opening", a `beforeAudio` queue drained in one handler and dropped in
 * another, and "stopped" spelled two ways — the transport's `terminated` flag
 * and `sessionAbort.signal.aborted` — with readers choosing between them (and
 * one, the silence nudger's gate, reading both). Now:
 *
 * - `idle` → `opening` (invokes `providers.open()`) → `ready` | `failing`
 *   (speaks the start failure) → `terminated`. `STOP` and `PROVIDER_ERROR`
 *   reach `terminated` from anywhere before it.
 * - **"Audio can flow" is a SUBSTATE**, `opening.audible`: TTS is adopted the
 *   moment it lands, before `open()` settles, so the greeting starts without
 *   waiting on STT. Arriving there (or at `ready` from `opening.muted`) runs
 *   the greeting and drains the held lines; ENTERING `terminated` drops them.
 * - **The nudger is armed by entering `ready`.** It used to be armed after
 *   `await startPromise`, safe only because the nudger re-checked `isActive()`
 *   for a stop that landed mid-open. A stop now LEAVES `opening`, which stops
 *   the invoked open, so its completion is never delivered at all.
 * - **`isTerminated()` is the machine** — the transport's every reader, and
 *   the turn chain's, the commands', the STT handlers' and the nudger's,
 *   reach it through the getter this module hands back.
 * - **`failing` is not audible**: a `say` asked for while the start failure is
 *   spoken is held and then dropped, and `greet()` is inert, so the failure
 *   phrase is the sole speaker.
 * - **`start()` resolves on the tick the open does** (see its body): a caller
 *   reads the session from that moment, and a fast greeting can finish in the
 *   ticks a `waitFor` would add.
 *
 * The session `AbortSignal` stays, because providers, drains and speculation
 * genuinely need a signal. It is aborted by the teardown that follows the
 * transition into `terminated` and by nothing else, so `aborted` implies
 * `isTerminated()`; the converse fails only inside that synchronous teardown.
 *
 * ## Why the teardown runs AFTER the send, not as an entry action
 *
 * XState runs a transition's actions before it commits the next snapshot, so
 * an entry action of `terminated` reads `isTerminated()` as FALSE. The
 * teardown aborts the turn in flight, reports `reply.cancelled` and aborts the
 * session signal, and every one of those runs listeners that consult it — the
 * flag this replaced was latched FIRST for exactly that reason. So the facade
 * sends, then tears down (`end`), the way `turn/state.ts` aborts its turn
 * around the send. The machine's own entry action is only the one that reads
 * nothing: dropping held lines. The same lag is why `becomeAudible` queues the
 * greeting unguarded rather than through `greet()`.
 */

import { createActor, fromPromise, setup, stateIn, waitFor } from "xstate";
import type { Logger } from "../../logger.ts";
import type { SttError, TtsError } from "../../providers/openers.ts";
import {
  type EmitError,
  type GreetingOption,
  resolveGreeting,
  type SendTtsText,
  type SkipGreetingOption,
  type SpokenLine,
  type SpokenLineOutcome,
  shouldSkipGreeting,
  type TransportCallbacks,
} from "../types.ts";
import type { HeardTracker } from "./heard/index.ts";
import type { PipelineHistory } from "./history/index.ts";
import type { PipelineProviderSessions } from "./providers.ts";
import { createLineReply, type LineReplyDeps } from "./reply/index.ts";
import type { SpeculationController, UserActivity } from "./speech/index.ts";
import type { TurnChain, TurnGate, TurnMachine } from "./turn/index.ts";
import type { TurnOutcome } from "./turn-outcome.ts";

/** Where one pipeline session is — see this module's doc. */
export type PipelinePhase = "idle" | "opening" | "ready" | "failing" | "terminated";

/**
 * The lifecycle's side of the machine: everything the phase decides to do but
 * does not know how to.
 */
export type PipelinePhaseEffects = {
  /**
   * Open the provider pair. Invoked on entry to `opening` and STOPPED by
   * leaving it — which does not cancel the open underneath; the session
   * signal does that, and `stop()` awaits the open itself.
   */
  open(): Promise<"ok" | "failed">;
  /** Audio can flow: greet (unless resuming) and queue the held lines. */
  becomeAudible(): void;
  /** Start the silence countdown. The entry action of `ready`. */
  armNudger(): void;
  /**
   * Silence the greeting and speak the start failure. Invoked on entry to
   * `failing`; the effect ends by sending `FAILURE_SPOKEN`, through the
   * teardown — see "Why the teardown runs AFTER the send".
   */
  speakStartFailure(): Promise<void>;
  /** Resolve every held line `"dropped"`. The entry action of `terminated`. */
  dropHeld(): void;
};

/** Everything that happens to one pipeline session. */
export type PipelinePhaseEvent =
  /** The transport's `start()`. */
  | { type: "START" }
  /** TTS was adopted: there is something to speak into. */
  | { type: "AUDIO_READY" }
  /** The client disconnected — the transport's `stop()`. */
  | { type: "STOP" }
  /** STT or TTS failed mid-session; unrecoverable. */
  | { type: "PROVIDER_ERROR" }
  /** A failed start has said so, and the session is over. */
  | { type: "FAILURE_SPOKEN" };

/** The three events that end a session — the facade's `end` takes only these. */
type EndEvent = Extract<PipelinePhaseEvent, { type: "STOP" | "PROVIDER_ERROR" | "FAILURE_SPOKEN" }>;

const pipelinePhaseMachine = setup({
  types: {} as {
    context: { effects: PipelinePhaseEffects };
    input: PipelinePhaseEffects;
    events: PipelinePhaseEvent;
  },
  actors: {
    // The open's own promise, unwrapped: an `async` wrapper here would add a
    // tick between the open settling and `ready`, and `start()` relies on the
    // machine having arrived by the time its own `await` on the same promise
    // resumes.
    openProviders: fromPromise(({ input }: { input: PipelinePhaseEffects }) => input.open()),
    speakStartFailure: fromPromise(({ input }: { input: PipelinePhaseEffects }) =>
      input.speakStartFailure(),
    ),
  },
  guards: {
    /**
     * Did a side fail to open? Read off the done event's output, which the
     * machine-wide event union does not describe — hence the narrowing.
     */
    openFailed: ({ event }) => (event as { output?: unknown }).output === "failed",
    /** Did both sides open without TTS announcing itself first? */
    stillMuted: stateIn({ opening: "muted" }),
  },
  actions: {
    becomeAudible: ({ context }) => context.effects.becomeAudible(),
    armNudger: ({ context }) => context.effects.armNudger(),
    dropHeld: ({ context }) => context.effects.dropHeld(),
  },
}).createMachine({
  id: "pipelineLifecycle",
  context: ({ input }) => ({ effects: input }),
  initial: "idle",
  states: {
    /** Constructed; `start()` has not been called. */
    idle: {
      on: { START: "opening", STOP: "terminated", PROVIDER_ERROR: "terminated" },
    },
    /** `providers.open()` is in flight. */
    opening: {
      initial: "muted",
      invoke: {
        src: "openProviders",
        input: ({ context }) => context.effects,
        onDone: [
          // The greeting may already be running — `failing` silences it.
          { guard: "openFailed", target: "failing" },
          // TTS never announced itself before `open()` settled: audio can flow
          // now, so greet on the way in.
          { guard: "stillMuted", target: "ready", actions: "becomeAudible" },
          { target: "ready" },
        ],
        // `open()` reports a failed side as "failed" rather than rejecting, so a
        // rejection is a bug in it; it lands where any failed start does.
        onError: { target: "failing" },
      },
      on: { STOP: "terminated", PROVIDER_ERROR: "terminated" },
      states: {
        /** Nothing to speak into yet: lines are held, the greeting waits. */
        muted: { on: { AUDIO_READY: { target: "audible", actions: "becomeAudible" } } },
        /** TTS is live (STT may still be connecting). */
        audible: {},
      },
    },
    /** A live session. */
    ready: {
      // Covers the no-greeting case; a greeting in flight defers the nudge.
      entry: "armNudger",
      on: { STOP: "terminated", PROVIDER_ERROR: "terminated" },
    },
    /**
     * One side failed to open. The failure is SPOKEN (while TTS may still be
     * live) before the session ends; nothing else may speak meanwhile, so a
     * line asked for here is held and then dropped, and `greet()` is inert.
     */
    failing: {
      invoke: { src: "speakStartFailure", input: ({ context }) => context.effects },
      on: { FAILURE_SPOKEN: "terminated", STOP: "terminated", PROVIDER_ERROR: "terminated" },
    },
    /**
     * Over, however it got here. Held lines are dropped by ARRIVING — one place
     * for every way a session can end. Not `type: "final"`, for the reason
     * `ws-lifecycle.ts`'s `ended` gives: a send to a stopped actor warns.
     */
    terminated: { entry: "dropHeld" },
  },
});

/** The lifecycle's handle on its own phase. */
export interface PipelinePhaseHandle {
  phase(): PipelinePhase;
  /** May audio flow — `opening.audible` or `ready`? */
  audible(): boolean;
  isTerminated(): boolean;
  send(event: PipelinePhaseEvent): void;
  /** Resolves once the session is `ready` or `terminated`. */
  settled(): Promise<void>;
}

/** Create the phase machine for one pipeline session. */
export function createPipelinePhase(effects: PipelinePhaseEffects): PipelinePhaseHandle {
  const actor = createActor(pipelinePhaseMachine, { input: effects }).start();
  const phase = (): PipelinePhase => {
    const at = actor.getSnapshot();
    if (at.matches("idle")) return "idle";
    if (at.matches("opening")) return "opening";
    if (at.matches("ready")) return "ready";
    if (at.matches("failing")) return "failing";
    return "terminated";
  };
  return {
    phase,
    audible: () => {
      const at = actor.getSnapshot();
      return at.matches("ready") || at.matches({ opening: "audible" });
    },
    isTerminated: () => actor.getSnapshot().matches("terminated"),
    send: (event) => actor.send(event),
    settled: async () => {
      await waitFor(actor, (at) => at.matches("ready") || at.matches("terminated"));
    },
  };
}

/** What {@link createPipelineLifecycle} hands back to the transport. */
export interface PipelineLifecycle {
  /** Open the providers, then greet — the transport's `start`. */
  start(): Promise<void>;
  /** Client disconnect — the transport's `stop`. */
  stop(): Promise<void>;
  /** Either provider failing is unrecoverable: surface it and tear down. */
  onProviderError(kind: "stt" | "tts", err: SttError | TtsError): void;
  /**
   * TTS has been adopted, so audio can flow: fire the greeting turn (once).
   * Wired into the provider sessions, which is why this is public.
   */
  onAudioReady(): void;
  /**
   * Queue the greeting turn. Called at session start via
   * {@link PipelineLifecycle.onAudioReady} and again by the transport's
   * `reset()` — a client `reset` discards the conversation, and a conversation
   * that starts without its opening line is not the one the agent declares.
   *
   * No-op with no greeting configured, before TTS is adopted (there is nothing
   * to speak into yet — the start path greets as soon as it is), or after
   * teardown.
   */
  greet(): void;
  /** Queue one verbatim line as a reply of its own — see `Transport.speakLine`. */
  speakLine(text: string, line: SpokenLine): Promise<SpokenLineOutcome>;
  /**
   * Has {@link PipelineLifecycle.onAudioReady} fired (and the session not
   * ended)? The transport gates inbound audio on it — STT is not open before
   * that, so forwarding frames would write into a session that does not exist
   * yet.
   */
  audioReady(): boolean;
  /**
   * Has the session ended — stopped, or torn down by a provider failure? The
   * ONE spelling of "stopped": every collaborator's injected `isTerminated`
   * reads this.
   */
  isTerminated(): boolean;
  /** `!isTerminated()` — what the nudger and the recovery latch gate on. */
  isActive(): boolean;
}

export interface PipelineLifecycleDeps {
  sid: string;
  log: Logger;
  callbacks: TransportCallbacks;
  emitError: EmitError;
  /** Session-lifetime abort — combined into every turn's own signal. */
  sessionAbort: AbortController;
  /** Resolved in `greet()`, so a session's own greeting is read when it fires. */
  greeting: GreetingOption | undefined;
  skipGreeting: SkipGreetingOption | undefined;

  gate: TurnGate;
  turns: TurnMachine;
  turnChain: TurnChain;
  history: PipelineHistory;
  outcome: TurnOutcome;
  speculation: Pick<SpeculationController, "discard">;
  nudger: UserActivity["nudger"];
  recovery: UserActivity["recovery"];
  speechEdges: UserActivity["speechEdges"];
  /**
   * The provider pair. A getter, not the value: the sessions are constructed
   * with `onAudioReady`/`onProviderError` from THIS module, so one of the two
   * has to reach the other lazily.
   */
  providers: () => PipelineProviderSessions;

  /**
   * The first step of every teardown, run once the machine reads `terminated`
   * — the transport's own session-scoped cleanup (a pending TTS flush timer).
   */
  onTerminated: () => void;
  abortInFlightTurn: () => void;
  /** What the greeting's line reply reads — see `createLineReply`. */
  heard: HeardTracker;
  sendTtsText: SendTtsText;
  drainTts: (signal: AbortSignal) => Promise<void>;
  runReply: LineReplyDeps["runReply"];
  /** A `say` with `interruptible: false` — see `PipelineDialogKnobs.holdFloor`. */
  holdFloor: (held: boolean) => void;
  /** Turn-crash handler for `turnChain.chain` call sites — see turnCrashLogger. */
  logTurnCrash: (label: string) => (err: unknown) => void;
}

export function createPipelineLifecycle(deps: PipelineLifecycleDeps): PipelineLifecycle {
  const {
    sid,
    log,
    callbacks,
    emitError,
    sessionAbort,
    gate,
    turns,
    turnChain,
    history,
    outcome,
    speculation,
    nudger,
    recovery,
    speechEdges,
    abortInFlightTurn,
    logTurnCrash,
  } = deps;
  // The greeting is a FIXED line spoken as a reply of its own, so its caption
  // and history rules are `reply/lines.ts`'s, shared with the two failure
  // phrases rather than spelled a third time here.
  const lineReply = createLineReply({ ...deps, callbacks, history, gate, turns });

  // Lines `speakLine` was asked for before TTS was adopted: nothing can play
  // yet, so each waits here and is queued on becoming audible, after the
  // greeting, exactly as the greeting itself waits. Entering `terminated`
  // drops them.
  const beforeAudio: { queue: () => void; drop: () => void }[] = [];
  // The open the machine invoked, which leaving `opening` does NOT cancel.
  // stop() awaits it so a disconnect mid-connect tears the just-opened provider
  // sockets down deterministically instead of leaving fire-and-forget opens to
  // pile up. Already settled when no open was started.
  let opened: Promise<"ok" | "failed"> = Promise.resolve("ok");

  function queueGreeting(): void {
    const greeting = resolveGreeting(deps.greeting);
    if (!greeting) return;
    turnChain.chain(() => runGreeting(greeting).catch(logTurnCrash("Pipeline greeting failed")));
  }

  const machine = createPipelinePhase({
    open: () => {
      opened = deps.providers().open();
      return opened;
    },
    becomeAudible: () => {
      // `skipGreeting` is a RESUME flag and scoped to this connection's START:
      // a reconnect rejoins a conversation already in progress, so re-greeting
      // there would repeat a line the caller has heard. It deliberately does
      // not reach `greet()`, because a later `reset()` is the opposite case —
      // the conversation is discarded and the next one begins.
      //
      // RESOLVED here rather than read as a boolean, and this call site is why
      // the field may be a thunk: by now the resume's lookups have run, so "the
      // caller presented an id" has become "the id named something". A resume
      // that found nothing greets — see `host/session-resume-found.ts`.
      if (!shouldSkipGreeting(deps.skipGreeting)) queueGreeting();
      // Behind the greeting, in the order they were asked for.
      for (const held of beforeAudio.splice(0)) held.queue();
    },
    armNudger: () => nudger.arm(),
    speakStartFailure: async () => {
      // The greeting turn may already be running (TTS is adopted, and the
      // greeting fired, before open() settles). Silence it — strand the queued
      // copy and abort a running one — so the failure phrase is the sole
      // speaker instead of interleaving with the greeting and racing its TTS
      // drain.
      gate.invalidateQueued();
      abortInFlightTurn();
      // Say something first, while the socket is still up and TTS may still be
      // live — see speakStartFailure. The teardown then emits `cancelled` and
      // aborts the session; a failed start never reaches `ready`, which would
      // hand the runtime a "started" session that is actually dead, holding it
      // open until the idle timeout.
      try {
        await outcome.speakStartFailure();
      } finally {
        terminate({ type: "FAILURE_SPOKEN" });
      }
    },
    dropHeld: () => {
      for (const held of beforeAudio.splice(0)) held.drop();
    },
  });
  const isTerminated = machine.isTerminated;

  /**
   * Move the machine to `terminated` and run what both teardown paths share;
   * false when the session had already ended. See "Why the teardown runs AFTER
   * the send" for the order.
   *
   * The provider unsubscribe belongs HERE and not only in `stop()`. A
   * terminate left every STT/TTS listener attached and rested on four separate
   * guards downstream (the audio gate, `isTerminated` in the STT handlers, the
   * aborted session signal, the `isTerminated` check in `onProviderError`) to
   * make sure nothing acted on what still arrived — four things that each have
   * to keep being true, in a teardown whose whole job is that nothing further
   * happens.
   */
  function end(event: EndEvent): boolean {
    if (isTerminated()) return false;
    machine.send(event);
    deps.onTerminated();
    gate.invalidateAll();
    nudger.clear();
    recovery.clear();
    speechEdges.reset();
    speculation.discard("reset");
    deps.providers().unsubscribe();
    return true;
  }

  // Idempotent teardown after an unrecoverable provider error or failed start.
  function terminate(event: Extract<EndEvent, { type: "PROVIDER_ERROR" | "FAILURE_SPOKEN" }>) {
    if (!end(event)) return;
    abortInFlightTurn();
    callbacks.report({ type: "reply.cancelled" });
    sessionAbort.abort();
    // Close whatever was adopted before the failure (e.g. TTS went live,
    // then STT's open failed) — it must not outlive the terminate.
    deps
      .providers()
      .close()
      .catch(() => {
        // Best-effort teardown; a failed close is not actionable here.
      });
  }

  function onProviderError(kind: "stt" | "tts", err: SttError | TtsError): void {
    if (isTerminated()) return;
    log.error(`${kind.toUpperCase()} error`, {
      code: err.code,
      message: err.message,
      sid,
    });
    emitError(kind, err.message);
    terminate({ type: "PROVIDER_ERROR" });
  }

  async function runGreeting(text: string): Promise<void> {
    await lineReply("pipeline-greeting", text);
  }

  function speakLine(text: string, line: SpokenLine): Promise<SpokenLineOutcome> {
    if (isTerminated()) return Promise.resolve("dropped");
    // The greeting's path exactly, queued on the same chain: it waits behind a
    // reply in flight, and an interrupt that strands the queue strands it too.
    // A line taken back while queued is skipped when its turn comes, and
    // `onStranded` answers for one the session moved past. The epoch is read
    // HERE, not when the line reaches the chain, so an interrupt that lands
    // while it is still held for audio drops it as well.
    const askedAt = gate.queueEpoch();
    return new Promise((resolve) => {
      const drop = (): void => resolve("dropped");
      const queue = (): void =>
        turnChain.chain(async () => {
          if (line.signal.aborted || !gate.queueCurrent(askedAt)) {
            drop();
            return;
          }
          // Held for exactly this line: from before it takes the floor until it
          // settles, played or cut, so a caller is never left unable to barge in.
          const holds = !line.interruptible;
          if (holds) deps.holdFloor(true);
          const result = await lineReply("pipeline-say", text, {
            onStart: line.onStart,
            record: line.record,
          })
            .catch((err: unknown): SpokenLineOutcome => {
              logTurnCrash("Pipeline say failed")(err);
              return "interrupted";
            })
            .finally(() => {
              if (holds) deps.holdFloor(false);
            });
          resolve(result);
        }, drop);
      if (machine.audible()) queue();
      else beforeAudio.push({ queue, drop });
    });
  }

  return {
    onProviderError,
    onAudioReady: () => machine.send({ type: "AUDIO_READY" }),
    greet(): void {
      if (machine.audible()) queueGreeting();
    },
    speakLine,
    audioReady: machine.audible,
    isTerminated,
    isActive: () => !isTerminated(),

    async start(): Promise<void> {
      // STT and TTS open concurrently; a failed side (with the session still
      // live) speaks the failure and tears the whole transport down.
      machine.send({ type: "START" });
      // Awaited DIRECTLY, not through `settled()`: a successful start resolves
      // on the same tick the open does, as it always has. A runtime reads what
      // the session did from the moment start() resolves — the eval harness
      // anchors the greeting there — and every extra hop is a tick in which a
      // fast greeting can finish before anyone is looking. The machine's own
      // handler on the open was attached first, so `ready` is already entered.
      try {
        await opened;
      } catch {
        // Routed to `failing` by the machine.
      }
      // A failed start resolves once the failure has been spoken and the
      // session torn down.
      if (machine.phase() === "opening" || machine.phase() === "failing") {
        await machine.settled();
      }
    },

    async stop(): Promise<void> {
      // Gate late inbound work (sendUserAudio into a closing STT session)
      // the same way a provider-error teardown does.
      if (!end({ type: "STOP" })) return;
      sessionAbort.abort();
      turns.abortCurrent();
      // Let an in-flight open settle after the abort so any provider that
      // opened mid-connect is adopted-then-closed (openSide) before we close
      // below — otherwise a slow socket lands after stop() and lingers.
      await opened.catch(() => undefined);
      await turnChain.settled();
      await deps.providers().close();
    },
  };
}
