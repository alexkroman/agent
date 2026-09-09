import {
  errorMessage,
  isToolFailure,
  requireEnv,
  type ToolErrorHandler,
  toolFailure,
} from "@alexkroman1/aai";
import { ChannelDeliveryError, sendToChannel } from "@alexkroman1/aai/channels";
import { z } from "zod";
import { briefingSlot } from "../shared.ts";
import { briefingChannel, briefingMessage, DESTINATION_ENV } from "../slack.ts";

/**
 * Anything that reaches here is a deploy nobody finished or a bug in this file
 * — see the note on the tool below — and neither is fixed by asking the model
 * to try again, so it goes back up as a fatal failure.
 *
 * Named, with its type spelled, because the type is what says what the two
 * outcomes are: RETURN a `ToolFailure` (or a string) and the model reads it and
 * carries on; THROW and the call ends without an answer.
 */
const unfinishedDeployIsFatal: ToolErrorHandler = (err) => {
  throw err;
};

/**
 * Post the board to the desk's Slack channel, so the briefing outlives the
 * call.
 *
 * **Read as a subagent template, this is the tool that does NOT delegate**, and
 * that is why it is here. Everything the desk knows came back from a subagent
 * with its own context window; what crossed into the conversation is one
 * paragraph per angle, and those paragraphs are already on the slot. Sending
 * them costs no model, no researcher and no second look at the web — the same
 * argument `briefing_so_far` makes, one step further.
 *
 * **`slot.tool`, because it READS the board and writes nothing.** A `tool()`
 * opening with `briefingSlot.get(ctx)` would say the same thing in code and
 * nothing in the declaration; what a read is handed is deep-frozen, so a body
 * that meant to mutate stops compiling here rather than failing at a caller.
 *
 * **The credential is `ctx.env`, through `requireEnv`, and it THROWS.** That is
 * the one deliberate throw in this template. A missing key is not a refusal the
 * desk can talk its way around and not something the caller did — it is a
 * deploy nobody finished — so the SDK's own message names the variable and how
 * to set it. Everything a call CAN recover from is a `ToolFailure` below.
 *
 * **And `onError` is what makes that throw mean something.** Without it the
 * runtime hands every exception to the model as this call's result, so a
 * webhook nobody configured reads as an ordinary hiccup: the desk apologises,
 * calls `send_briefing` again, gets the same sentence, and spends the reply's
 * whole `maxSteps` budget on a variable that will still be unset on the next
 * attempt. Re-throwing declares the failure FATAL — the call rejects, the model
 * is handed nothing to retry against, and the runtime reports it as a `tool`
 * session error where whoever deployed this can see it.
 *
 * **Blanket, and only because of the shape of this body.** Every failure the
 * desk can talk about is RETURNED above and below — the empty board, a
 * destination that is not Slack, both halves of a `ChannelDeliveryError` — so
 * anything that reaches `onError` here is a deploy that is not finished or a
 * bug in this file, and neither is fixed by asking the model to try again. A
 * tool whose body can throw for a transient reason should classify instead:
 * return a `ToolFailure` for the recoverable throws and re-throw only the rest.
 */
export default briefingSlot.tool({
  description:
    "Send the briefing so far to the team's Slack channel. Use it when the caller " +
    "asks for it in writing, or to have it passed on to someone who was not on the " +
    "call. Tell them you are sending it before you call this.",
  inputSchema: z.object({}),
  async execute(_args, board, ctx) {
    if (board.findings.length === 0) {
      return toolFailure(
        "There is nothing to send yet — research something first, then offer to send it.",
      );
    }

    const destination = briefingChannel(requireEnv(ctx, DESTINATION_ENV));
    if (isToolFailure(destination)) return destination;

    try {
      await sendToChannel(destination, briefingMessage(board));
    } catch (err: unknown) {
      // The channel has already classified the refusal, which is the whole
      // reason this is not a `fetch` and an `if (!res.ok)`: `retryable` is the
      // 4xx/5xx split, and its message carries Slack's own advice for the half
      // that will answer the same way forever. What is left for the desk is
      // what to SAY, and the two are opposite — offering to try again after a
      // revoked webhook is a promise it cannot keep.
      if (err instanceof ChannelDeliveryError) {
        return toolFailure(
          err.retryable
            ? `Slack did not take the briefing: ${err.message} Tell the caller it has not ` +
                "sent yet and offer to try again in a moment."
            : `Slack refused the briefing: ${err.message} Tell the caller it has not sent ` +
                "and that trying again will not help — someone has to fix the destination.",
        );
      }
      return toolFailure(`The briefing did not send: ${errorMessage(err)}`);
    }

    return {
      topic: board.topic,
      sent: board.findings.length,
      message:
        "Say it has gone to the channel and how many angles went with it. Do not read " +
        "the briefing back out — they have it in writing now.",
    };
  },
  // See the note above: the only throw this body has is `requireEnv`'s, and a
  // missing webhook is unfixable from inside the call. Re-throwing keeps the
  // SDK's own message — which names the variable and how to set it — as the
  // fatal error's `cause`.
  onError: unfinishedDeployIsFatal,
});
