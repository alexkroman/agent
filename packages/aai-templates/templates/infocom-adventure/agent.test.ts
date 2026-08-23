/// <reference types="vite/client" />

import type { ToolContext } from "@alexkroman1/aai";
import { createToolContext, runTool, withDiscoveredTools } from "@alexkroman1/aai/testing";
import { describe, expect, test } from "vitest";
import authoredAgent from "./agent.ts";

/**
 * The def a DEPLOYED agent runs: authored, plus what `tools/` declares.
 *
 * The glob is written HERE rather than reached for from a shared helper because
 * this file SHIPS: it is what a scaffolded project runs, so it may not import
 * anything outside its own template, and `import.meta.glob` is expanded against
 * the file containing it either way. This is the pattern a user writes.
 */
const agentDef = withDiscoveredTools(
  authoredAgent,
  import.meta.glob("./tools/*.ts", { eager: true }),
);

import { DEFAULT_GAME_STATE, gameSlot, MAX_HISTORY, REPORTED_HISTORY } from "./shared.ts";

/** A tool by the name the model calls it by, bound to this agent. */
const run = (name: string, argsOrCtx?: Record<string, unknown> | ToolContext, ctx?: ToolContext) =>
  runTool(agentDef, name, argsOrCtx, ctx);

/** Each context owns its OWN slot store, which is what makes two playthroughs
 *  independent by construction. */
const makeCtx = () => createToolContext();

// ─── The frozen-vs-draft contract ────────────────────────────────────────────
//
// This whole block exists because the template shipped without it and two tools
// were wrong. `game_state_take` and `game_state_flag` were declared with
// `gameSlot.tool` — the READING half, whose value is deep-frozen — while
// pushing to `inventory` and writing into `flags`. Every call threw a
// `TypeError`, and nothing in the repo executed either body. The declaration is
// the fix; these are what keep it fixed.

describe("the mutating tools actually mutate", () => {
  test("game_state_take adds to the inventory and does not double an item", async () => {
    const ctx = makeCtx();

    const first = (await run("game_state_take", { value: "lantern" }, ctx)) as {
      inventory: string[];
    };
    expect(first.inventory).toEqual(["lantern"]);
    // The stored value, not the one the body returned — a body handed a frozen
    // value would have thrown, and a body handed a copy nothing stores would
    // report success here and leave the slot empty.
    expect(gameSlot.get(ctx).inventory).toEqual(["lantern"]);

    const again = (await run("game_state_take", { value: "lantern" }, ctx)) as {
      inventory: string[];
    };
    expect(again.inventory).toEqual(["lantern"]);
  });

  test("game_state_flag records a flag, and a second flag joins the first", async () => {
    const ctx = makeCtx();

    await run("game_state_flag", { value: "gate_opened" }, ctx);
    const both = (await run("game_state_flag", { value: "rope_cut" }, ctx)) as {
      flags: Record<string, boolean>;
    };

    expect(both.flags).toEqual({ gate_opened: true, rope_cut: true });
    expect(gameSlot.get(ctx).flags).toEqual({ gate_opened: true, rope_cut: true });
  });

  test("what a READ is handed is frozen, which is why the two above are updateTool", async () => {
    const ctx = makeCtx();
    await run("game_state_take", { value: "lantern" }, ctx);

    const game = gameSlot.get(ctx);
    // The type refuses this too (`readonly string[]` has no `push`), and the
    // freeze is what makes the refusal true for a caller with no types.
    expect(Object.isFrozen(game.inventory)).toBe(true);
    expect(() => (game.inventory as string[]).push("sword")).toThrow(TypeError);
  });
});

// ─── The rest of the eight ───────────────────────────────────────────────────

describe("the adventure's tools", () => {
  test("drop removes an item and is a no-op for one the player never took", async () => {
    const ctx = makeCtx();
    await run("game_state_take", { value: "lantern" }, ctx);
    await run("game_state_take", { value: "rope" }, ctx);

    const dropped = (await run("game_state_drop", { value: "lantern" }, ctx)) as {
      inventory: string[];
    };
    expect(dropped.inventory).toEqual(["rope"]);

    const nothing = (await run("game_state_drop", { value: "sword" }, ctx)) as {
      inventory: string[];
    };
    expect(nothing.inventory).toEqual(["rope"]);
  });

  test("move sets the room and counts the move", async () => {
    const ctx = makeCtx();
    const moved = (await run("game_state_move", { value: "Echo Chamber" }, ctx)) as {
      currentRoom: string;
      moves: number;
    };
    expect(moved).toEqual({ currentRoom: "Echo Chamber", moves: 1 });
    expect(gameSlot.get(ctx).currentRoom).toBe("Echo Chamber");
  });

  test("score accumulates rather than replacing", async () => {
    const ctx = makeCtx();
    await run("game_state_score", { value: 10 }, ctx);
    const total = (await run("game_state_score", { value: 5 }, ctx)) as { score: number };
    expect(total.score).toBe(15);
  });

  test("history logs the command, counts the move, and reports only the recent ones", async () => {
    const ctx = makeCtx();
    for (let i = 1; i <= REPORTED_HISTORY + 2; i++) {
      await run("game_state_history", { value: `command ${i}` }, ctx);
    }

    const last = (await run("game_state_history", { value: "look" }, ctx)) as {
      moves: number;
      recentHistory: string[];
    };
    expect(last.moves).toBe(REPORTED_HISTORY + 3);
    expect(last.recentHistory).toHaveLength(REPORTED_HISTORY);
    expect(last.recentHistory.at(-1)).toBe("look");
  });

  test("the history is capped, so a long playthrough does not grow without bound", async () => {
    const ctx = makeCtx();
    for (let i = 0; i < MAX_HISTORY + 10; i++) {
      await run("game_state_history", { value: `command ${i}` }, ctx);
    }
    const game = gameSlot.get(ctx);
    expect(game.history).toHaveLength(MAX_HISTORY);
    // The cap drops the OLDEST — the newest command is the one a narrator needs.
    expect(game.history.at(-1)).toBe(`command ${MAX_HISTORY + 9}`);
    expect(game.moves).toBe(MAX_HISTORY + 10);
  });

  test("get reports the whole board, with the history trimmed to what a narrator reads", async () => {
    const ctx = makeCtx();
    await run("game_state_take", { value: "lantern" }, ctx);
    await run("game_state_flag", { value: "gate_opened" }, ctx);
    await run("game_state_move", { value: "Echo Chamber" }, ctx);
    await run("game_state_score", { value: 7 }, ctx);
    for (let i = 0; i < REPORTED_HISTORY + 3; i++) {
      await run("game_state_history", { value: `command ${i}` }, ctx);
    }

    expect(await run("game_state_get", ctx)).toEqual({
      currentRoom: "Echo Chamber",
      inventory: ["lantern"],
      score: 7,
      moves: REPORTED_HISTORY + 4,
      flags: { gate_opened: true },
      recentHistory: Array.from({ length: REPORTED_HISTORY }, (_, i) => `command ${i + 3}`),
    });
  });

  test("restart replaces the whole game, and the fresh room is the one the greeting describes", async () => {
    const ctx = makeCtx();
    await run("game_state_take", { value: "lantern" }, ctx);
    await run("game_state_score", { value: 30 }, ctx);
    await run("game_state_move", { value: "Echo Chamber" }, ctx);

    const restarted = (await run("game_state_restart", ctx)) as {
      restarted: boolean;
      currentRoom: string;
    };
    expect(restarted).toEqual({ restarted: true, currentRoom: DEFAULT_GAME_STATE.currentRoom });
    expect(gameSlot.get(ctx)).toEqual(DEFAULT_GAME_STATE);
  });
});

describe("the game is per context", () => {
  test("a second playthrough starts empty and cannot see the first", async () => {
    // What this really checks: the state lives in the SLOT and not in a
    // module-level variable. `createToolContext()` hands each call its own
    // detached slot store, so the isolation is per CONTEXT — two distinct
    // session ids would prove nothing extra, and `sessionSlot` could stop
    // keying by session with this still passing.
    const one = makeCtx();
    const two = makeCtx();

    await run("game_state_take", { value: "lantern" }, one);
    await run("game_state_move", { value: "Echo Chamber" }, one);

    expect(gameSlot.get(two)).toEqual(DEFAULT_GAME_STATE);
    await run("game_state_take", { value: "rope" }, two);
    expect(gameSlot.get(one).inventory).toEqual(["lantern"]);
    expect(gameSlot.get(two).inventory).toEqual(["rope"]);
  });

  test("the module-level default is cloned, so no session can edit the next one's start", async () => {
    const ctx = makeCtx();
    await run("game_state_take", { value: "lantern" }, ctx);
    expect(DEFAULT_GAME_STATE.inventory).toEqual([]);
  });
});
