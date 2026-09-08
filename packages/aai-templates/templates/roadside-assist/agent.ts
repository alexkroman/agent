import type { TelephonyAccess } from "@alexkroman1/aai";
import { agent } from "@alexkroman1/aai";
import { DIALOGS } from "./call.ts";
import { DESK_EVENTS } from "./events.ts";

/**
 * Who may put a call on this agent.
 *
 * **This is the one template where declaring it is not a detail**: a roadside
 * desk is reached by a stranded person on a phone, not by a browser tab, and
 * `WS /phone` is not served at all unless an agent asks for it. `true` would
 * admit every carrier the runtime ships a codec for; the list is the honest
 * shape for a desk whose numbers are with known carriers, and it is an
 * ALLOW-LIST — adding a third carrier's number without adding it here is a
 * refused upgrade rather than a call that half works.
 *
 * Typed {@link TelephonyAccess} because the field takes a boolean OR a list and
 * the annotation is what says which of the two this is. What it is NOT is a
 * claim about credentials: a carrier does not sign the WebSocket upgrade, and
 * its webhook signature is checked where the webhook lands.
 */
const PHONE_LINE: TelephonyAccess = ["twilio", "telnyx"];

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
 * the fleet and the session slot, and it is deliberately boring. Two smaller
 * files carry what is NOT a fact about one call: `yard.ts` is the depot's own
 * board, which every session shares and which a keyed lock is what keeps
 * honest, and `events.ts` is the desk's log of the two outcomes no tool sees.
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

  telephony: PHONE_LINE,

  /**
   * The desk's own record of what happened, for the two outcomes no tool sees.
   *
   * The pairing with `dialogs` above is the point: `@session.timed-out` MOVES
   * the dialog to `abandoned`, and this WRITES the line saying so. A handler
   * cannot change what the agent does — that is what keeps the event stream a
   * log rather than a second control path — and a transition writes nothing to
   * the slot, so a call that ends badly needs both. See `events.ts`.
   */
  events: DESK_EVENTS,

  // No `syncState` and no `client.tsx`: what a caller of this line can see is
  // the phone. The state worth rendering would be the POSITION rather than the
  // slot, and `roadsideCall.projection((at) => at)` is how a custom chrome
  // would take it — see `dispatch-center` for a template that does.

  greeting:
    "Roadside assistance, you've reached the dispatch desk. First things first — are you " +
    "somewhere safe, out of traffic? And whereabouts are you?",
});
