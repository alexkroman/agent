import type { TelephonyAccess } from "@alexkroman1/aai";
import { agent } from "@alexkroman1/aai";
import { roadsideCall } from "./call.ts";
import { roadsideSlot } from "./shared.ts";

/**
 * Who may put a call on this agent.
 *
 * **This is the one template where declaring it is not a detail**: a roadside
 * desk is reached by a stranded person on a phone, not by a browser tab, and
 * `WS /phone` is not served at all unless an agent asks for it. `true` would
 * admit every carrier the runtime ships a codec for; the list is the honest
 * shape for a desk whose numbers are with known carriers, and it is an
 * ALLOW-LIST. It is not a claim about credentials: a carrier's webhook
 * signature is checked where the webhook lands.
 */
const PHONE_LINE: TelephonyAccess = ["twilio", "telnyx"];

/**
 * A roadside-assistance line: find the caller, price the call, read them the
 * fee, send a truck.
 *
 * It exists to be the worked example of a `dialog()` describing a CALL rather
 * than a form — a caller who has gone quiet, a phase that must not be
 * interrupted, a verification step that has to give up on its own. Read
 * `call.ts` first: it is the whole template. `shared.ts` is the rate card, the
 * fleet and the session slot; `yard.ts` is the depot's own board, which every
 * session shares and which a keyed lock keeps honest.
 */
export default agent({
  name: "Roadside Assist",
  listing: "Verifies roadside coverage, reads the service fee and dispatches a tow truck",
  /**
   * What wires the dialog to the session. Without this line `roadsideCall`
   * still gates its tools and still moves on `send` — and none of the things
   * this template is about would happen: the session events would reach
   * nothing, the two deadlines would never be armed, the active state's
   * instruction would reach the model only on turns that called a tool, and
   * `interruption`/`toolChoice` would be declarations nothing read (the two
   * knobs are a PIPELINE property; a speech-to-speech transport warns).
   */
  dialogs: [roadsideCall],
  telephony: PHONE_LINE,
  // The one outcome no tool sees and the dialog does not move on: the line
  // itself failing. Not always fatal, so the line says which it was.
  events: {
    "error.reported": (event, ctx) =>
      roadsideSlot.update(ctx, (state) => {
        const how = event.fatal ? "call dropped" : "recovered";
        state.log.push(`Line trouble (${event.code}, ${how}): ${event.message}`);
      }),
  },
  // No `client.tsx`: what a caller of this line can see is the phone.
  greeting:
    "Roadside assistance, you've reached the dispatch desk. First things first — are you " +
    "somewhere safe, out of traffic? And whereabouts are you?",
});
