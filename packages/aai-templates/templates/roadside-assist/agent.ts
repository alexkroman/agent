import { agent } from "@alexkroman1/aai";
import { DIALOGS } from "./call.ts";

/**
 * A roadside-assistance line: find the caller, price the call, read them the
 * fee, send a truck.
 *
 * It exists to be the worked example of a `dialog()` describing a CALL rather
 * than a form. Every other flow template gates tools and moves on tool results;
 * this one also needs the things that only happen when no tool is running — a
 * caller who has gone quiet, a phase that must not be interrupted, a
 * verification step that has to give up on its own — and all of those arrive
 * through the one field below.
 *
 * Read `call.ts` first: it is the whole template. `shared.ts` is the rate card,
 * the fleet and the session slot, and it is deliberately boring.
 */
export default agent({
  name: "Roadside Assist",

  // No provider spread: pipeline mode is the default and every stage is filled
  // from the all-AssemblyAI pipeline at parse time.

  /**
   * **This is what wires the dialog to the session, and it is not a
   * formality.** Without this line `roadsideCall` still gates its tools and
   * still moves on `send` — and none of the five things this template is about
   * would happen: `@session.timed-out` and `@user-transcript.committed` would
   * reach nothing, the two `timeout` deadlines would never be armed, the active
   * state's `instruction` would reach the model only on turns that happened to
   * call a tool, and `bargeIn`, `toolChoice` and `temperature` would be
   * declarations nothing read.
   *
   * The three knobs are a PIPELINE property. On either speech-to-speech
   * transport the service owns turn-taking and assembles its own requests, so
   * the runtime warns rather than pretending; the instruction, the deadlines
   * and the session events work on every transport.
   */
  dialogs: DIALOGS,

  // No `syncState` and no `client.tsx`: what a caller of this line can see is
  // the phone. The state worth rendering would be the POSITION rather than the
  // slot, and `roadsideCall.projection((at) => at)` is how a custom chrome
  // would take it — see `dispatch-center` for a template that does.

  greeting:
    "Roadside assistance, you've reached the dispatch desk. First things first — are you " +
    "somewhere safe, out of traffic? And whereabouts are you?",
});
