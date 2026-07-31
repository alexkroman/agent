import type { Db, ToolContext } from "@alexkroman1/aai";
import { describe, expect, test, vi } from "vitest";
import {
  applyConsequences,
  DEFAULT_STATE,
  type GameState,
  getGameState,
  MAX_NPCS,
  MIN_MOMENTUM,
  makeNpc,
  rollAction,
  saveGameState,
} from "./shared.ts";
import { actionRoll } from "./tools/action_roll.ts";
import { burnMomentum } from "./tools/burn_momentum.ts";
import { checkState } from "./tools/check_state.ts";
import { loadGame } from "./tools/load_game.ts";
import { saveGame } from "./tools/save_game.ts";
import { setupCharacter } from "./tools/setup_character.ts";
import { updateState } from "./tools/update_state.ts";

// ── Test doubles ─────────────────────────────────────────────────────────────

/**
 * Map-backed fake of the app database, implementing exactly the three SQL
 * statements the shared save-slot helpers emit (create table / select /
 * upsert). Values are stored parsed, the way a postgres driver returns jsonb.
 */
function makeDb(): { db: Db; rows: Map<string, unknown> } {
  const rows = new Map<string, unknown>();
  const db: Db = {
    async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
      if (sql.startsWith("create table if not exists app_state")) return [];
      if (sql.startsWith("select value from app_state")) {
        const key = params[0] as string;
        return rows.has(key) ? ([{ value: structuredClone(rows.get(key)) }] as T[]) : [];
      }
      if (sql.startsWith("insert into app_state")) {
        const [key, json] = params as [string, string];
        rows.set(key, JSON.parse(json)); // $2::jsonb — parsed like postgres would
        return [];
      }
      throw new Error(`unexpected SQL in test: ${sql}`);
    },
  };
  return { db, rows };
}

function makeCtx(sessionId = "session-a", db: Db = makeDb().db): ToolContext {
  return {
    env: {},
    state: {},
    db,
    generate: () => Promise.reject(new Error("generate not available in tests")),
    messages: [],
    sessionId,
    send: vi.fn(),
  };
}

const SETUP_ARGS = {
  genre: "dark_fantasy",
  tone: "dark_gritty",
  archetype: "investigator",
  playerName: "Kael",
  characterConcept: "A haunted detective",
  settingDescription: "A city of fog and iron.",
  startingLocation: "The Docks",
  locationDesc: "Rotting piers under gaslight.",
  timeOfDay: "night" as const,
  openingSituation: "A body washes ashore bearing your family crest.",
  npc1Name: "Mira",
  npc1Desc: "A wary informant",
  npc1Disposition: "distrustful" as const,
  npc1Agenda: "Pay off her debts",
  threatClockName: "The Syndicate Closes In",
  threatClockDesc: "Assassins find the player",
};

function playingState(): GameState {
  const state = structuredClone(DEFAULT_STATE);
  state.initialized = true;
  state.phase = "playing";
  state.sceneCount = 3;
  state.npcs.push(makeNpc({ id: "npc_1", name: "Mira", disposition: "neutral" }));
  state.clocks.push({
    id: "clock_1",
    name: "Doom",
    clockType: "threat",
    segments: 4,
    filled: 0,
    triggerDescription: "The doom arrives",
  });
  return state;
}

// ── setup_character ──────────────────────────────────────────────────────────

describe("setup_character", () => {
  test("running setup twice starts fresh: no duplicate ids, no stale resources, truthful return", async () => {
    const ctx = makeCtx();

    await setupCharacter.execute(SETUP_ARGS, ctx);

    // Simulate a played, damaged game between setups.
    const played = getGameState(ctx);
    played.health = 1;
    played.momentum = -4;
    played.chaosFactor = 8;
    played.sceneCount = 42;
    saveGameState(ctx, played);

    const result = (await setupCharacter.execute(
      { ...SETUP_ARGS, playerName: "Luna" },
      ctx,
    )) as Record<string, unknown>;

    const state = getGameState(ctx);
    expect(state.npcs).toHaveLength(1);
    expect(state.npcs[0]?.id).toBe("npc_1");
    expect(state.clocks).toHaveLength(1);
    expect(state.clocks[0]?.id).toBe("clock_1");
    expect(state.playerName).toBe("Luna");
    expect(state.health).toBe(5);
    expect(state.momentum).toBe(2);
    expect(state.chaosFactor).toBe(5);
    expect(state.sceneCount).toBe(1);
    expect(state.sessionLog).toHaveLength(0);

    // The return value reports the REAL saved state, not hardcoded numbers.
    expect(result.health).toBe(state.health);
    expect(result.momentum).toBe(state.momentum);
    expect(result.chaosFactor).toBe(state.chaosFactor);
    expect(result.playerName).toBe("Luna");
  });

  test("stats are a permutation of [3,2,2,1,1] with the archetype's stat at 3", async () => {
    const ctx = makeCtx();
    await setupCharacter.execute(SETUP_ARGS, ctx);
    const state = getGameState(ctx);
    const stats = [state.edge, state.heart, state.iron, state.shadow, state.wits];
    expect([...stats].sort()).toEqual([1, 1, 2, 2, 3]);
    // investigator biases wits (index 4) to the high stat
    expect(state.wits).toBe(3);
  });

  test("game state is scoped per session — a second session sees a fresh game", async () => {
    await setupCharacter.execute(SETUP_ARGS, makeCtx("session-a"));
    // ctx.state is per-session by construction — a new session, a new game.
    const other = (await checkState.execute({} as never, makeCtx("session-b"))) as {
      initialized: boolean;
    };
    expect(other.initialized).toBe(false);
  });
});

// ── applyConsequences ────────────────────────────────────────────────────────

describe("applyConsequences MISS matrix", () => {
  const miss = { result: "MISS" as const, move: "clash" };

  test("combat miss scales damage by position and ticks the threat clock", () => {
    for (const [position, dmg, ticks] of [
      ["controlled", 1, 1],
      ["risky", 2, 1],
      ["desperate", 3, 2],
    ] as const) {
      const state = playingState();
      const { deltas, clockEvents } = applyConsequences(state, miss, position, "standard", null);
      expect(state.health).toBe(5 - dmg);
      expect(deltas.health).toBe(-dmg);
      expect(state.clocks[0]?.filled).toBe(ticks);
      expect(deltas.clockTicks).toBe(ticks);
      expect(clockEvents).toHaveLength(0); // 4-segment clock not full yet
    }
  });

  test("momentum loss is floored at MIN_MOMENTUM and deltas record the actual change", () => {
    const state = playingState();
    state.momentum = -5;
    const { deltas } = applyConsequences(state, miss, "desperate", "standard", null);
    expect(state.momentum).toBe(MIN_MOMENTUM); // -5 - 3 clamps to -6
    expect(deltas.momentum).toBe(-1);
  });

  test("social miss with a target drops bond (floored at 0) and spirit", () => {
    const state = playingState();
    state.npcs[0]!.bond = 0;
    const { deltas } = applyConsequences(
      state,
      { result: "MISS", move: "compel" },
      "risky",
      "standard",
      "npc_1",
    );
    expect(state.npcs[0]?.bond).toBe(0);
    expect(deltas.bond).toBe(0); // already at floor — nothing actually applied
    expect(state.spirit).toBe(4);
  });

  test("filling the threat clock emits its trigger event and crisis flags fire at 0 health", () => {
    const state = playingState();
    state.clocks[0]!.filled = 3; // one tick from full
    state.health = 2;
    const { clockEvents } = applyConsequences(state, miss, "risky", "standard", null);
    expect(clockEvents).toEqual([{ clock: "Doom", trigger: "The doom arrives" }]);
    expect(state.health).toBe(0);
    expect(state.crisisMode).toBe(true);
    expect(state.gameOver).toBe(false);
  });

  test("strong hit with great effect gains +3 momentum and shifts disposition on compel", () => {
    const state = playingState();
    const { deltas } = applyConsequences(
      state,
      { result: "STRONG_HIT", move: "compel" },
      "risky",
      "great",
      "npc_1",
    );
    expect(state.momentum).toBe(5);
    expect(deltas.momentum).toBe(3);
    expect(state.npcs[0]?.disposition).toBe("friendly");
    expect(deltas.dispositionFrom).toBe("neutral");
    expect(state.npcs[0]?.bond).toBe(1);
  });
});

// ── burn_momentum ────────────────────────────────────────────────────────────

describe("burn_momentum", () => {
  function seedRolledState(momentum: number, ctx: ToolContext) {
    const state = playingState();
    // A MISS was applied: health -2, momentum -2, clock +1.
    state.health = 3;
    state.clocks[0]!.filled = 1;
    state.momentum = momentum;
    state.lastRoll = {
      d1: 2,
      d2: 2,
      c1: 3,
      c2: 5,
      statName: "iron",
      statValue: 2,
      actionScore: 6,
      result: "MISS",
      move: "clash",
      match: false,
      position: "risky",
      effect: "standard",
      targetNpcId: null,
      deltas: {
        health: -2,
        spirit: 0,
        supply: 0,
        momentum: -2,
        npcId: null,
        bond: 0,
        dispositionFrom: null,
        dispositionTo: null,
        clockId: "clock_1",
        clockTicks: 1,
      },
    };
    saveGameState(ctx, state);
  }

  test("a legal burn reverts the miss's consequences, upgrades, and resets momentum", async () => {
    const ctx = makeCtx();
    seedRolledState(8, ctx); // 8 beats both dice (3, 5)

    const result = (await burnMomentum.execute({} as never, ctx)) as Record<string, unknown>;
    expect(result.burned).toBe(true);
    expect(result.newResultCode).toBe("STRONG_HIT");

    const state = getGameState(ctx);
    expect(state.health).toBe(5); // -2 reverted
    expect(state.clocks[0]?.filled).toBe(0); // tick reverted
    expect(state.momentum).toBe(2); // reset, overriding the strong hit's gain
    expect(state.lastRoll).toBeNull();
  });

  test("momentum beating only one die upgrades a MISS to WEAK_HIT", async () => {
    const ctx = makeCtx();
    seedRolledState(4, ctx); // beats 3, not 5
    const result = (await burnMomentum.execute({} as never, ctx)) as Record<string, unknown>;
    expect(result.newResultCode).toBe("WEAK_HIT");
  });

  test("burn is refused with no stored roll, insufficient momentum, or a strong hit", async () => {
    const ctx = makeCtx();

    // No roll yet
    let result = (await burnMomentum.execute({} as never, ctx)) as Record<string, unknown>;
    expect(result.error).toMatch(/No recent action roll/);

    // Momentum too low to beat either die
    seedRolledState(2, ctx);
    result = (await burnMomentum.execute({} as never, ctx)) as Record<string, unknown>;
    expect(result.error).toMatch(/not high enough/);

    // Strong hits cannot be upgraded
    seedRolledState(8, ctx);
    const state = getGameState(ctx);
    state.lastRoll!.result = "STRONG_HIT";
    saveGameState(ctx, state);
    result = (await burnMomentum.execute({} as never, ctx)) as Record<string, unknown>;
    expect(result.error).toMatch(/already a Strong Hit/);
  });

  test("action_roll persists the roll so burn needs no dice arguments", async () => {
    const ctx = makeCtx();
    saveGameState(ctx, playingState());
    await actionRoll.execute(
      { move: "clash", stat: "iron", position: "risky", effect: "standard", purpose: "attack" },
      ctx,
    );
    const state = getGameState(ctx);
    expect(state.lastRoll).not.toBeNull();
    expect(state.lastRoll?.move).toBe("clash");
    expect(state.lastRoll?.deltas).toBeDefined();
  });
});

// ── rollAction dice boundaries ───────────────────────────────────────────────

describe("rollAction", () => {
  // Math.random call order inside rollAction: d1, d2, c1, c2.
  function mockDice(d1: number, d2: number, c1: number, c2: number) {
    const spy = vi.spyOn(Math, "random");
    for (const [value, sides] of [
      [d1, 6],
      [d2, 6],
      [c1, 10],
      [c2, 10],
    ] as const) {
      spy.mockReturnValueOnce((value - 0.5) / sides);
    }
    return spy;
  }

  test("tying a challenge die is NOT a beat — equal on both dice is a MISS with match", () => {
    mockDice(3, 3, 8, 8); // action score 3+3+2 = 8 vs 8, 8
    const roll = rollAction("wits", 2, "face_danger");
    expect(roll.actionScore).toBe(8);
    expect(roll.result).toBe("MISS");
    expect(roll.match).toBe(true);
  });

  test("action score caps at 10 even when dice + stat exceed it", () => {
    mockDice(6, 6, 1, 1); // 6+6+4 = 16 → capped to 10
    const roll = rollAction("iron", 4, "clash");
    expect(roll.actionScore).toBe(10);
    expect(roll.result).toBe("STRONG_HIT");
  });

  test("beating exactly one die is a WEAK_HIT", () => {
    mockDice(4, 2, 5, 9); // 4+2+2 = 8: beats 5, not 9
    const roll = rollAction("edge", 2, "face_danger");
    expect(roll.result).toBe("WEAK_HIT");
    expect(roll.match).toBe(false);
  });
});

// ── update_state: clocks, caps, validation ───────────────────────────────────

describe("update_state", () => {
  test("clock ids never collide after a removal (max-scan, not length+1)", async () => {
    const ctx = makeCtx();
    saveGameState(ctx, playingState()); // has clock_1

    await updateState.execute({ addClockName: "Second" }, ctx); // clock_2
    await updateState.execute({ removeClockName: "Doom" }, ctx); // removes clock_1
    await updateState.execute({ addClockName: "Third" }, ctx);

    const state = getGameState(ctx);
    const ids = state.clocks.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(["clock_2", "clock_3"]);
  });

  test("advancing a clock to full reports its trigger event", async () => {
    const ctx = makeCtx();
    const state = playingState();
    state.clocks[0]!.filled = 3; // 3 of 4
    saveGameState(ctx, state);

    const result = (await updateState.execute({ advanceClockName: "Doom" }, ctx)) as {
      clockEvents: { clock: string; trigger: string }[];
    };
    expect(result.clockEvents).toEqual([{ clock: "Doom", trigger: "The doom arrives" }]);
  });

  test("NPC count is capped at MAX_NPCS with a warning", async () => {
    const ctx = makeCtx();
    const state = playingState();
    while (state.npcs.length < MAX_NPCS) {
      state.npcs.push(makeNpc({ id: `npc_${state.npcs.length + 1}`, name: "Extra" }));
    }
    saveGameState(ctx, state);

    const result = (await updateState.execute({ addNpcName: "One Too Many" }, ctx)) as {
      warnings?: string[];
    };
    expect(result.warnings?.[0]).toMatch(/NPC limit/);
    const after = getGameState(ctx);
    expect(after.npcs).toHaveLength(MAX_NPCS);
  });

  test("zod schemas reject out-of-range and malformed inputs", () => {
    const params = updateState.parameters!;
    expect(() => params.parse({ addClockSegments: 1 })).toThrow(); // below min
    expect(() => params.parse({ addClockSegments: 13 })).toThrow(); // above max
    expect(() => params.parse({ addClockSegments: 2.5 })).toThrow(); // non-integer
    expect(() => params.parse({ updateNpcBond: 5 })).toThrow(); // above MAX_BOND
    expect(() => params.parse({ updateNpcBond: -1 })).toThrow();
    expect(() => params.parse({ timeOfDay: "noonish" })).toThrow(); // not a phase
    expect(
      params.parse({ addClockSegments: 6, updateNpcBond: 4, timeOfDay: "night" }),
    ).toBeTruthy();

    const slotParams = saveGame.parameters!;
    expect(() => slotParams.parse({ slot: "../../etc" })).toThrow();
    expect(() => slotParams.parse({ slot: "a".repeat(40) })).toThrow();
    expect(slotParams.parse({ slot: "chapter-2" })).toBeTruthy();
  });
});

// ── save_game / load_game: cross-session persistence via ctx.db ──────────────

describe("save_game / load_game", () => {
  test("a save made in one session loads in a later session", async () => {
    const { db, rows } = makeDb();

    // Session A plays and saves.
    const sessionA = makeCtx("session-a", db);
    const played = playingState();
    played.playerName = "Kael";
    played.sceneCount = 7;
    saveGameState(sessionA, played);
    const saved = (await saveGame.execute({ slot: "chapter-2" }, sessionA)) as Record<
      string,
      unknown
    >;
    expect(saved.saved).toBe(true);
    expect(saved.slot).toBe("chapter-2");
    expect(rows.get("save:chapter-2")).toMatchObject({ playerName: "Kael", sceneCount: 7 });

    // Session B (fresh ctx.state, same app db) resumes it.
    const sessionB = makeCtx("session-b", db);
    const loaded = (await loadGame.execute({ slot: "chapter-2" }, sessionB)) as Record<
      string,
      unknown
    >;
    expect(loaded.loaded).toBe(true);
    expect(loaded.playerName).toBe("Kael");
    expect(loaded.sceneCount).toBe(7);
    expect(getGameState(sessionB).playerName).toBe("Kael");
  });

  test("loading a missing slot reports an error instead of resetting the game", async () => {
    const ctx = makeCtx();
    const result = (await loadGame.execute({ slot: "nope" }, ctx)) as { error?: string };
    expect(result.error).toMatch(/No save found/);
  });

  test("saving twice to one slot upserts — the newer save wins", async () => {
    const { db, rows } = makeDb();
    const ctx = makeCtx("session-a", db);
    saveGameState(ctx, playingState());
    await saveGame.execute({}, ctx); // autosave
    getGameState(ctx).sceneCount = 9;
    await saveGame.execute({}, ctx);
    expect(rows.size).toBe(1);
    expect(rows.get("save:autosave")).toMatchObject({ sceneCount: 9 });
  });
});
