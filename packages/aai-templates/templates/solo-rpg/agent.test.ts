import type { ToolContext, ToolDef, ToolInputSchema } from "@alexkroman1/aai";
import { isToolFailure } from "@alexkroman1/aai";
import { createToolContext, ok } from "@alexkroman1/aai/testing";
import { describe, expect, test, vi } from "vitest";
import {
  applyConsequences,
  DEFAULT_STATE,
  type GameState,
  gameSlot,
  inCrisis,
  isGameOver,
  MAX_NPCS,
  MIN_MOMENTUM,
  makeNpc,
  rollAction,
  storyFlow,
} from "./shared.ts";
import actionRoll from "./tools/action_roll.ts";
import burnMomentum from "./tools/burn_momentum.ts";
import checkState from "./tools/check_state.ts";
import oracle from "./tools/oracle.ts";
import setupCharacter from "./tools/setup_character.ts";
import updateState from "./tools/update_state.ts";

// ── Test doubles ─────────────────────────────────────────────────────────────

/** Each call gets its own slot store, which is what makes two contexts two
 *  games. `send` is the recorder `createToolContext` installs — no test here
 *  asserts on it, and overriding it would only throw the recording away. */
function makeCtx(): ToolContext {
  return createToolContext();
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

/**
 * Seed a context with a mid-game campaign AND the matching flow position.
 *
 * Writing the slot alone is no longer enough: `action_roll`, `update_state`,
 * `burn_momentum` and `save_game` gate on `storyFlow`, so a campaign installed
 * behind the machine's back leaves every one of them refusing. That is the point
 * of the gate, and it is what this helper exists to satisfy honestly — through
 * the flow's own event, not by writing its snapshot.
 */
function seedPlaying(ctx: ToolContext, state: GameState = playingState()): GameState {
  gameSlot.set(ctx, state);
  storyFlow.send(ctx, { type: "SETUP" });
  return state;
}

/**
 * Call a tool that declares no `inputSchema`.
 *
 * `ToolDef["execute"]`'s first parameter is derived from the schema, so a tool
 * with none types it as a shape no object literal satisfies — and nine call
 * sites here had each cast their way past it. This is the one narrowing they all
 * wanted: `check_state` and `burn_momentum` really do take no arguments, and a
 * helper says that once where a cast per call site said nothing.
 *
 * It is generic in `R` because the three tool builders thread their result type
 * out now, so the ARGUMENT is the only thing here that needs laundering — where
 * every call site used to follow this one with a second cast of its own to
 * recover a return type the erasure had thrown away.
 */
function callNoArgs<R>(def: ToolDef<ToolInputSchema, R>, ctx: ToolContext): Promise<Awaited<R>> {
  return Promise.resolve((def.execute as (args: unknown, c: ToolContext) => R)({}, ctx));
}

// ── setup_character ──────────────────────────────────────────────────────────

describe("setup_character", () => {
  test("running setup twice starts fresh: no duplicate ids, no stale resources, truthful return", async () => {
    const ctx = makeCtx();

    await setupCharacter.execute(SETUP_ARGS, ctx);

    // Simulate a played, damaged game between setups.
    gameSlot.update(ctx, (played) => {
      played.health = 1;
      played.momentum = -4;
      played.chaosFactor = 8;
      played.sceneCount = 42;
    });

    const result = (await setupCharacter.execute(
      { ...SETUP_ARGS, playerName: "Luna" },
      ctx,
    )) as Record<string, unknown>;

    const state = gameSlot.get(ctx);
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
    const state = gameSlot.get(ctx);
    const stats = [state.edge, state.heart, state.iron, state.shadow, state.wits];
    expect([...stats].sort()).toEqual([1, 1, 2, 2, 3]);
    // investigator biases wits (index 4) to the high stat
    expect(state.wits).toBe(3);
  });

  test("a second, independent context sees a fresh game", async () => {
    // What this really checks: the state lives in the SLOT and not in a
    // module-level variable. `createToolContext()` hands each call its own
    // detached slot store, so the isolation is per CONTEXT — two distinct
    // session ids would prove nothing extra, and `sessionSlot` could stop
    // keying by session with this still passing.
    await setupCharacter.execute(SETUP_ARGS, makeCtx());
    const other = await callNoArgs(checkState, makeCtx());
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
      // Each row starts from a fresh state, so they are independent — assert
      // softly and a rebalanced table reports the whole matrix in one run.
      expect.soft(state.health, position).toBe(5 - dmg);
      expect.soft(deltas.health, position).toBe(-dmg);
      expect.soft(state.clocks[0]?.filled, position).toBe(ticks);
      expect.soft(deltas.clockTicks, position).toBe(ticks);
      expect.soft(clockEvents, position).toHaveLength(0); // 4-segment clock not full yet
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

  test("filling the threat clock emits its trigger event, and 0 health is a crisis", () => {
    const state = playingState();
    state.clocks[0]!.filled = 3; // one tick from full
    state.health = 2;
    const { clockEvents } = applyConsequences(state, miss, "risky", "standard", null);
    expect(clockEvents).toEqual([{ clock: "Doom", trigger: "The doom arrives" }]);
    expect(state.health).toBe(0);
    // The two flags are DERIVED now, not written here: `applyConsequences` used
    // to end with `updateCrisisFlags(game)`, one of three hand-placed calls
    // that are `gameSlot`'s `after` hook instead. So this asserts the rule
    // rather than the write — the flags on a stored game are checked through
    // the tools below, which is where a stale one would actually bite.
    expect(inCrisis(state)).toBe(true);
    expect(isGameOver(state)).toBe(false);
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
    seedPlaying(ctx, state);
    // The campaign records a roll, so the FLOW has to say one is standing —
    // `playing.rollResolved` is the state `burn_momentum` gates on. Sent as an
    // event rather than written into the snapshot, so the seed goes through the
    // same door `action_roll` does.
    storyFlow.send(ctx, { type: "ROLLED" });
  }

  test("a legal burn reverts the miss's consequences, upgrades, and resets momentum", async () => {
    const ctx = makeCtx();
    seedRolledState(8, ctx); // 8 beats both dice (3, 5)

    const result = ok<Record<string, unknown>>(await callNoArgs(burnMomentum, ctx));
    expect(result.burned).toBe(true);
    expect(result.newResultCode).toBe("STRONG_HIT");

    const state = gameSlot.get(ctx);
    expect(state.health).toBe(5); // -2 reverted
    expect(state.clocks[0]?.filled).toBe(0); // tick reverted
    expect(state.momentum).toBe(2); // reset, overriding the strong hit's gain
    expect(state.lastRoll).toBeNull();
  });

  test("momentum beating only one die upgrades a MISS to WEAK_HIT", async () => {
    const ctx = makeCtx();
    seedRolledState(4, ctx); // beats 3, not 5
    const result = ok<{ newResultCode: string }>(await callNoArgs(burnMomentum, ctx));
    expect(result.newResultCode).toBe("WEAK_HIT");
  });

  test("burn is refused with no roll standing, insufficient momentum, or a strong hit", async () => {
    const ctx = makeCtx();

    // No roll yet — and this refusal is now the FLOW's rather than a null check
    // inside the body: nothing has rolled, so the game is in
    // `playing.awaitingRoll` and this tool is not available there. The message
    // names the position and quotes what that state expects.
    seedPlaying(ctx);
    // The flow's refusal, so it arrives as a `ToolFailure` rather than under
    // the position envelope — which the narrowing now says out loud.
    let result = await callNoArgs(burnMomentum, ctx);
    expect(isToolFailure(result) && result.error).toMatch(/awaitingRoll/);
    expect(isToolFailure(result) && result.error).toMatch(/action_roll/);

    // Momentum too low to beat either die — a DATA rule, so it stays in the
    // body and the tool still runs.
    seedRolledState(2, ctx);
    result = await callNoArgs(burnMomentum, ctx);
    expect(isToolFailure(result) && result.error).toMatch(/not high enough/);

    // Strong hits cannot be upgraded
    seedRolledState(8, ctx);
    gameSlot.update(ctx, (state) => {
      state.lastRoll!.result = "STRONG_HIT";
    });
    result = await callNoArgs(burnMomentum, ctx);
    expect(isToolFailure(result) && result.error).toMatch(/already a Strong Hit/);
  });

  test("action_roll persists the roll so burn needs no dice arguments", async () => {
    const ctx = makeCtx();
    seedPlaying(ctx);
    await actionRoll.execute(
      { move: "clash", stat: "iron", position: "risky", effect: "standard", purpose: "attack" },
      ctx,
    );
    const state = gameSlot.get(ctx);
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

// ── oracle ───────────────────────────────────────────────────────────────────
//
// `chaos_check` is the one oracle branch that WRITES: `checkChaosInterrupt`
// lowers the chaos factor when the roll lands. It used to read the slot with
// `gameSlot.get` and assign to what came back, under a comment claiming the
// value was live — which described the removed `ctx.state` bag, not a slot. The
// stored value is deep-frozen, so ~1 call in 5 at the default chaos factor (and
// ~6 in 10 as it climbs) threw a `TypeError` instead of answering. These
// assertions are on the STORED value for that reason: a body writing to a
// private copy would pass every check on its own return value.

describe("oracle", () => {
  /** Force `d(sides)` to roll `value` on the next call. */
  function mockRoll(value: number, sides: number) {
    return vi.spyOn(Math, "random").mockReturnValue((value - 0.5) / sides);
  }

  test("a chaos interrupt that LANDS lowers the stored chaos factor", async () => {
    const ctx = makeCtx();
    const state = playingState();
    state.chaosFactor = 9; // threshold 6 — a roll of 1 lands
    seedPlaying(ctx, state);
    mockRoll(1, 10);

    const result = (await oracle.execute({ type: "chaos_check" }, ctx)) as {
      interrupted: boolean;
      interruptType: string | null;
      chaosFactor: number;
    };

    expect(result.interrupted).toBe(true);
    expect(result.interruptType).toBeTruthy();
    expect(result.chaosFactor).toBe(8);
    // The half the old code could not do: the write reached the slot.
    expect(gameSlot.get(ctx).chaosFactor).toBe(8);
  });

  test("the chaos factor floors at 3, where no roll is taken at all", async () => {
    const ctx = makeCtx();
    const state = playingState();
    state.chaosFactor = 3; // threshold 0 — `checkChaosInterrupt` returns early
    seedPlaying(ctx, state);

    const result = (await oracle.execute({ type: "chaos_check" }, ctx)) as {
      interrupted: boolean;
      chaosFactor: number;
    };
    expect(result.interrupted).toBe(false);
    expect(gameSlot.get(ctx).chaosFactor).toBe(3);
  });

  test("a chaos check that MISSES changes nothing", async () => {
    const ctx = makeCtx();
    const state = playingState();
    state.chaosFactor = 5; // threshold 2
    seedPlaying(ctx, state);
    mockRoll(10, 10); // past the threshold

    const result = (await oracle.execute({ type: "chaos_check" }, ctx)) as {
      interrupted: boolean;
      chaosFactor: number;
    };
    expect(result.interrupted).toBe(false);
    expect(result.chaosFactor).toBe(5);
    expect(gameSlot.get(ctx).chaosFactor).toBe(5);
  });

  test("a chaos check on an untouched session starts from the default factor", async () => {
    const ctx = makeCtx();
    mockRoll(1, 10); // DEFAULT_STATE.chaosFactor is 5, so threshold 2 — lands
    const result = (await oracle.execute({ type: "chaos_check" }, ctx)) as { chaosFactor: number };
    expect(result.chaosFactor).toBe(DEFAULT_STATE.chaosFactor - 1);
    expect(gameSlot.get(ctx).chaosFactor).toBe(DEFAULT_STATE.chaosFactor - 1);
  });

  test("yes_no maps the d6 onto its three answers", async () => {
    const ctx = makeCtx();
    for (const [roll, answer] of [
      [1, "No"],
      [2, "No"],
      [3, "Yes, but with a complication"],
      [4, "Yes, but with a complication"],
      [5, "Yes"],
      [6, "Yes"],
    ] as const) {
      mockRoll(roll, 6);
      const result = (await oracle.execute({ type: "yes_no" }, ctx)) as {
        roll: number;
        answer: string;
      };
      expect.soft(result, `roll ${roll}`).toEqual({ type: "yes_no", roll, answer });
    }
  });

  test("the four inspiration branches answer without touching the game", async () => {
    const ctx = makeCtx();
    seedPlaying(ctx);
    const before = structuredClone(gameSlot.get(ctx));

    const reaction = (await oracle.execute({ type: "npc_reaction" }, ctx)) as { reaction: string };
    const twist = (await oracle.execute({ type: "scene_twist" }, ctx)) as { twist: string };
    const theme = (await oracle.execute({ type: "action_theme" }, ctx)) as {
      action: string;
      theme: string;
      seed: string;
    };

    expect(reaction.reaction).toBeTruthy();
    expect(twist.twist).toBeTruthy();
    expect(theme.action).toBeTruthy();
    expect(theme.theme).toBeTruthy();
    expect(theme.seed.split(" ")).toHaveLength(3);
    expect(gameSlot.get(ctx)).toEqual(before);
  });
});

// ── update_state: clocks, caps, validation ───────────────────────────────────

describe("update_state", () => {
  test("clock ids never collide after a removal (max-scan, not length+1)", async () => {
    const ctx = makeCtx();
    seedPlaying(ctx); // has clock_1

    await updateState.execute({ addClockName: "Second" }, ctx); // clock_2
    await updateState.execute({ removeClockName: "Doom" }, ctx); // removes clock_1
    await updateState.execute({ addClockName: "Third" }, ctx);

    const state = gameSlot.get(ctx);
    const ids = state.clocks.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(["clock_2", "clock_3"]);
  });

  test("advancing a clock to full reports its trigger event", async () => {
    const ctx = makeCtx();
    const state = playingState();
    state.clocks[0]!.filled = 3; // 3 of 4
    seedPlaying(ctx, state);

    const result = ok<{ clockEvents: { clock: string; trigger: string }[] }>(
      await updateState.execute({ advanceClockName: "Doom" }, ctx),
    );
    expect(result.clockEvents).toEqual([{ clock: "Doom", trigger: "The doom arrives" }]);
  });

  test("NPC count is capped at MAX_NPCS with a warning", async () => {
    const ctx = makeCtx();
    const state = playingState();
    while (state.npcs.length < MAX_NPCS) {
      state.npcs.push(makeNpc({ id: `npc_${state.npcs.length + 1}`, name: "Extra" }));
    }
    seedPlaying(ctx, state);

    const result = ok<{ warnings?: string[] }>(
      await updateState.execute({ addNpcName: "One Too Many" }, ctx),
    );
    expect(result.warnings?.[0]).toMatch(/NPC limit/);
    const after = gameSlot.get(ctx);
    expect(after.npcs).toHaveLength(MAX_NPCS);
  });

  test("zod schemas reject out-of-range and malformed inputs", () => {
    const params = updateState.inputSchema!;
    expect(() => params.parse({ addClockSegments: 1 })).toThrow(); // below min
    expect(() => params.parse({ addClockSegments: 13 })).toThrow(); // above max
    expect(() => params.parse({ addClockSegments: 2.5 })).toThrow(); // non-integer
    expect(() => params.parse({ updateNpcBond: 5 })).toThrow(); // above MAX_BOND
    expect(() => params.parse({ updateNpcBond: -1 })).toThrow();
    expect(() => params.parse({ timeOfDay: "noonish" })).toThrow(); // not a phase
    expect(
      params.parse({ addClockSegments: 6, updateNpcBond: 4, timeOfDay: "night" }),
    ).toBeTruthy();
  });
});

// A `save_game / load_game` suite stood here, driving cross-session persistence
// through a map-backed fake of `ctx.db`. Both tools are gone: `ctx.db` is gone,
// and a shipped template cannot reach a database (see `shared.ts`). This
// adventure is single-session now.

// ── the story flow ───────────────────────────────────────────────────────────

describe("the story flow", () => {
  test("a fresh session is awaiting setup, and the play tools refuse there", async () => {
    const ctx = makeCtx();
    expect(storyFlow.position(ctx).state).toBe("awaitingSetup");

    // All of these used to RUN before a character existed: `action_roll` rolled
    // 2d6 against the stats of nobody and applied consequences to a game that was
    // not there. (`save_game` was in this list too, writing an empty campaign to a
    // slot `load_game` would later restore over a real one — both are gone with
    // `ctx.db`.)
    for (const call of [
      actionRoll.execute(
        { move: "clash", stat: "iron", position: "risky", effect: "standard", purpose: "swing" },
        ctx,
      ),
      updateState.execute({ location: "Nowhere" }, ctx),
      callNoArgs(burnMomentum, ctx),
    ]) {
      const refusal = await call;
      expect(isToolFailure(refusal)).toBe(true);
      expect(isToolFailure(refusal) && refusal.error).toMatch(/awaitingSetup/);
      expect(isToolFailure(refusal) && refusal.error).toMatch(/setup_character/);
    }

    // And nothing ran.
    expect(gameSlot.get(ctx).initialized).toBe(false);
  });

  test("setup opens play, a roll leaves one standing, and settling closes the window", async () => {
    const ctx = makeCtx();
    // `state`/`instruction`, not `at`/`next`: the ungated tools spread the
    // `DialogPosition` verbatim now, so they report their position under the
    // same keys every gated tool's result carries — which is what the system
    // prompt already claimed.
    const created = await setupCharacter.execute(SETUP_ARGS, ctx);
    expect(created.state).toBe("playing.awaitingRoll");
    expect(created.instruction).toMatch(/action_roll/);

    ok(
      await actionRoll.execute(
        { move: "clash", stat: "iron", position: "risky", effect: "standard", purpose: "swing" },
        ctx,
      ),
    );
    expect(storyFlow.position(ctx).state).toBe("playing.rollResolved");

    // Moving the scene on SPENDS the roll: the burn window is closed.
    ok(await updateState.execute({ location: "The Bridge" }, ctx));
    expect(storyFlow.position(ctx).state).toBe("playing.awaitingRoll");
    expect(isToolFailure(await callNoArgs(burnMomentum, ctx))).toBe(true);
  });

  test("check_state reports the position and is legal before setup", async () => {
    const ctx = makeCtx();
    const before = await callNoArgs(checkState, ctx);
    expect(before.state).toBe("awaitingSetup");
    expect(before.instruction).toMatch(/setup_character/);
    expect(before.done).toBe(false);
    expect(before.initialized).toBe(false);
  });

  test("a game over is terminal: nothing rolls, and setup starts a new story", async () => {
    const ctx = makeCtx();
    const dead = playingState();
    dead.health = 0;
    dead.spirit = 0;
    seedPlaying(ctx, dead);

    // `isGameOver` is what the result reports and the tool's `sendFrom` is what
    // turns it into a position — the flag used to be read by nobody who could
    // act on it, so a player could keep rolling after both tracks emptied. The
    // WRITE is `gameSlot`'s `after` hook; this tool no longer calls it, which
    // is the point of moving it there.
    ok(await updateState.execute({ health: 0, spirit: 0 }, ctx));
    const at = storyFlow.position(ctx);
    expect(at.state).toBe("gameOver");
    expect(at.done).toBe(true);

    const refused = await actionRoll.execute(
      { move: "clash", stat: "iron", position: "risky", effect: "standard", purpose: "swing" },
      ctx,
    );
    expect(isToolFailure(refused)).toBe(true);
    expect(isToolFailure(refused) && refused.error).toMatch(/gameOver/);

    // Starting over is legal from anywhere, the ending included.
    const restarted = await setupCharacter.execute(SETUP_ARGS, ctx);
    expect(restarted.state).toBe("playing.awaitingRoll");
  });

  // Two resume tests stood here — a saved game reopening in play, and one saved
  // after the ending reopening as over. Both drove `save_game`/`load_game`, which
  // are gone with `ctx.db`. What they proved about the FLOW (a resumed position is
  // restored rather than recomputed) has no path left to exercise it: a session
  // is the whole life of a game now.
});
