/** The def a DEPLOYED agent runs: authored, plus what `tools/` declares. */
import agentDef from "virtual:aai/agent";
import {
  type AgentSessionContext,
  createSeededRandom,
  type RandomSource,
  type SessionEventContext,
} from "@alexkroman1/aai";
import { createToolContext, parseToolInput, toolOf, toolRunner } from "@alexkroman1/aai/testing";
import { isToolFailure } from "@alexkroman1/aai/utils";
import { describe, expect, test } from "vitest";

import {
  DEFAULT_GAME_STATE,
  gameSlot,
  gameStatus,
  MAX_HISTORY,
  REPORTED_HISTORY,
  rankFor,
  SCAVENGER_FLAG,
  statusBlock,
  statusLine,
} from "./shared.ts";

/** A tool by the name the model calls it by, bound to this agent. */
const run = toolRunner(agentDef);

/**
 * What a tool answered, or a throw naming the refusal.
 *
 * NOT `expectToolOk`: that one unwraps a `dialog()` envelope (`{ result, state,
 * done }`) and throws on a plain tool's own return value, so it does not fit an
 * agent with no dialog. What carries over is the reason it exists — a cast
 * reads `undefined` off a `ToolFailure` and dies three assertions later, with
 * the sentence the tool wrote thrown away. `game_state_drop` can refuse now, so
 * every unwrap in this file goes through the guard rather than through `as`.
 */
const ok = <T>(result: unknown): T => {
  if (isToolFailure(result)) throw new Error(`tool refused: ${result.error}`);
  return result as T;
};

/**
 * What the player said, delivered the way the RUNTIME delivers it.
 *
 * A session event handler is a plain function on the def, so a template can
 * drive one with no harness — which is the point of asserting on it here rather
 * than trusting the wiring: `moves` and `history` are now maintained by
 * something the model never calls, so nothing else in this file would notice if
 * the hook stopped running.
 *
 * `SessionEventContext`, not `ToolContext`, because that is what the runtime
 * hands a hook: the session id, the env and the slots, and nothing that could
 * speak. A `TestToolContext` satisfies it, so the same `ctx` drives the tools
 * below.
 */
const say = (text: string, ctx: SessionEventContext) =>
  agentDef.events?.["user-transcript.committed"]?.(
    { type: "user-transcript.committed", text, meta: { id: "evt_1", at: 0 } },
    ctx,
  );

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
    const ctx = createToolContext();

    const first = ok<{ inventory: string[] }>(
      await run("game_state_take", { value: "lantern" }, ctx),
    );
    expect(first.inventory).toEqual(["lantern"]);
    // The stored value, not the one the body returned — a body handed a frozen
    // value would have thrown, and a body handed a copy nothing stores would
    // report success here and leave the slot empty.
    expect(gameSlot.get(ctx).inventory).toEqual(["lantern"]);

    const again = ok<{ inventory: string[] }>(
      await run("game_state_take", { value: "lantern" }, ctx),
    );
    expect(again.inventory).toEqual(["lantern"]);
  });

  test("game_state_flag records a flag, and a second flag joins the first", async () => {
    const ctx = createToolContext();

    await run("game_state_flag", { value: "gate_opened" }, ctx);
    const both = ok<{ flags: Record<string, boolean> }>(
      await run("game_state_flag", { value: "rope_cut" }, ctx),
    );

    expect(both.flags).toEqual({ gate_opened: true, rope_cut: true });
    expect(gameSlot.get(ctx).flags).toEqual({ gate_opened: true, rope_cut: true });
  });

  test("what a READ is handed is frozen, which is why the two above are updateTool", async () => {
    const ctx = createToolContext();
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
  test("drop removes an item, and refuses one the player never took", async () => {
    const ctx = createToolContext();
    await run("game_state_take", { value: "lantern" }, ctx);
    await run("game_state_take", { value: "rope" }, ctx);

    const dropped = ok<{ inventory: string[] }>(
      await run("game_state_drop", { value: "lantern" }, ctx),
    );
    expect(dropped.inventory).toEqual(["rope"]);

    // A `ToolFailure`, not a silent no-op reporting the unchanged inventory:
    // the narrator is told the sentence rather than being left to diff a list.
    const refused = await run("game_state_drop", { value: "sword" }, ctx);
    expect(isToolFailure(refused) && refused.error).toMatch(/not carrying sword/);
    expect(gameSlot.get(ctx).inventory).toEqual(["rope"]);
  });

  test("move sets the room and reports the turn count without touching it", async () => {
    const ctx = createToolContext();
    const moved = ok<{ currentRoom: string; moves: number }>(
      await run("game_state_move", { value: "Echo Chamber" }, ctx),
    );
    // `moves` is 0 because nobody has SAID anything — see `recordTurn`. It is
    // still reported, because it is what the narrator wants back.
    expect(moved).toEqual({ currentRoom: "Echo Chamber", moves: 0 });
    expect(gameSlot.get(ctx).currentRoom).toBe("Echo Chamber");
  });

  test("score accumulates rather than replacing", async () => {
    const ctx = createToolContext();
    await run("game_state_score", { value: 10 }, ctx);
    const total = ok<{ score: number }>(await run("game_state_score", { value: 5 }, ctx));
    expect(total.score).toBe(15);
  });

  test("what the player SAYS logs the command and counts the turn", async () => {
    const ctx = createToolContext();
    for (let i = 1; i <= REPORTED_HISTORY + 2; i++) say(`command ${i}`, ctx);
    say("look", ctx);

    const game = gameSlot.get(ctx);
    expect(game.moves).toBe(REPORTED_HISTORY + 3);
    expect(game.history.at(-1)).toBe("look");

    // And the narrator reads it back through the ordinary state tool — the hook
    // writes, the model reads, and the two never have to agree about who counts.
    const read = ok<{ moves: number; recentHistory: string[] }>(
      await run("game_state_get", {}, ctx),
    );
    expect(read.moves).toBe(REPORTED_HISTORY + 3);
    expect(read.recentHistory).toHaveLength(REPORTED_HISTORY);
  });

  test("a turn is counted once, even when the narrator also moves the player", async () => {
    const ctx = createToolContext();
    say("go north", ctx);
    await run("game_state_move", { value: "Echo Chamber" }, ctx);

    // Both used to bump `moves`, so this turn scored 2 — and a turn where the
    // narrator called neither scored 0. A move is a room change; a turn is the
    // player saying something.
    const game = gameSlot.get(ctx);
    expect(game.moves).toBe(1);
    expect(game.currentRoom).toBe("Echo Chamber");
  });

  test("the history is capped, so a long playthrough does not grow without bound", () => {
    const ctx = createToolContext();
    for (let i = 0; i < MAX_HISTORY + 10; i++) say(`command ${i}`, ctx);

    const game = gameSlot.get(ctx);
    expect(game.history).toHaveLength(MAX_HISTORY);
    // The cap drops the OLDEST — the newest command is the one a narrator needs.
    expect(game.history.at(-1)).toBe(`command ${MAX_HISTORY + 9}`);
    expect(game.moves).toBe(MAX_HISTORY + 10);
  });

  test("get reports the whole board, with the history trimmed to what a narrator reads", async () => {
    const ctx = createToolContext();
    await run("game_state_take", { value: "lantern" }, ctx);
    await run("game_state_flag", { value: "gate_opened" }, ctx);
    await run("game_state_move", { value: "Echo Chamber" }, ctx);
    await run("game_state_score", { value: 7 }, ctx);
    for (let i = 0; i < REPORTED_HISTORY + 3; i++) say(`command ${i}`, ctx);

    expect(await run("game_state_get", ctx)).toEqual({
      currentRoom: "Echo Chamber",
      score: 7,
      rank: "Beginner",
      moves: REPORTED_HISTORY + 3,
      inventory: ["lantern"],
      flags: { gate_opened: true },
      recentHistory: Array.from({ length: REPORTED_HISTORY }, (_, i) => `command ${i + 3}`),
    });
  });

  test("restart replaces the whole game, and the fresh room is the one the greeting describes", async () => {
    const ctx = createToolContext();
    await run("game_state_take", { value: "lantern" }, ctx);
    await run("game_state_score", { value: 30 }, ctx);
    await run("game_state_move", { value: "Echo Chamber" }, ctx);

    const restarted = ok<{ restarted: boolean; currentRoom: string }>(
      await run("game_state_restart", ctx),
    );
    expect(restarted).toEqual({ restarted: true, currentRoom: DEFAULT_GAME_STATE.currentRoom });
    expect(gameSlot.get(ctx)).toEqual(DEFAULT_GAME_STATE);
  });

  test("the schemas say what a spoken argument has to be turned into", async () => {
    // Points are a NUMBER: the model has to turn what it heard into one, and a
    // schema that took a string would let "ten" reach `game.score +=`.
    expect(await parseToolInput(agentDef, "game_state_score", { value: 10 })).toEqual({
      value: 10,
    });
    await expect(parseToolInput(agentDef, "game_state_score", { value: "ten" })).rejects.toThrow();

    // And the read takes nothing at all, which is what makes the two-argument
    // `run("game_state_get", ctx)` form above legal.
    expect(toolOf(agentDef, "game_state_get").inputSchema).toBeUndefined();
  });
});

// ─── The rank is DERIVED, and the scavenger is a DIE ROLL ────────────────────

describe("what the game works out for itself", () => {
  test("the rank follows the score, and no tool writes it", async () => {
    const ctx = createToolContext();
    expect(gameSlot.get(ctx).rank).toBe("Beginner");

    // The tool that carried the player over the threshold reports the rank it
    // EARNED, not the one it had. `after` runs after the body, so a result
    // built from `game.rank` would announce this promotion one call late — the
    // whole reason `rankFor` is a predicate the writer can call.
    const scored = ok<{ score: number; rank: string }>(
      await run("game_state_score", { value: 30 }, ctx),
    );
    expect(scored).toEqual({ score: 30, rank: "Amateur Adventurer" });
    expect(gameSlot.get(ctx).rank).toBe("Amateur Adventurer");

    // And the hook owns the write, so any later mutation leaves it consistent —
    // including one that has nothing to do with the score.
    await run("game_state_take", { value: "chalice" }, ctx);
    expect(gameSlot.get(ctx).rank).toBe(rankFor(gameSlot.get(ctx).score));
  });

  test("rankFor is a ladder, and the bottom rung is what a fresh game starts on", () => {
    expect(rankFor(0)).toBe("Beginner");
    expect(rankFor(24)).toBe("Beginner");
    expect(rankFor(25)).toBe("Amateur Adventurer");
    expect(rankFor(999)).toBe("Wizard");
    expect(DEFAULT_GAME_STATE.rank).toBe(rankFor(DEFAULT_GAME_STATE.score));
  });

  test("the scavenger's threshold is a number the spec can state", async () => {
    const always = createToolContext({ random: () => 0 });
    await run("game_state_take", { value: "scarab" }, always);
    const taken = ok<{ takenByScavenger: boolean }>(
      await run("game_state_drop", { value: "scarab" }, always),
    );
    expect(taken.takenByScavenger).toBe(true);
    expect(gameSlot.get(always).flags[SCAVENGER_FLAG]).toBe(true);

    // A source that returns exactly 1 is outside `Math.random`'s contract and
    // well inside what a stub does — the comparison has to leave it out.
    const never = createToolContext({ random: () => 1 });
    await run("game_state_take", { value: "scarab" }, never);
    const kept = ok<{ takenByScavenger: boolean }>(
      await run("game_state_drop", { value: "scarab" }, never),
    );
    expect(kept.takenByScavenger).toBe(false);
    expect(gameSlot.get(never).flags[SCAVENGER_FLAG]).toBeUndefined();
  });

  test("one seed is one adventure: the same stream robs the player the same way", async () => {
    // A SEEDED source rather than a constant one. `() => 0.5` looks like the
    // simplest deterministic stub and is degenerate — every draw identical, so
    // the scavenger either never appears or always does, and nothing about the
    // mechanic is under test. `createSeededRandom` is a real stream that
    // repeats, which is what makes "the same seed plays the same game" an
    // assertion rather than a hope.
    const drops = 12;
    const playthrough = async (random: RandomSource): Promise<boolean[]> => {
      const ctx = createToolContext({ random });
      const struck: boolean[] = [];
      for (let i = 0; i < drops; i++) {
        await run("game_state_take", { value: `treasure ${i}` }, ctx);
        const dropped = ok<{ takenByScavenger: boolean }>(
          await run("game_state_drop", { value: `treasure ${i}` }, ctx),
        );
        struck.push(dropped.takenByScavenger);
      }
      return struck;
    };

    const first = await playthrough(createSeededRandom(7));
    expect(await playthrough(createSeededRandom(7))).toEqual(first);
    // Both outcomes really occur, so the assertion above is about a stream and
    // not about a constant that never trips the threshold.
    expect([...new Set(first)].sort()).toEqual([false, true]);
    expect(await playthrough(createSeededRandom(8))).not.toEqual(first);
  });
});

// ─── One status line, two readers ────────────────────────────────────────────

describe("the status line", () => {
  test("the opening frame agrees with the greeting, before anything is stored", () => {
    // What a client renders on a session that has not touched the slot: the
    // projection calls the slot's own `create()`, so the CRT's top bar shows
    // the cave mouth the greeting describes rather than an empty frame.
    expect(gameStatus()).toEqual({
      currentRoom: DEFAULT_GAME_STATE.currentRoom,
      score: 0,
      rank: "Beginner",
      moves: 0,
    });
  });

  test("the narrator and the screen are told the same four things", async () => {
    const ctx = createToolContext();
    say("go down to the hall", ctx);
    await run("game_state_move", { value: "Echoing Hall" }, ctx);
    await run("game_state_score", { value: 60 }, ctx);

    const board = ok<Record<string, unknown>>(await run("game_state_get", ctx));
    const bar = statusLine(gameSlot.get(ctx));

    expect(bar).toEqual({
      currentRoom: "Echoing Hall",
      score: 60,
      rank: "Novice Adventurer",
      moves: 1,
    });
    // `game_state_get` spreads the same helper, so the two cannot drift.
    expect(board).toMatchObject(bar);
  });
});

describe("the game is per context", () => {
  test("a second playthrough starts empty and cannot see the first", async () => {
    // What this really checks: the state lives in the SLOT and not in a
    // module-level variable. `createToolContext()` hands each call its own
    // detached slot store, so the isolation is per CONTEXT — two distinct
    // session ids would prove nothing extra, and `sessionSlot` could stop
    // keying by session with this still passing.
    const one = createToolContext();
    const two = createToolContext();

    await run("game_state_take", { value: "lantern" }, one);
    await run("game_state_move", { value: "Echo Chamber" }, one);

    expect(gameSlot.get(two)).toEqual(DEFAULT_GAME_STATE);
    await run("game_state_take", { value: "rope" }, two);
    expect(gameSlot.get(one).inventory).toEqual(["lantern"]);
    expect(gameSlot.get(two).inventory).toEqual(["rope"]);
  });

  test("the module-level default is cloned, so no session can edit the next one's start", async () => {
    const ctx = createToolContext();
    await run("game_state_take", { value: "lantern" }, ctx);
    expect(DEFAULT_GAME_STATE.inventory).toEqual([]);
  });
});

// ─── The prompt carries the board ────────────────────────────────────────────
//
// `systemPrompt` is a RESOLVER here, not a string: `system-prompt.md` supplies
// the world and the voice rules, and `statusBlock` appends the live board to
// them before every model request. What that replaced was six lines of prompt
// ordering the narrator to call `game_state_get` before answering any question
// about where the player is or what they hold — advice, enforced by nothing,
// and a model round trip on every turn it was obeyed on.

describe("the prompt the narrator is actually given", () => {
  /** The def's resolver, which is what a request assembles the instructions from. */
  const resolve = (ctx: AgentSessionContext): string => {
    const prompt = agentDef.systemPrompt;
    if (typeof prompt !== "function") throw new Error("systemPrompt is not a resolver");
    return prompt(ctx);
  };

  test("it is a resolver, and the file's prose survives into it", () => {
    // The build discovers `system-prompt.md` and hands it to `withSystemPrompt`,
    // which leaves a resolver exactly as written — so the file has to reach the
    // model through the resolver's own import, and this is what proves it does.
    expect(typeof agentDef.systemPrompt).toBe("function");
    expect(resolve(createToolContext())).toContain("CAVERN ADVENTURE");
  });

  test("a fresh session is told the opening board, before any tool has run", () => {
    const opening = resolve(createToolContext());
    expect(opening).toContain(`- Location: ${DEFAULT_GAME_STATE.currentRoom}`);
    expect(opening).toContain("- Score: 0 (Beginner)");
    expect(opening).toContain("- Turns taken: 0");
    expect(opening).toContain("- Carrying: nothing");
  });

  test("every mutation is in the NEXT request's prompt, with no tool call in between", async () => {
    const ctx = createToolContext();
    await run("game_state_take", { value: "lantern" }, ctx);
    await run("game_state_move", { value: "Echoing Hall" }, ctx);
    await run("game_state_score", { value: 30 }, ctx);
    say("go down to the hall", ctx);

    const now = resolve(ctx);
    expect(now).toContain("- Location: Echoing Hall");
    expect(now).toContain("- Score: 30 (Amateur Adventurer)");
    expect(now).toContain("- Turns taken: 1");
    expect(now).toContain("- Carrying: lantern");
  });

  test("the block is built from the same status line the CRT and the read tool get", async () => {
    const ctx = createToolContext();
    await run("game_state_move", { value: "Crystal Grotto" }, ctx);
    await run("game_state_score", { value: 60 }, ctx);

    // One helper, three readers: `syncState`, `game_state_get`, and the prompt.
    // A fourth rendering of these four numbers is a fourth thing to drift.
    expect(resolve(ctx).endsWith(statusBlock(gameSlot.get(ctx)))).toBe(true);
    const bar = statusLine(gameSlot.get(ctx));
    expect(resolve(ctx)).toContain(`- Score: ${bar.score} (${bar.rank})`);
  });

  test("each session is told its OWN board", async () => {
    // The resolver reads through `ctx.slots`, so it is per session for the same
    // reason every tool is — a resolver that closed over a module-level game
    // would put one player's inventory in another player's prompt.
    const one = createToolContext();
    const two = createToolContext();
    await run("game_state_take", { value: "jade idol" }, one);

    expect(resolve(one)).toContain("- Carrying: jade idol");
    expect(resolve(two)).toContain("- Carrying: nothing");
  });
});
