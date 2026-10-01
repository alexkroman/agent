// Copyright 2026 the AAI authors. MIT license.
/**
 * A session's `say` and `interrupt`: the host half of the SDK's
 * `SessionSpeech` (`sdk/session-speech.ts`, which argues what it is for).
 *
 * Two layers, because they answer to different lifetimes:
 *
 * - {@link createSpeechVerbs} is ONE `ServerSession`'s pair, built over that
 *   session's transport and its client-`cancel` path. `interrupt()` IS that
 *   path, so a cut from code and a cut from the client are one behaviour, down
 *   to the `reply.cancelled` it reports.
 * - {@link sessionSpeechFor} is what an author holds: resolved through the
 *   runtime's session map on EVERY call rather than bound to one session
 *   object, because a handler's `ctx.speech` outlives the socket it was built
 *   for (a timer it armed fires after a resume swapped the session in).
 *
 * Neither throws. The caller is an event handler, a timer or a webhook, with
 * nobody above it to raise to, so every "cannot" is an outcome on `done`.
 *
 * @module
 */

import type { SayOptions, SessionSpeech, SpeechHandle, SpeechOutcome } from "@alexkroman1/aai";
import type { SpokenLineOutcome, Transport } from "./transports/types.ts";

/** A handle whose line never reached the transport. */
function settledHandle(outcome: SpeechOutcome): SpeechHandle {
  return {
    done: Promise.resolve(outcome),
    interrupt: () => undefined,
  };
}

/** What {@link createSpeechVerbs} needs from the session around it. @internal */
export type SpeechVerbDeps = {
  transport: Transport;
  /** Has the session stopped? Read per call. */
  stopped: () => boolean;
  /** The client `cancel` command, exactly: abort tools, cancel, report. */
  cancel: () => void;
};

/** One session's `say`/`interrupt` pair. @internal */
export type SpeechVerbs = {
  say(text: string, options?: SayOptions): SpeechHandle;
  interrupt(): boolean;
};

/**
 * Build one session's pair — see this module's header.
 *
 * @internal
 */
export function createSpeechVerbs(deps: SpeechVerbDeps): SpeechVerbs {
  const { transport } = deps;

  function interrupt(): boolean {
    if (deps.stopped()) return false;
    // Without `replyState` (S2S) the answer is "cannot tell", which
    // interrupts: the client's cancel has always been sent blind there too.
    if (transport.capabilities.replyState && transport.isReplying?.() === false) return false;
    deps.cancel();
    return true;
  }

  function say(text: string, options: SayOptions = {}): SpeechHandle {
    const line = text.trim();
    // A transport without `say` was said at SESSION START, once, from its
    // capability row (`transports/capabilities.ts`) — not here per line.
    const speakLine = transport.capabilities.say ? transport.speakLine?.bind(transport) : undefined;
    if (deps.stopped() || line === "" || !speakLine) return settledHandle("dropped");
    // Cut BEFORE queueing, so the line is chained after the epoch bump that
    // strands the queue: it survives the interrupt it asked for.
    if (options.interrupt === true) interrupt();
    const takeBack = new AbortController();
    let phase: "queued" | "playing" | "settled" = "queued";
    const done = speakLine(line, {
      signal: takeBack.signal,
      onStart: () => {
        phase = "playing";
      },
      interruptible: options.interruptible !== false,
      record: options.record !== false,
    })
      // `speakLine` never rejects by contract; a transport that breaks it must
      // still not leave `done` to reject into a handler nobody awaits.
      .catch((): SpokenLineOutcome => "dropped")
      .then((outcome: SpeechOutcome) => {
        phase = "settled";
        return outcome;
      });
    return {
      done,
      interrupt(): void {
        if (phase === "queued") takeBack.abort();
        // Playing means this line IS the reply in flight, so the session's cut
        // is this line's cut.
        else if (phase === "playing") interrupt();
      },
    };
  }

  return { say, interrupt };
}

/**
 * The `SessionSpeech` an author holds for `sessionId`, resolved through
 * `lookup` on each call — see this module's header. A session that is gone
 * answers as a stopped one: `say` settles `"dropped"`, `interrupt` is `false`.
 *
 * @internal
 */
export function sessionSpeechFor(lookup: () => SpeechVerbs | undefined): SessionSpeech {
  return {
    say: (text, options) => lookup()?.say(text, options) ?? settledHandle("dropped"),
    interrupt: () => lookup()?.interrupt() ?? false,
  };
}

/**
 * Every session's speech, by id, over the runtime's session map — the one
 * object `runtime.ts` builds and hands to each surface that reaches a live
 * session from outside its turn:
 *
 * - `of(sid)` for a context bound to a session (a tool call, an event
 *   handler): always a `SessionSpeech`, answering as an ended session once it
 *   is gone.
 * - `live(sid)` for `RouteContext.speech`: `undefined` unless a session by that
 *   id is live at the moment of the call, so a webhook can tell "no such call"
 *   from "the line was dropped".
 * - `announce(sid, instruction)` for a run's `notify`: the MODEL-written
 *   unprompted turn (`ServerSession.announce`), `false` when no session by
 *   that id is live or its transport cannot take one.
 *
 * @internal
 */
export type SpeechDirectory = {
  of(sessionId: string): SessionSpeech;
  live(sessionId: string): SessionSpeech | undefined;
  announce(sessionId: string, instruction: string): boolean;
};

/** Build the {@link SpeechDirectory} over `sessions`. @internal */
export function speechDirectory(sessions: {
  get(id: string): (SpeechVerbs & { announce(instruction: string): boolean }) | undefined;
}): SpeechDirectory {
  const of = (sessionId: string) => sessionSpeechFor(() => sessions.get(sessionId));
  return {
    of,
    live: (sessionId) => (sessions.get(sessionId) === undefined ? undefined : of(sessionId)),
    announce: (sessionId, instruction) => sessions.get(sessionId)?.announce(instruction) ?? false,
  };
}
