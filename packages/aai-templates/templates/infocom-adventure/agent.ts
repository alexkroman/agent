import { agent } from "@alexkroman1/aai";
import { gameStatus, recordTurn } from "./shared.ts";

export default agent({
  name: "Cavern Adventure",
  // The world exists before the first command, so a resumed connection has
  // something to project rather than an empty state object.
  // A narrator wants a narrative voice; everything else stays on the
  // default all-AssemblyAI pipeline.
  voice: "paul",
  /**
   * The status line, pushed to the CRT's top bar — where you are, your score,
   * your rank and the turn count, the four facts the printed games put across
   * the top of the screen.
   *
   * The client used to COUNT the turns itself, by reducing over the message
   * list for `role === "user"`, which is a different number from the one the
   * game keeps: a barge-in, a session resumed mid-adventure or a turn the
   * runtime merges all move the two apart, and the one on screen was never the
   * one the narrator was told. `syncState` sends the game's own.
   */
  syncState: gameStatus,
  // The opening scene here must agree with DEFAULT_GAME_STATE.currentRoom
  // (shared.ts) and the world map in system-prompt.md.
  greeting:
    "Welcome, adventurer. You are standing at the mouth of a weathered cave at the edge of a pine forest. A cold wind carries the smell of damp stone up from the darkness below. A rusted lantern hangs from an iron hook beside the entrance. What would you like to do?",
  /**
   * The turn counter and the command log are the FRAMEWORK's, not the model's.
   *
   * Both used to be a `game_state_history` tool the system prompt told the
   * narrator to call on every turn, handing back the player's own words — which
   * the runtime already had. A hook is strictly better on all three counts a
   * template is meant to teach: it costs no model call, it cannot be forgotten,
   * and it needs no prose in the prompt to enforce it.
   *
   * `.committed` rather than `.updated`: partials arrive several times per
   * utterance and would count one sentence as a dozen turns.
   *
   * It writes and does not speak, which is the whole line a session event hook
   * draws — nothing here can decide what the narrator says next. The narrator
   * reads the result on its next `game_state_get`.
   */
  events: {
    "user-transcript.committed": (event, ctx) => recordTurn(ctx, event.text),
  },
});
