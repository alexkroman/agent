import { agent } from "@alexkroman1/aai";
import { DIALOGS } from "./game.ts";
import { GAME_EVENTS, gameProjection } from "./shared.ts";

/**
 * Word Wrangler — Pipecat's three-way phone word game as one voice agent.
 * `shared.ts` carries the attribution and the their-name → our-name table;
 * `game.ts` is the round as a dialog and the two-minute clock as its `timeout`.
 *
 * The host is the agent. The player is `ctx.generate` inside
 * `relay_description`, on its own prompt with only the current word's context —
 * which is what their parallel pipeline, resampler and per-word reconnect were
 * built to arrange. The referee is a function.
 *
 * **No guardrails, though a game about a forbidden word looks like the template
 * for them.** The rule the game turns on is the DESCRIBER's, and it is already
 * mechanical — `isFoul` over `game.spoken`. It is also not a refusal: a foul
 * FORFEITS the word and scores it, so an `inputGuardrails` entry, which answers
 * instead of the model and runs no tool, would swallow the very turn that has to
 * be recorded.
 *
 * The host's own rule ("never say the current word") has a legal exception every
 * round — it says the word when it GIVES or REPEATS one, out of a tool result —
 * and an output guardrail is handed the text and `AgentSessionContext`, which
 * deliberately carries no `messages`. So it cannot tell the round's opening line
 * from a hint. It would also be paid for in this template's one currency: a held
 * reply cannot stream, turning time-to-first-word into time-to-last-token on a
 * two-minute clock whose `bargeIn: { minWords: 1 }` exists so the describer can
 * talk over the host.
 */
export default agent({
  name: "Word Wrangler",
  // The listing line — a registry row, the studio's picker, never the model.
  // Three participants in one sentence, because that is the whole shape of the
  // thing and what makes it worth reading `shared.ts` for.
  description: "Hosts a two-minute word game between the caller and an A.I. guesser",
  // The scoreboard: the word the describer is looking at, the score, the clock.
  syncState: gameProjection,
  /**
   * Arms the clock. `playing` declares a two-minute `timeout`, and a dialog's
   * deadline is armed by the runtime only for a dialog listed here — without
   * this line the round would never end on its own.
   */
  dialogs: DIALOGS,
  /**
   * Records what the describer was HEARD to say, so the foul check is not
   * limited to the one turn the runtime hands a tool. It costs no model call
   * and the host cannot forget it — which is the whole reason the rule the game
   * turns on does not live in the prompt.
   */
  events: GAME_EVENTS,
  greeting:
    "Welcome to Word Wrangler. I'll give you words to describe, and my A.I. player will try to " +
    "guess them - two minutes on the clock. Say ready when you are.",
});
