import { agent } from "@alexkroman1/aai";
import { gameSlot, gameStatus, recordTurn, statusBlock } from "./shared.ts";
// The prose half of the prompt. `system-prompt.md` beside this file is
// discovered by the build either way — importing it is what lets the resolver
// below compose against it, and `withSystemPrompt` then leaves the resolver
// exactly as written.
import prompt from "./system-prompt.md?raw";

export default agent({
  name: "Cavern Adventure",
  // The listing line — a registry row, `aai list`, the studio's picker. Never
  // the model: the world and the voice rules are `system-prompt.md`'s.
  description: "Runs a spoken text adventure through an underground cave system",
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
  /**
   * The world's rules, plus the board as it stands RIGHT NOW.
   *
   * A `systemPrompt` resolver is called once per model request, so the four
   * facts of the status line and the player's inventory are in front of the
   * narrator on every turn — which is what makes drift impossible rather than
   * discouraged. The prompt used to carry a section demanding a
   * `game_state_get` call before answering any question about the board, and
   * "never from memory": advice that cost a round trip when it was obeyed and a
   * desynced world when it was not. Four scalars and a list are cheaper to
   * state than to ask for.
   *
   * `ctx` is an `AgentSessionContext` — the session id, the env and the slots,
   * which is everything `gameSlot.get` needs and deliberately nothing that
   * could speak. Synchronous by contract: the request is being assembled.
   *
   * `game_state_get` is NOT retired by this. It answers with the flags and the
   * recent commands too, and it is still the tool for "check the game state".
   * What went is the compulsory read-back.
   */
  systemPrompt: (ctx) => `${prompt}\n\n${statusBlock(gameSlot.get(ctx))}`,
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
