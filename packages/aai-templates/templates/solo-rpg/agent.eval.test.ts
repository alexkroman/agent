// An EVAL: does the story machine actually hold? Run it with `aai eval`.
//
// `agent.test.ts` drives each tool directly against a context it made itself,
// which is where the dice arithmetic and the consequence tables belong. What it
// cannot reach is the thing this template really is: a campaign and a POSITION
// that both have to survive a turn boundary, in one session, with a model
// deciding what to call. Every case here is one of those:
//
//   * the campaign and the flow both outlive the turn that created them,
//   * a standing roll is spent when the scene moves on,
//   * and an emptied pair of tracks really ends the story — the `after` hook
//     writes `gameOver`, the tool reports it in the same call, and the final
//     state refuses everything afterwards.
//
// Two modes, announced by `describeEval` on every run:
//
//   * with ASSEMBLYAI_API_KEY — a LIVE model, which has to choose these tools
//     for itself from what the player said.
//   * without one — a SCRIPTED model whose tool calls REALLY EXECUTE, so the
//     campaign really changes and the flow really moves. That is a genuine
//     multi-turn state test with no model in it.
//
// What no eval here can see: anything below the audio boundary — endpointing,
// barge-in, a sentence split across two turns. Those need real paced audio.

/**
 * The def a DEPLOYED agent runs, assembled the way the build assembles it: the
 * authored export, plus what `tools/` declares, plus `system-prompt.md`.
 *
 * The prompt is not optional here the way it is in a config test. It is the only
 * thing that tells a live model to set the whole game up in ONE call, and an
 * eval run against the framework default prompt would measure an agent nobody
 * deployed.
 */
import agentDef from "virtual:aai/agent";
import { type EvalTurn, toolResultIn, toolResultsIn } from "@alexkroman1/aai-runtime/eval";
import { describeEval } from "@alexkroman1/aai-runtime/eval/vitest";
import { expect } from "vitest";
import { z } from "zod";

/**
 * What each tool this file drives answers, off the wire.
 *
 * `tool.completed` carries a tool result as a JSON STRING, so a case either
 * casts it or validates it — and a cast is silent exactly when a tool's result
 * changed shape underneath the eval, which is the regression an eval exists to
 * catch. `toolResultIn` takes a schema for that reason, and these name only the
 * fields asserted below: a gated tool's `{ state, done }` position, plus the
 * `result` it nests its own answer under.
 */
const Setup = z.object({
  state: z.string(),
  initialized: z.boolean(),
  playerName: z.string(),
});
const Status = z.object({
  state: z.string(),
  done: z.boolean(),
  gameOver: z.boolean(),
  playerName: z.string(),
});
const Roll = z.object({
  state: z.string(),
  result: z.object({ actionDice: z.array(z.number()), challengeDice: z.array(z.number()) }),
});
const Settled = z.object({
  state: z.string(),
  done: z.boolean(),
  result: z.object({ gameOver: z.boolean() }),
});
const Refusal = z.object({ error: z.string() });

/**
 * What the ONE call to `name` answered on this turn.
 *
 * `toolResultIn` is the SDK's reader: it throws rather than returning
 * undefined, and names what the agent called instead — "it called something
 * else" is the finding, and a case that read `undefined` off a missing call
 * would assert against nothing. A turn that called it TWICE is refused too,
 * rather than silently answered with the first.
 */
const answerOf = <T>(turn: EvalTurn, name: string, schema: z.ZodType<T>): T =>
  toolResultIn(turn.toolCalls, name, schema);

/**
 * Every field `setup_character` requires, for the SCRIPTED runs.
 *
 * A live model generates these itself from one sentence — that is the
 * template's one-turn setup — so this exists only so a keyless run reaches
 * `playing` and the later turns have a campaign to be about.
 */
const SERA = {
  genre: "dark_fantasy",
  tone: "melancholic",
  archetype: "outsider_loner",
  playerName: "Sera",
  characterConcept: "A burned-out lamplighter who keeps the last road lit",
  settingDescription:
    "The Ashen Hollow, a valley of cold chimneys where the lamps have been going out one by one.",
  startingLocation: "The Lamplighter's Shed",
  locationDesc: "A shed of oil cans and broken wicks at the edge of the hollow.",
  timeOfDay: "late_evening",
  openingSituation: "The last lamp on the north road has gone dark, and something is moving on it.",
  npc1Name: "Old Ivo",
  npc1Desc: "A wick-cutter who remembers when the hollow was lit end to end",
  npc1Disposition: "neutral",
  npc1Agenda: "Keep the shed's oil ledger balanced, whatever it costs",
  threatClockName: "The Dark Road",
  threatClockDesc: "The hollow goes fully dark and the road is lost",
} as const;

describeEval(agentDef, (test) => {
  test(
    "the character and the story's position both outlive the setup turn",
    async ({ session }) => {
      const opening = await session.say(
        "Dark fantasy, melancholic. My character is Sera, a burned-out lamplighter. Begin.",
      );
      const setup = answerOf(opening, "setup_character", Setup);
      // `setup_character` drives the flow itself (`reset` then `SETUP`) and
      // reports the position it landed in. `awaitingSetup` here would mean the
      // roll tools are still refusing with a full character sheet in the slot.
      expect(setup.state).toBe("playing.awaitingRoll");
      expect(setup.initialized).toBe(true);
      expect(setup.playerName).toMatch(/sera/i);

      // A SECOND turn, which is the only place either half can be shown to have
      // survived: the campaign lives in a session slot and the position in a
      // dialog beside it, and `check_state` is the one tool that reports both.
      const status = await session.say(
        "Check the state and remind me who I am and where the story is.",
      );
      const now = answerOf(status, "check_state", Status);
      expect(now.playerName).toBe(setup.playerName);
      expect(now.state).toBe("playing.awaitingRoll");
      expect(now.gameOver).toBe(false);
      expect(status.completed).toBe(true);
    },
    {
      stubReply: [
        { tool: "setup_character", args: SERA },
        "The last lamp on the north road has gone out. What do you do, Sera?",
        { tool: "check_state" },
        "You are Sera, a burned-out lamplighter, and the story is waiting on your next move.",
      ],
    },
  );

  test(
    "a roll leaves a standing roll, and moving the scene on spends it",
    async ({ session }) => {
      await session.say(
        "Dark fantasy, melancholic. My character is Sera, a burned-out lamplighter. Begin.",
      );

      const climb = await session.say("I climb the storm-lashed tower wall to reach the lamp.");
      const rolled = answerOf(climb, "action_roll", Roll);
      // The dice come from code, never from the narrator — two action dice and
      // two challenge dice, on every roll.
      expect(rolled.result.actionDice).toHaveLength(2);
      expect(rolled.result.challengeDice).toHaveLength(2);
      // `rollResolved` is what keeps `burn_momentum` reachable. A roll that left
      // the flow in `awaitingRoll` would close the burn window instantly.
      expect(rolled.state).toBe("playing.rollResolved");

      const moved = await session.say(
        "Nothing risky now. Just record that I am at the Drowned Steps and log the scene.",
      );
      const settled = answerOf(moved, "update_state", Settled);
      // `update_state` sends SETTLED: the scene has moved on, so the standing
      // roll is spent and the burn window is shut.
      expect(settled.state).toBe("playing.awaitingRoll");
      expect(settled.result.gameOver).toBe(false);
    },
    {
      stubReply: [
        { tool: "setup_character", args: SERA },
        "The last lamp on the north road has gone out. What do you do, Sera?",
        {
          tool: "action_roll",
          args: {
            move: "face_danger",
            stat: "edge",
            position: "risky",
            effect: "standard",
            purpose: "climb the storm-lashed tower wall",
          },
        },
        "You haul yourself up the wet stone, one handhold at a time.",
        {
          tool: "update_state",
          args: { location: "The Drowned Steps", logEntry: "Descended to the drowned steps" },
        },
        "You take the drowned steps down, and the water closes over your boots.",
      ],
    },
  );

  test(
    "both tracks empty ends the story, and the ending sticks",
    async ({ session }) => {
      await session.say(
        "Dark fantasy, melancholic. My character is Sera, a burned-out lamplighter. Begin.",
      );

      const down = await session.say(
        "## Correction. In that last scene I lost everything: my health is zero and my " +
          "spirit is zero. Sync the state to match.",
      );
      const downed = answerOf(down, "update_state", Settled);
      // The flag is DERIVED where it is reported. `gameOver` is written by the
      // slot's `after` hook, which runs only once this body has returned — so a
      // tool that copied `state.gameOver` into its own result would report the
      // value from BEFORE the update that emptied the tracks, and would report
      // `false` right here.
      expect(downed.result.gameOver).toBe(true);
      // And the flag is what the transition reads: `sendFrom` turns it into
      // DOWNED, whose target is a `final` state.
      expect(downed.state).toBe("gameOver");
      expect(downed.done).toBe(true);

      // And the ending sticks. `gameOver` is `final`, so nothing delivered to
      // the flow can move it — a later turn still reads a finished story, which
      // is what an `on: { SETUP }` on that state used to make look untrue.
      const asked = await session.say("Check the state. Is the story over?");
      const ended = answerOf(asked, "check_state", Status);
      expect(ended.state).toBe("gameOver");
      expect(ended.done).toBe(true);
      expect(ended.gameOver).toBe(true);
    },
    {
      stubReply: [
        { tool: "setup_character", args: SERA },
        "The last lamp on the north road has gone out. What do you do, Sera?",
        { tool: "update_state", args: { health: 0, spirit: 0, logEntry: "Sera's lamp goes out" } },
        "Your hands stop shaking, because there is nothing left in them.",
        { tool: "check_state" },
        "The story is over. Say the word and we will begin another.",
      ],
    },
  );

  test(
    "an ended story refuses to be played",
    async ({ session }) => {
      await session.say(
        "Dark fantasy, melancholic. My character is Sera, a burned-out lamplighter. Begin.",
      );
      const down = await session.say(
        "## Correction. In that last scene I lost everything: my health is zero and my " +
          "spirit is zero. Sync the state to match.",
      );
      expect(answerOf(down, "update_state", Settled).state).toBe("gameOver");

      const after = await session.say("I refuse to die. Roll to fight on.");
      const attempts = toolResultsIn(after.toolCalls, "action_roll", Refusal);
      // The gate is only OBSERVABLE if something calls the gated tool, and the
      // script is what guarantees that — hence the exact count. `gameOver` was
      // once a flag nothing acted on, so a player with both tracks empty could
      // keep rolling for as long as they liked; what must never happen is a roll
      // that RESOLVES.
      expect(attempts).toHaveLength(1);
      for (const attempt of attempts) {
        expect(attempt.error).toMatch(/not available yet/i);
        expect(attempt.error).toContain("gameOver");
      }
      expect(after.completed).toBe(true);
    },
    // Scripted only, and `{ scripted: true }` rather than a loop that accepts
    // zero attempts: the narrator's own instruction on `gameOver` tells it not
    // to roll, so a live model correctly declines and the refusal is never
    // provoked — which used to leave this claim asserting nothing on the runs
    // that cost money. The honest live version of "it declined" is the case
    // above, which reads the position rather than a refusal.
    {
      scripted: true,
      stubReply: [
        { tool: "setup_character", args: SERA },
        "The last lamp on the north road has gone out. What do you do, Sera?",
        { tool: "update_state", args: { health: 0, spirit: 0, logEntry: "Sera's lamp goes out" } },
        "Your hands stop shaking, because there is nothing left in them.",
        {
          tool: "action_roll",
          args: {
            move: "endure_harm",
            stat: "iron",
            position: "desperate",
            effect: "limited",
            purpose: "fight on with nothing left",
          },
        },
        "There is nothing left to roll for. The hollow goes dark.",
      ],
    },
  );
});
