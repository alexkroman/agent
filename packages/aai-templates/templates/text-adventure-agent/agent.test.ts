/** The def a DEPLOYED agent runs: authored, plus what `tools/` declares. */
import agentDef from "virtual:aai/agent";
import {
  type AgentSessionContext,
  createSeededRandom,
  type RandomSource,
  type SessionEventContext,
} from "@alexkroman1/aai";
import { isToolFailure } from "@alexkroman1/aai/utils";
import {
  createToolContext,
  expectToolOk,
  fireEvent,
  parseToolInput,
  sessionEvent,
  toolOf,
} from "@alexkroman1/aai-runtime/testing";
import { describeAgent } from "@alexkroman1/aai-runtime/testing/vitest";
import { describe, expect, test } from "vitest";

import { DEFAULT_GAME_STATE, gameSlot, rankFor, SCAVENGER_FLAG, statusBlock } from "./shared.ts";
import gameStateDrop from "./tools/game_state_drop.ts";
import gameStateFlag from "./tools/game_state_flag.ts";
import gameStateGet from "./tools/game_state_get.ts";
import gameStateMove from "./tools/game_state_move.ts";
import gameStateRestart from "./tools/game_state_restart.ts";
import gameStateScore from "./tools/game_state_score.ts";
import gameStateTake from "./tools/game_state_take.ts";

/** What the player said, delivered the way the runtime delivers it. */
const say = (text: string, ctx: SessionEventContext) =>
  fireEvent(agentDef, sessionEvent("userTranscript.committed", { text }), ctx);

/** The board a fresh game projects: the default, with `rank` filled by `after`. */
const FRESH = { ...DEFAULT_GAME_STATE, rank: rankFor(0) };

describeAgent(agentDef, (run) => {
  test("the game is per session, and the default is cloned", async () => {
    const one = createToolContext();
    const two = createToolContext();
    await run(gameStateTake, { value: "lantern" }, one);
    expect(gameSlot.get(two).inventory).toEqual([]);
    expect(DEFAULT_GAME_STATE.inventory).toEqual([]);
  });

  describe("the mutating tools actually mutate", () => {
    test("take adds to the inventory and does not double an item", async () => {
      const ctx = createToolContext();
      expect((await run(gameStateTake, { value: "lantern" }, ctx)).inventory).toEqual(["lantern"]);
      // The STORED value, not the one the body returned.
      expect(gameSlot.get(ctx).inventory).toEqual(["lantern"]);
      expect((await run(gameStateTake, { value: "lantern" }, ctx)).inventory).toEqual(["lantern"]);
    });

    test("flag records a flag, and a second flag joins the first", async () => {
      const ctx = createToolContext();
      await run(gameStateFlag, { value: "gate_opened" }, ctx);
      const both = await run(gameStateFlag, { value: "rope_cut" }, ctx);
      expect(both.flags).toEqual({ gate_opened: true, rope_cut: true });
      expect(gameSlot.get(ctx).flags).toEqual({ gate_opened: true, rope_cut: true });
    });

    test("what a READ is handed is frozen, which is why the two above are updateTool", async () => {
      const ctx = createToolContext();
      await run(gameStateTake, { value: "lantern" }, ctx);
      const game = gameSlot.get(ctx);
      expect(Object.isFrozen(game.inventory)).toBe(true);
      expect(() => (game.inventory as string[]).push("sword")).toThrow(TypeError);
    });
  });

  describe("the adventure's tools", () => {
    test("drop removes an item, and refuses one the player never took", async () => {
      const ctx = createToolContext();
      await run(gameStateTake, { value: "lantern" }, ctx);
      await run(gameStateTake, { value: "rope" }, ctx);

      const dropped = expectToolOk(await run(gameStateDrop, { value: "lantern" }, ctx));
      expect(dropped.inventory).toEqual(["rope"]);

      const refused = await run(gameStateDrop, { value: "sword" }, ctx);
      expect(isToolFailure(refused) && refused.error).toMatch(/not carrying sword/);
      expect(gameSlot.get(ctx).inventory).toEqual(["rope"]);
    });

    test("move sets the room and reports the turn count without touching it", async () => {
      const ctx = createToolContext();
      const moved = await run(gameStateMove, { value: "Echo Chamber" }, ctx);
      // `moves` is 0 because nobody has SAID anything.
      expect(moved).toEqual({ currentRoom: "Echo Chamber", moves: 0 });
      expect(gameSlot.get(ctx).currentRoom).toBe("Echo Chamber");
    });

    test("score accumulates rather than replacing", async () => {
      const ctx = createToolContext();
      await run(gameStateScore, { value: 10 }, ctx);
      expect((await run(gameStateScore, { value: 5 }, ctx)).score).toBe(15);
    });

    test("what the player SAYS counts the turn, once, whether or not the narrator moves", async () => {
      const ctx = createToolContext();
      await say("go north", ctx);
      await run(gameStateMove, { value: "Echo Chamber" }, ctx);
      await say("look", ctx);

      const game = gameSlot.get(ctx);
      expect(game.moves).toBe(2);
      expect(game.currentRoom).toBe("Echo Chamber");
      expect((await run(gameStateGet, ctx)).moves).toBe(2);
    });

    test("get reports the whole board", async () => {
      const ctx = createToolContext();
      await run(gameStateTake, { value: "lantern" }, ctx);
      await run(gameStateFlag, { value: "gate_opened" }, ctx);
      await run(gameStateMove, { value: "Echo Chamber" }, ctx);
      await run(gameStateScore, { value: 7 }, ctx);
      await say("go east", ctx);

      expect(await run(gameStateGet, ctx)).toEqual({
        currentRoom: "Echo Chamber",
        score: 7,
        rank: "Beginner",
        moves: 1,
        inventory: ["lantern"],
        flags: { gate_opened: true },
      });
    });

    test("restart replaces the whole game, and the fresh room is the one the greeting describes", async () => {
      const ctx = createToolContext();
      await run(gameStateTake, { value: "lantern" }, ctx);
      await run(gameStateScore, { value: 30 }, ctx);
      await run(gameStateMove, { value: "Echo Chamber" }, ctx);

      const restarted = await run(gameStateRestart, ctx);
      expect(restarted).toEqual({ restarted: true, currentRoom: DEFAULT_GAME_STATE.currentRoom });
      expect(gameSlot.get(ctx)).toEqual(FRESH);
    });

    test("the schemas say what a spoken argument has to be turned into", async () => {
      // Points are a NUMBER: a schema that took a string would let "ten" reach `+=`.
      expect(await parseToolInput(agentDef, "game_state_score", { value: 10 })).toEqual({
        value: 10,
      });
      await expect(
        parseToolInput(agentDef, "game_state_score", { value: "ten" }),
      ).rejects.toThrow();
      // And the read takes nothing at all, which is what makes `run(gameStateGet, ctx)` legal.
      expect(toolOf(agentDef, "game_state_get").inputSchema).toBeUndefined();
    });
  });

  describe("what the game works out for itself", () => {
    test("the rank follows the score, and no tool writes it", async () => {
      const ctx = createToolContext();
      expect(gameSlot.get(ctx).rank).toBe("Beginner");

      // The tool that carried the player over the threshold reports the rank
      // it EARNED — read off the stored game, after the hook moved it.
      const scored = await run(gameStateScore, { value: 30 }, ctx);
      expect(scored).toEqual({ score: 30, rank: "Amateur Adventurer" });
      expect(gameSlot.get(ctx).rank).toBe("Amateur Adventurer");

      // And the hook owns the write, so any later mutation leaves it consistent.
      await run(gameStateTake, { value: "chalice" }, ctx);
      expect(gameSlot.get(ctx).rank).toBe(rankFor(gameSlot.get(ctx).score));
    });

    test("rankFor is a ladder, and the fresh game starts on the bottom rung", () => {
      expect(rankFor(0)).toBe("Beginner");
      expect(rankFor(24)).toBe("Beginner");
      expect(rankFor(25)).toBe("Amateur Adventurer");
      expect(rankFor(999)).toBe("Wizard");
      expect(gameSlot.projected().rank).toBe("Beginner");
    });

    test("the scavenger's threshold is a number the spec can state", async () => {
      const always = createToolContext({ random: () => 0 });
      await run(gameStateTake, { value: "scarab" }, always);
      const taken = expectToolOk(await run(gameStateDrop, { value: "scarab" }, always));
      expect(taken.takenByScavenger).toBe(true);
      expect(gameSlot.get(always).flags[SCAVENGER_FLAG]).toBe(true);

      // A source returning exactly 1 is outside `Math.random`'s contract and
      // well inside what a stub does — the comparison has to leave it out.
      const never = createToolContext({ random: () => 1 });
      await run(gameStateTake, { value: "scarab" }, never);
      const kept = expectToolOk(await run(gameStateDrop, { value: "scarab" }, never));
      expect(kept.takenByScavenger).toBe(false);
      expect(gameSlot.get(never).flags[SCAVENGER_FLAG]).toBeUndefined();
    });

    test("one seed is one adventure: the same stream robs the player the same way", async () => {
      // A SEEDED stream rather than a constant: `() => 0.5` never trips the
      // threshold, so nothing about the mechanic would be under test.
      const drops = 12;
      const playthrough = async (random: RandomSource): Promise<boolean[]> => {
        const ctx = createToolContext({ random });
        const struck: boolean[] = [];
        for (let i = 0; i < drops; i++) {
          await run(gameStateTake, { value: `treasure ${i}` }, ctx);
          const dropped = expectToolOk(await run(gameStateDrop, { value: `treasure ${i}` }, ctx));
          struck.push(dropped.takenByScavenger);
        }
        return struck;
      };

      const first = await playthrough(createSeededRandom(7));
      expect(await playthrough(createSeededRandom(7))).toEqual(first);
      expect([...new Set(first)].sort()).toEqual([false, true]);
      expect(await playthrough(createSeededRandom(8))).not.toEqual(first);
    });
  });

  describe("the prompt carries the board", () => {
    /** The def's `promptContext`, which the build appends under `system-prompt.md`. */
    const context = (ctx: AgentSessionContext): string => {
      const { promptContext } = agentDef;
      if (typeof promptContext !== "function") throw new Error("promptContext is not a resolver");
      return promptContext(ctx);
    };

    test("a fresh session is told the opening board, before any tool has run", () => {
      const opening = context(createToolContext());
      expect(opening).toContain(`- Location: ${DEFAULT_GAME_STATE.currentRoom}`);
      expect(opening).toContain("- Score: 0 (Beginner)");
      expect(opening).toContain("- Turns taken: 0");
      expect(opening).toContain("- Carrying: nothing");
    });

    test("every mutation is in the NEXT request's prompt, with no tool call in between", async () => {
      const ctx = createToolContext();
      await run(gameStateTake, { value: "lantern" }, ctx);
      await run(gameStateMove, { value: "Echoing Hall" }, ctx);
      await run(gameStateScore, { value: 30 }, ctx);
      await say("go down to the hall", ctx);

      const now = context(ctx);
      expect(now).toBe(statusBlock(gameSlot.get(ctx)));
      expect(now).toContain("- Location: Echoing Hall");
      expect(now).toContain("- Score: 30 (Amateur Adventurer)");
      expect(now).toContain("- Turns taken: 1");
      expect(now).toContain("- Carrying: lantern");
    });

    test("each session is told its OWN board", async () => {
      const one = createToolContext();
      const two = createToolContext();
      await run(gameStateTake, { value: "jade idol" }, one);
      expect(context(one)).toContain("- Carrying: jade idol");
      expect(context(two)).toContain("- Carrying: nothing");
    });
  });
});
