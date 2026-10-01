// Copyright 2026 the AAI authors. MIT license.
/**
 * `say` and `interrupt` — putting words on a live call from code that is not
 * the model's turn.
 *
 * Everything else the SDK speaks is SCOPED: the greeting opens a session, a
 * tool's `messages` cover that call, `silencePrompt` covers a quiet caller,
 * filler covers dead air, and `workflow start(…, { notify })` has the MODEL
 * write a sentence when a run lands. None of them lets arbitrary code (an
 * `events` handler, a timer it armed, a webhook route, a dialog deadline's
 * transition) put an exact sentence on the line when it decides to, stop the
 * agent mid-reply, or wait until one utterance has actually played. This is
 * that primitive, the one LiveKit and Pipecat call `say`.
 *
 * ## What a `say` is
 *
 * **A reply of its own, spoken VERBATIM** — no model call. It goes through the
 * same path the pipeline greeting does, so it follows the same three rules:
 *
 * - **Queued, never talked over.** It waits behind a reply in flight, unless
 *   `interrupt: true` cuts that reply off first.
 * - **Interruptible**, unless `interruptible: false`. A caller who barges in
 *   cuts it like any reply.
 * - **History records what was HEARD**, unless `record: false`. Played out,
 *   the whole line enters the conversation as an assistant turn. Cut off, only
 *   the heard prefix enters, tagged `[interrupted]`. The model therefore knows
 *   what it "said".
 *
 * On the session event stream a `say` is an ordinary reply (`reply.started`,
 * `agent-transcript.committed`, `reply.completed` or `reply.cancelled`), so
 * a reader of the log sees it as clearly as a model turn.
 *
 * ## A handler that speaks can hear itself
 *
 * **A `say` emits events, and those events reach your `events` handlers.** A
 * handler that answers every `agent-transcript.committed` with a `say` answers
 * its own line too, and the call never ends:
 *
 * ```ts
 * import { agent } from "@alexkroman1/aai";
 *
 * export default agent({
 *   name: "Never stops",
 *   events: {
 *     // LOOPS: the line this says is itself an agent-transcript.committed.
 *     "agent-transcript.committed": (_event, ctx) => {
 *       ctx.speech.say("Anything else?");
 *     },
 *   },
 * });
 * ```
 *
 * The emitter's re-entry guard does not catch it, because the line is spoken
 * after the handler has returned. So a handler that speaks must decide from
 * what TRIGGERED it: an event its own line cannot produce (`tool.called`,
 * `user-transcript.committed`, `session.timed-out`), or a check of the event
 * (its `text`, a slot the handler set) that its own line cannot pass. LiveKit's
 * `session.say` and Pipecat's `TTSSpeakFrame` share this property, and neither
 * guards it either.
 *
 * ## Where it does not work
 *
 * **Pipeline mode only.** Neither S2S service can speak host-supplied text
 * verbatim: AssemblyAI's builds every reply from its own session, and OpenAI
 * Realtime's `response.create` only takes an instruction the model may
 * paraphrase. The runtime says so ONCE, when an S2S session starts, and every
 * `say` there settles `"dropped"` at once rather than throwing, for the reason
 * `notify` is a no-op there: the caller is often background code with nobody
 * to raise to. `interrupt()` works in every mode.
 *
 * @module
 */

/**
 * How one {@link SessionSpeech.say} ended.
 *
 * - `"played"`: synthesized and played out to the end, so the caller heard it.
 * - `"interrupted"`: it started and was cut off: a barge-in, an
 *   `interrupt()`, or the session ending mid-line. History holds the heard
 *   prefix.
 * - `"dropped"`: it never started. The session ended, the line was empty, an
 *   interrupt stranded it in the queue (an interrupt, from the client or from
 *   code, discards EVERY queued reply, queued `say`s included), or the
 *   session's transport cannot speak verbatim text — an S2S agent, said once
 *   at session start. See this module's header.
 *
 * @public
 */
export type SpeechOutcome = "played" | "interrupted" | "dropped";

/**
 * Options for {@link SessionSpeech.say}.
 *
 * @public
 */
export type SayOptions = {
  /**
   * Cut off whatever the agent is saying (and drop whatever is queued) and
   * speak this next, rather than waiting its turn. The cut is exactly
   * {@link SessionSpeech.interrupt}'s. Default `false`.
   */
  interrupt?: boolean | undefined;
  /**
   * `false` to keep the CALLER from cutting this line off: their speech while
   * it plays is held back as if a dialog state had declared `bargeIn: "off"`,
   * and answered once the line is over. For a sentence that must be heard
   * whole, such as a disclosure or a final goodbye.
   *
   * Code can still cut it: {@link SessionSpeech.interrupt}, the handle's own
   * `interrupt()`, and the client's `cancel()` all work as usual, as does a
   * typed turn. Default `true`.
   */
  interruptible?: boolean | undefined;
  /**
   * `false` to keep this line out of the conversation: it is spoken and
   * captioned (its `agent-transcript.committed` carries `recorded: false`),
   * but it enters neither the model's history nor `ctx.messages`, and a
   * resumed session does not remember it. For a line the model should not
   * treat as something it said, such as a hold message ("one moment while I
   * check"). Default `true`.
   */
  record?: boolean | undefined;
};

/**
 * One utterance {@link SessionSpeech.say} queued: await `done` for when the
 * caller finished hearing it, or `interrupt()` to take it back.
 *
 * @sealed
 * @public
 */
export interface SpeechHandle {
  /**
   * Settles when the line is over, never rejects. `"played"` resolves once
   * PLAYBACK ends, estimated from the audio sent and corrected by the client's
   * playback reports, not merely once synthesis ends (which runs faster than
   * real time).
   *
   * **Do not await it inside the reply it would follow.** A `say` queues
   * behind the reply in flight, so a caller that holds that reply open while
   * waiting for `done` waits forever.
   */
  readonly done: Promise<SpeechOutcome>;
  /**
   * Take this line back: still queued, it is dropped (`done` settles
   * `"dropped"`); already playing, the reply is cut exactly as
   * {@link SessionSpeech.interrupt} cuts one (`"interrupted"`). A no-op once
   * `done` has settled.
   */
  interrupt(): void;
}

/**
 * A live session's speech: say a sentence on the line, or stop the agent.
 *
 * Reached as `ctx.speech` in an `agent({ events })` handler, and as
 * `ctx.speech(sessionId)` in an `agent({ routes })` handler. It stays usable
 * after the handler returns, so a timer the handler arms can speak through it.
 * It follows a session across a resume, and speaking through it after the
 * session has ended settles `"dropped"` rather than throwing.
 *
 * @example
 * ```ts
 * import { agent } from "@alexkroman1/aai";
 *
 * export default agent({
 *   name: "Kitchen timer",
 *   events: {
 *     "tool.called": (event, ctx) => {
 *       if (event.toolName !== "start_timer") return;
 *       setTimeout(async () => {
 *         const outcome = await ctx.speech.say("Your timer is done.", { interrupt: true }).done;
 *         if (outcome !== "played") console.log(`Timer line ${outcome}`);
 *       }, 60_000);
 *     },
 *   },
 * });
 * ```
 *
 * @sealed
 * @public
 */
export interface SessionSpeech {
  /**
   * Speak `text` exactly as written, as a reply of its own. See this module's
   * header for how it queues, how it is cut, and what history records.
   *
   * Never throws: an ended session, blank text and an S2S transport are
   * reported through `done`.
   */
  say(text: string, options?: SayOptions): SpeechHandle;
  /**
   * Stop the agent: cut off the reply in flight or still playing, abort its
   * tools, and drop every reply queued behind it, exactly as the client's
   * `cancel()` does. It emits `reply.cancelled`.
   *
   * Returns `false` when there was nothing to interrupt (the agent is silent,
   * or the session has ended) and emits nothing then. S2S transports cannot
   * tell whether they are replying, so there it always interrupts and returns
   * `true` while the session is live.
   */
  interrupt(): boolean;
}
