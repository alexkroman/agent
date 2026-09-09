import { agent } from "@alexkroman1/aai";
import { gameProjection, gameSlot, liveSheet, storyFlow } from "./shared.ts";
// The rules of the game. The build discovers `system-prompt.md` on its own —
// importing it is what lets the resolver below compose against it, and
// `withSystemPrompt` leaves a resolver exactly as written.
import prompt from "./system-prompt.md?raw";

export default agent({
  name: "Solo RPG",
  // The listing line, for a reader picking an agent out of a list. It says what
  // the borrowed systems DO rather than naming them — the attribution belongs
  // in `shared.ts`, not in a picker row.
  description: "Narrates a solo tabletop campaign and keeps its dice, tracks and clocks",
  greeting:
    "Welcome. Tell me your name, or describe the kind of story you want, and we will begin. You can say something like, dark fantasy warrior named Kael, or just give me a name and I will build a world around you.",
  sttPrompt:
    "Solo RPG terms: strong hit, weak hit, miss, momentum, chaos factor, clock, disposition, bond, edge, heart, iron, shadow, wits, face danger, compel, gather information, secure advantage, clash, strike, endure harm, endure stress, make connection, test bond, resupply, world shaping",
  maxSteps: 8,

  /**
   * The rules, plus the campaign sheet as it stands RIGHT NOW.
   *
   * A `systemPrompt` resolver is called once per model request, so the tracks,
   * the momentum, the chaos factor, the clocks and the cast are in front of the
   * narrator before it says anything. The prompt's FLOW section used to open
   * with "call check_state as your FIRST tool call every turn … NEVER remember
   * or guess stats from prior turns" — a full model round trip per turn of a
   * live voice game, and only advice, so the turns it was skipped on are the
   * turns the sheet drifted.
   *
   * `ctx` is an `AgentSessionContext`: the session id, the env and the slots.
   * Enough for `gameSlot.get`, and deliberately nothing that could speak — a
   * resolver returns instructions, it does not take a turn.
   *
   * The dialog's own `instruction` is NOT rendered here. `storyFlow` is declared
   * below, and the runtime already appends the active state's instruction to the
   * same prompt; saying it twice is how two copies of one rule drift apart.
   */
  systemPrompt: (ctx) => `${prompt}\n\n${liveSheet(gameSlot.get(ctx))}`,

  // One declaration replaces a `ctx.send("game_state", state)` in every
  // state-mutating tool — six of them, and adding a seventh meant
  // remembering to push or watching the UI quietly fall out of sync.
  // NOT the identity: `gameView` withholds the seven fields the sidebar never
  // reads and every unplayed act's goal and mood with them, which is the only
  // defence there is against a spoiler leak (see `shared.ts`). The slot's own
  // default is what a session that has run no tool projects.
  syncState: gameProjection,

  // The flow gates the tools whether or not it is declared here. What DECLARING
  // it buys is the other half the states were written for: the active state's
  // `instruction` goes in front of the model on every turn, rather than only on
  // the turns a tool result happens to carry it back. `system-prompt.md` already
  // tells the narrator to read `instruction` as ground truth — this is what
  // makes that true before the first tool call of a turn, and it is the field
  // six of the other seven flow templates declare.
  dialogs: [storyFlow],
});
