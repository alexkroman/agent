// Copyright 2026 the AAI authors. MIT license.
/**
 * Agent-level guardrails, and the one thing that makes an OUTPUT guardrail real
 * rather than decorative: a hold on the funnel between the model and the
 * synthesizer.
 *
 * `sendTtsText` in `pipeline-transport.ts` is that funnel — every word the
 * agent says goes through it, the greeting and the recovery phrases included —
 * which is why a blocking output guardrail is possible in pipeline mode and in
 * neither other mode (`sdk/agent-guardrails.ts` argues both refusals).
 *
 * ## The hold, and what it costs
 *
 * Text normally reaches TTS as it streams, which is most of why a voice agent
 * feels responsive. A guardrail has to judge the reply WHOLE — half a sentence
 * is not a thing a check can decide about — so a session that declares one
 * holds every recordable send until the model has finished, then releases the
 * lot or drops it. That is a real cost, stated in
 * {@link AgentGuardrails.outputGuardrails}: time-to-first-word becomes
 * time-to-last-token.
 *
 * **Filler is exempt, and that is what keeps the cost bearable.** The dead-air
 * cover sends with `record: false`; it is a timing artifact rather than
 * dialogue, nothing judges it, and it is precisely what should be audible while
 * a reply is being held. So the caller hears "let me check on that" during the
 * hold, exactly as they do during a tool chain.
 *
 * ## What it does not prevent
 *
 * A guardrail that runs after the model has finished cannot stop the model
 * spending the tokens, and it cannot stop a TOOL the reply called from having
 * run. It stops the words. On a blocked turn the tool steps are dropped from
 * the model's history along with the blocked text, so a later turn may call
 * those tools again — the alternative is a history in which the agent silently
 * knows things it never said.
 */

import type { AgentGuardrail, AgentSessionContext } from "@alexkroman1/aai";
import { runAgentGuardrails } from "@alexkroman1/aai/host-internal";
import type { SendTtsOptions, SendTtsText } from "./types.ts";

/** A held-back send, kept whole so the release is byte-identical. @internal */
type HeldSend = { readonly text: string; readonly options: SendTtsOptions | undefined };

/**
 * The funnel, with a hold on it.
 *
 * A wrapper around `sendTtsText` rather than a flag inside it, because the
 * transport hands that one function to five collaborators (the stream handler,
 * the three turn outcomes, the lifecycle's greeting) and every one of them must
 * be held by the same latch. Wrapping is what makes "every word goes through
 * one place" true of the HOLD as well as of the send.
 *
 * @internal
 */
export interface SpeechGate {
  /** The `sendTtsText` every collaborator is given. */
  readonly send: SendTtsText;
  /**
   * Buffer recordable sends for the duration of `body`, and stop holding
   * however `body` ends.
   *
   * **A SCOPE rather than a `hold()`, because the release cannot be left to a
   * caller.** The hold is session-lifetime state on a gate every collaborator
   * shares, so a turn that threw between holding and deciding left the funnel
   * shut for the rest of the CALL: the next greeting after a `reset()`, and any
   * refusal spoken before the following turn re-holds, were buffered and never
   * heard, with `logTurnCrash` the only trace. A `try`/`finally` at the one call
   * site would have closed it; a shape where forgetting is not expressible
   * closes it for the next call site too.
   *
   * The body still chooses BETWEEN {@link release} and {@link discard} — that
   * is the guardrail's verdict and not something a scope can know. What the
   * scope decides is the case the body did not reach: anything still held when
   * it returns or throws is DROPPED, because a reply no output guardrail
   * judged is exactly what must not be spoken.
   */
  withHold<T>(body: () => Promise<T>): Promise<T>;
  /** Speak everything held, in order, and stop holding. */
  release(): void;
  /** Drop everything held unspoken, and stop holding. */
  discard(): void;
}

/**
 * Wrap a send so a turn can hold it.
 *
 * With `enabled: false` — every session that declares no output guardrail —
 * `withHold` runs its body against nothing and `send` is the underlying
 * function, so the shipped path is unchanged rather than merely equivalent.
 *
 * @internal
 */
export function createSpeechGate(enabled: boolean, send: SendTtsText): SpeechGate {
  if (!enabled) {
    const noop = (): void => undefined;
    return { send, withHold: (body) => body(), release: noop, discard: noop };
  }
  let held: HeldSend[] | undefined;
  const discard = (): void => {
    held = undefined;
  };
  return {
    send(text: string, options?: SendTtsOptions): void {
      // Filler passes straight through: it is not the agent's words, nothing
      // judges it, and it is what covers the silence the hold creates.
      if (held === undefined || options?.record === false) {
        send(text, options);
        return;
      }
      held.push({ text, options });
    },
    async withHold<T>(body: () => Promise<T>): Promise<T> {
      held = [];
      try {
        return await body();
      } finally {
        // Whatever the body decided has already run (`release` empties the
        // buffer, `discard` drops it), so this is a no-op on every ordinary
        // path. What it catches is the path with no decision at all — a throw
        // — where leaving the gate shut would mute the session.
        discard();
      }
    },
    release(): void {
      const pending = held ?? [];
      held = undefined;
      for (const item of pending) send(item.text, item.options);
    },
    discard,
  };
}

/** How a turn asks its guardrails about one piece of text. @internal */
export interface TurnGuardrails {
  /** Does this session hold speech back? False when it declares no output guardrail. */
  readonly holdsSpeech: boolean;
  /** The refusal for what the caller said, or `undefined` to proceed. */
  checkInput(text: string): Promise<string | undefined>;
  /** The refusal for what the agent is about to say, or `undefined` to speak it. */
  checkOutput(text: string): Promise<string | undefined>;
}

/** What a session's guardrails need from the runtime. @internal */
export interface TurnGuardrailDeps {
  inputGuardrails?: readonly AgentGuardrail[] | undefined;
  outputGuardrails?: readonly AgentGuardrail[] | undefined;
  /** The session a guardrail is judging for — see {@link AgentSessionContext}. */
  context: AgentSessionContext;
  /**
   * A guardrail THREW.
   *
   * Reported rather than swallowed, and non-fatally: the text goes through (a
   * check that cannot decide has not decided), and the one thing worse than a
   * guardrail that fails open is one that fails open in silence.
   */
  onError: (direction: "input" | "output", err: unknown) => void;
  /** A guardrail refused. The audit record — see the `guardrail.blocked` event. */
  onBlocked: (direction: "input" | "output", replacement: string) => void;
}

/**
 * The one refusal-free answer, allocated once.
 *
 * A fresh `Promise.resolve(undefined)` per check was a promise object per piece
 * of text on the path that decides time-to-first-word, for a value that is the
 * same every time and that nothing can mutate.
 */
const NO_REFUSAL: Promise<string | undefined> = Promise.resolve(undefined);

/** A session with no guardrails at all — the overwhelming majority. @internal */
export const NO_GUARDRAILS: TurnGuardrails = {
  holdsSpeech: false,
  checkInput: () => NO_REFUSAL,
  checkOutput: () => NO_REFUSAL,
};

/**
 * Bind a session's guardrails once.
 *
 * `holdsSpeech` is read at construction rather than per turn because it decides
 * how the transport's funnel is built, and a session cannot gain a guardrail
 * mid-call.
 *
 * **A session that declared none gets {@link NO_GUARDRAILS} itself**, and that
 * is what makes the fast path real rather than merely documented. The runtime
 * wires this for every session (`runtime-session-controls.ts`), so
 * `pipeline-transport.ts`'s `opts.guardrails ?? NO_GUARDRAILS` never once took
 * its right-hand arm: every turn of every agent awaited two nested async frames
 * on the time-to-first-word path to discover there was nothing to run. Deciding
 * HERE is the only place that can, since this is where the lists are seen — and
 * `onError`/`onBlocked` are dropped with the rest, which is sound because
 * neither can fire when no guardrail runs.
 *
 * @internal
 */
export function createTurnGuardrails(deps: TurnGuardrailDeps): TurnGuardrails {
  const holdsSpeech = (deps.outputGuardrails?.length ?? 0) > 0;
  const checksInput = (deps.inputGuardrails?.length ?? 0) > 0;
  if (!(holdsSpeech || checksInput)) return NO_GUARDRAILS;
  const check = async (
    direction: "input" | "output",
    list: readonly AgentGuardrail[] | undefined,
    text: string,
  ): Promise<string | undefined> => {
    const refusal = await runAgentGuardrails(list, text, deps.context, (err) =>
      deps.onError(direction, err),
    );
    if (refusal !== undefined) deps.onBlocked(direction, refusal);
    return refusal;
  };
  return {
    holdsSpeech,
    checkInput: (text) => check("input", deps.inputGuardrails, text),
    checkOutput: (text) => check("output", deps.outputGuardrails, text),
  };
}
