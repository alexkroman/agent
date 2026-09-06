import { agent } from "@alexkroman1/aai";
import { DIALOGS } from "./game.ts";
import { gameProjection } from "./shared.ts";

/**
 * Word Wrangler — Pipecat's three-way phone word game as one voice agent.
 * `shared.ts` carries the attribution and the their-name → our-name table;
 * `game.ts` is the round as a dialog and the two-minute clock as its `timeout`.
 *
 * The host is the agent. The player is `ctx.generate` inside
 * `relay_description`, on its own prompt with only the current word's context —
 * which is what their parallel pipeline, resampler and per-word reconnect were
 * built to arrange. The referee is a function.
 */
export default agent({
  name: "Word Wrangler",
  // The scoreboard: the word the describer is looking at, the score, the clock.
  syncState: gameProjection,
  /**
   * Arms the clock. `playing` declares a two-minute `timeout`, and a dialog's
   * deadline is armed by the runtime only for a dialog listed here — without
   * this line the round would never end on its own.
   */
  dialogs: DIALOGS,
  greeting:
    "Welcome to Word Wrangler. I'll give you words to describe, and my A.I. player will try to " +
    "guess them - two minutes on the clock. Say ready when you are.",
});
