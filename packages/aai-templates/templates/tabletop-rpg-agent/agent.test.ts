/** The def a DEPLOYED agent runs: authored, plus what `tools/` declares. */
import agentDef from "virtual:aai/agent";
import type {
  AgentSessionContext,
  InferToolInput,
  RandomSource,
  SlotHolder,
} from "@alexkroman1/aai";
import { createSeededRandom, isToolFailure } from "@alexkroman1/aai";
import {
  createToolContext,
  expectDialogRefused,
  expectToolOk,
  parseToolInput,
  toolInputIssues,
  toolRunner,
} from "@alexkroman1/aai/testing";
import { describe, expect, test } from "vitest";
import {
  applyConsequences,
  DEFAULT_STATE,
  findClock,
  type GameState,
  gameSlot,
  gameView,
  inCrisis,
  isGameOver,
  liveSheet,
  MAX_LOG_ENTRIES,
  MAX_NPCS,
  MIN_MOMENTUM,
  makeNpc,
  rollAction,
  storyFlow,
} from "./shared.ts";
import type setupCharacter from "./tools/setup_character.ts";

// ── Harness ──────────────────────────────────────────────────────────────────

/**
 * A tool by the NAME the model calls it by, bound to this agent.
 *
 * The lookup, its "no such tool" message and the args-or-context shape are all
 * `toolRunner`'s (`@alexkroman1/aai/testing`); what is local is only which agent
 * it runs against. It replaces both the direct `tools/*.ts` imports and a local
 * `callNoArgs<R>(def, ctx)` that cast its way past `ToolDef["execute"]`'s first
 * parameter — a tool declaring no `inputSchema` types that as a shape no object
 * literal satisfies, and `runTool` takes the context in the arguments' place for
 * exactly that case. Driving by name is also the half a direct `.execute` call
 * cannot check: a renamed `tools/` file is what the MODEL would stop finding.
 */
const run = toolRunner(agentDef);

/**
 * The dice `rollAction` draws, in the order it draws them: d1, d2 (d6), then
 * c1, c2 (d10).
 *
 * `randomInt(sides, random)` is `Math.floor(random() * sides)`, so a face is
 * produced by returning `(face - 0.5) / sides`. This used to be
 * `vi.spyOn(Math, "random")` — a GLOBAL patch every other test in the file then
 * had to be trusted not to depend on, and one the teardown had to remember to
 * restore. The dice are a PARAMETER (`rollAction`'s fourth), which is the same
 * seam `ctx.random` gives a tool, so nothing here touches the process.
 */
function dice(...faces: readonly [number, number, number, number]): RandomSource {
  const sides = [6, 6, 10, 10] as const;
  let draw = 0;
  return () => {
    const face = faces[draw] ?? 1;
    const side = sides[draw] ?? 6;
    draw++;
    return (face - 0.5) / side;
  };
}

/**
 * Every field `setup_character` requires, pinned to the tool's OWN schema.
 *
 * `satisfies InferToolInput<typeof setupCharacter>` rather than a bare literal:
 * a required field added to that schema, or an enum member renamed under one of
 * these values, is a compile error HERE — where the alternative is a spec that
 * still passes while the shape it seeds no longer exists. The import is
 * type-only, so nothing about the runner's by-name lookup is undone by it.
 */
const SETUP_ARGS = {
  genre: "dark_fantasy",
  tone: "dark_gritty",
  archetype: "investigator",
  playerName: "Kael",
  characterConcept: "A haunted detective",
  settingDescription: "A city of fog and iron.",
  startingLocation: "The Docks",
  locationDesc: "Rotting piers under gaslight.",
  timeOfDay: "night",
  openingSituation: "A body washes ashore bearing your family crest.",
  npc1Name: "Mira",
  npc1Desc: "A wary informant",
  npc1Disposition: "distrustful",
  npc1Agenda: "Pay off her debts",
  threatClockName: "The Syndicate Closes In",
  threatClockDesc: "Assassins find the player",
} satisfies InferToolInput<typeof setupCharacter>;

const SWING = {
  move: "clash",
  stat: "iron",
  position: "risky",
  effect: "standard",
  purpose: "swing",
} as const;

/**
 * What the two ungated tools answer with.
 *
 * A plain `tool()` returns its own value, so there is no envelope to unwrap and
 * `expectToolOk` would (correctly) refuse one. The by-name lookup is a STRING,
 * so the author's return type cannot be recovered from it — the SDK says so in
 * `expectToolOk`'s own doc — and naming the fields a spec reads is the honest
 * substitute. Only what is asserted below is listed.
 */
type Answered = {
  state: string;
  instruction?: string;
  done: boolean;
  initialized: boolean;
  playerName: string;
  gameOver: boolean;
  health: number;
  momentum: number;
  chaosFactor: number;
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
 * Seed a session with a mid-game campaign AND the matching flow position.
 *
 * Writing the slot alone is not enough: `action_roll`, `update_state` and
 * `burn_momentum` gate on `storyFlow`, so a campaign installed behind the
 * machine's back leaves every one of them refusing. That is the point of the
 * gate, and it is what this helper exists to satisfy honestly — through the
 * flow's own event, not by writing its snapshot.
 *
 * Typed `SlotHolder` rather than `ToolContext`, which is what both calls below
 * really take: this seeds a session's SLOTS, and needs nothing else a tool body
 * is handed.
 */
function seedPlaying(ctx: SlotHolder, state: GameState = playingState()): GameState {
  gameSlot.set(ctx, state);
  storyFlow.send(ctx, { type: "SETUP" });
  return state;
}

// ── setup_character ──────────────────────────────────────────────────────────

describe("setup_character", () => {
  test("running setup twice starts fresh: no duplicate ids, no stale resources, truthful return", async () => {
    const ctx = createToolContext();

    await run("setup_character", SETUP_ARGS, ctx);

    // Simulate a played, damaged game between setups.
    gameSlot.update(ctx, (played) => {
      played.health = 1;
      played.momentum = -4;
      played.chaosFactor = 8;
      played.sceneCount = 42;
    });

    const result = (await run(
      "setup_character",
      { ...SETUP_ARGS, playerName: "Luna" },
      ctx,
    )) as Answered;

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
    const ctx = createToolContext();
    await run("setup_character", SETUP_ARGS, ctx);
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
    await run("setup_character", SETUP_ARGS, createToolContext());
    const other = (await run("check_state", createToolContext())) as Answered;
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
  function seedRolledState(momentum: number, ctx: SlotHolder) {
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
    const ctx = createToolContext();
    seedRolledState(8, ctx); // 8 beats both dice (3, 5)

    const result = expectToolOk<{ burned: boolean; newResultCode: string }>(
      await run("burn_momentum", ctx),
    );
    expect(result.burned).toBe(true);
    expect(result.newResultCode).toBe("STRONG_HIT");

    const state = gameSlot.get(ctx);
    expect(state.health).toBe(5); // -2 reverted
    expect(state.clocks[0]?.filled).toBe(0); // tick reverted
    expect(state.momentum).toBe(2); // reset, overriding the strong hit's gain
    expect(state.lastRoll).toBeNull();
  });

  test("momentum beating only one die upgrades a MISS to WEAK_HIT", async () => {
    const ctx = createToolContext();
    seedRolledState(4, ctx); // beats 3, not 5
    const result = expectToolOk<{ newResultCode: string }>(await run("burn_momentum", ctx));
    expect(result.newResultCode).toBe("WEAK_HIT");
  });

  test("burn is refused with no roll standing, insufficient momentum, or a strong hit", async () => {
    const ctx = createToolContext();

    // No roll yet — and this refusal is the FLOW's rather than a null check
    // inside the body: nothing has rolled, so the game is in
    // `playing.awaitingRoll` and this tool is not available there.
    // `expectDialogRefused` is the SDK's reader for that: it pins the STATE the
    // refusal names against the sentence `dialog()` writes, and throws naming
    // where the dialog actually landed if the call SUCCEEDED — where an
    // `isToolFailure(...) && ...` expression let a success through as a `false`
    // that merely failed the next matcher.
    seedPlaying(ctx);
    const outOfState = expectDialogRefused(await run("burn_momentum", ctx), "playing.awaitingRoll");
    // The state's own instruction rides in the refusal, which is what the model
    // recovers from.
    expect(outOfState.error).toContain("action_roll");

    // The two below are DATA rules — the momentum is too low, the roll was
    // already a strong hit — so they stay in the body, the tool really runs,
    // and what comes back is the body's own `toolFailure(...)` rather than the
    // gate's sentence. `isToolFailure` is the right reader for exactly that
    // difference.
    seedRolledState(2, ctx);
    let refused = await run("burn_momentum", ctx);
    expect(isToolFailure(refused) && refused.error).toMatch(/not high enough/);

    seedRolledState(8, ctx);
    gameSlot.update(ctx, (state) => {
      state.lastRoll!.result = "STRONG_HIT";
    });
    refused = await run("burn_momentum", ctx);
    expect(isToolFailure(refused) && refused.error).toMatch(/already a Strong Hit/);
  });

  test("action_roll persists the roll so burn needs no dice arguments", async () => {
    const ctx = createToolContext();
    seedPlaying(ctx);
    await run("action_roll", SWING, ctx);
    const state = gameSlot.get(ctx);
    expect(state.lastRoll).not.toBeNull();
    expect(state.lastRoll?.move).toBe("clash");
    expect(state.lastRoll?.deltas).toBeDefined();
  });
});

// ── rollAction dice boundaries ───────────────────────────────────────────────

describe("rollAction", () => {
  test("tying a challenge die is NOT a beat — equal on both dice is a MISS with match", () => {
    // action score 3+3+2 = 8 vs 8, 8
    const roll = rollAction("wits", 2, "face_danger", dice(3, 3, 8, 8));
    expect(roll.actionScore).toBe(8);
    expect(roll.result).toBe("MISS");
    expect(roll.match).toBe(true);
  });

  test("action score caps at 10 even when dice + stat exceed it", () => {
    const roll = rollAction("iron", 4, "clash", dice(6, 6, 1, 1)); // 6+6+4 = 16 → 10
    expect(roll.actionScore).toBe(10);
    expect(roll.result).toBe("STRONG_HIT");
  });

  test("beating exactly one die is a WEAK_HIT", () => {
    const roll = rollAction("edge", 2, "face_danger", dice(4, 2, 5, 9)); // 8: beats 5, not 9
    expect(roll.result).toBe("WEAK_HIT");
    expect(roll.match).toBe(false);
  });
});

// ── a scene is a function of its random source ───────────────────────────────

describe("action_roll draws everything from ctx.random", () => {
  /** One roll from a fresh session whose randomness is `createSeededRandom(seed)`. */
  async function playOneScene(seed: number) {
    const ctx = createToolContext({ random: createSeededRandom(seed) });
    seedPlaying(ctx);
    return expectToolOk<Record<string, unknown>>(await run("action_roll", SWING, ctx));
  }

  test("every draw a roll makes comes off the context's source", async () => {
    // The DETERMINISTIC half, and the one that names the defect: a roll draws
    // five times — d1, d2, c1, c2, and then the chaos check's own d10 (a sixth
    // when the interrupt lands and its type is picked). The fifth used to reach
    // `Math.random`, because `checkChaosInterrupt`'s source parameter was simply
    // omitted at the call, so the count was four.
    let draws = 0;
    const seeded = createSeededRandom(2026);
    const ctx = createToolContext({
      random: () => {
        draws++;
        return seeded();
      },
    });
    seedPlaying(ctx);

    expectToolOk(await run("action_roll", SWING, ctx));
    expect(draws).toBeGreaterThanOrEqual(5);
  });

  test("the same seed replays the same scene, chaos interrupt included", async () => {
    // The property a player would notice, over the WHOLE result rather than the
    // dice: with the missing source above, this comparison disagreed on
    // `chaosInterrupt` for roughly three runs in five — intermittently, and only
    // ever on the field nobody looks at. A seeded campaign replays or it does
    // not.
    expect(await playOneScene(2026)).toEqual(await playOneScene(2026));
  });

  test("a different seed is a different scene", async () => {
    // The other half, and the reason `createSeededRandom` rather than a
    // constant source: `() => 0.5` is deterministic and degenerate, and every
    // roll under it would be identical. Compared on the dice alone, since two
    // seeds may legitimately agree on a derived label.
    const a = await playOneScene(1);
    const b = await playOneScene(99);
    expect([a.actionDice, a.challengeDice]).not.toEqual([b.actionDice, b.challengeDice]);
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
  /**
   * A context whose `d(sides)` rolls `value`.
   *
   * `ctx.random` is the seam, so the dice a scene is resolved on are an
   * argument to the tool rather than a property of the process.
   */
  function rolling(value: number, sides: number) {
    return createToolContext({ random: () => (value - 0.5) / sides });
  }

  test("a chaos interrupt that LANDS lowers the stored chaos factor", async () => {
    const ctx = rolling(1, 10);
    const state = playingState();
    state.chaosFactor = 9; // threshold 6 — a roll of 1 lands
    seedPlaying(ctx, state);

    const result = (await run("oracle", { type: "chaos_check" }, ctx)) as {
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
    const ctx = createToolContext();
    const state = playingState();
    state.chaosFactor = 3; // threshold 0 — `checkChaosInterrupt` returns early
    seedPlaying(ctx, state);

    const result = (await run("oracle", { type: "chaos_check" }, ctx)) as {
      interrupted: boolean;
      chaosFactor: number;
    };
    expect(result.interrupted).toBe(false);
    expect(gameSlot.get(ctx).chaosFactor).toBe(3);
  });

  test("a chaos check that MISSES changes nothing", async () => {
    const ctx = rolling(10, 10); // past the threshold
    const state = playingState();
    state.chaosFactor = 5; // threshold 2
    seedPlaying(ctx, state);

    const result = (await run("oracle", { type: "chaos_check" }, ctx)) as {
      interrupted: boolean;
      chaosFactor: number;
    };
    expect(result.interrupted).toBe(false);
    expect(result.chaosFactor).toBe(5);
    expect(gameSlot.get(ctx).chaosFactor).toBe(5);
  });

  test("a chaos check on an untouched session starts from the default factor", async () => {
    // DEFAULT_STATE.chaosFactor is 5, so threshold 2 — a roll of 1 lands.
    const ctx = rolling(1, 10);
    const result = (await run("oracle", { type: "chaos_check" }, ctx)) as { chaosFactor: number };
    expect(result.chaosFactor).toBe(DEFAULT_STATE.chaosFactor - 1);
    expect(gameSlot.get(ctx).chaosFactor).toBe(DEFAULT_STATE.chaosFactor - 1);
  });

  test("yes_no maps the d6 onto its three answers", async () => {
    for (const [roll, answer] of [
      [1, "No"],
      [2, "No"],
      [3, "Yes, but with a complication"],
      [4, "Yes, but with a complication"],
      [5, "Yes"],
      [6, "Yes"],
    ] as const) {
      const result = (await run("oracle", { type: "yes_no" }, rolling(roll, 6))) as {
        roll: number;
        answer: string;
      };
      expect.soft(result, `roll ${roll}`).toEqual({ type: "yes_no", roll, answer });
    }
  });

  test("the four inspiration branches answer without touching the game", async () => {
    const ctx = createToolContext();
    seedPlaying(ctx);
    const before = structuredClone(gameSlot.get(ctx));

    const reaction = (await run("oracle", { type: "npc_reaction" }, ctx)) as { reaction: string };
    const twist = (await run("oracle", { type: "scene_twist" }, ctx)) as { twist: string };
    const theme = (await run("oracle", { type: "action_theme" }, ctx)) as {
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

// ── which clock the player meant ─────────────────────────────────────────────

describe("findClock", () => {
  // Deliberately ordered so the two rules disagree: "The First Light" contains
  // an ordinal word and sits SECOND.
  const clocks = [
    { id: "clock_1", name: "The Syndicate Closes In" },
    { id: "clock_2", name: "The First Light" },
  ];

  test("an exact name wins over the ordinal it happens to contain", () => {
    // Resolving the ordinal first would answer `clock_1` here, silently
    // retargeting a clock the player named outright.
    expect(findClock(clocks, "The First Light")?.id).toBe("clock_2");
    expect(findClock(clocks, "  the first light ")?.id).toBe("clock_2");
  });

  test("an ordinal picks by the position the sidebar renders", () => {
    expect(findClock(clocks, "the second clock")?.id).toBe("clock_2");
    expect(findClock(clocks, "the 1st one")?.id).toBe("clock_1");
  });

  test("neither a name nor an ordinal resolves to nothing", () => {
    expect(findClock(clocks, "The Reckoning")).toBeUndefined();
    // An ordinal past the end is not a wrap-around.
    expect(findClock(clocks, "the ninth clock")).toBeUndefined();
  });
});

// ── update_state: clocks, caps, validation ───────────────────────────────────

describe("update_state", () => {
  test("clock ids never collide after a removal (max-scan, not length+1)", async () => {
    const ctx = createToolContext();
    seedPlaying(ctx); // has clock_1

    await run("update_state", { addClockName: "Second" }, ctx); // clock_2
    await run("update_state", { removeClockName: "Doom" }, ctx); // removes clock_1
    await run("update_state", { addClockName: "Third" }, ctx);

    const state = gameSlot.get(ctx);
    const ids = state.clocks.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(["clock_2", "clock_3"]);
  });

  test("advancing a clock to full reports its trigger event", async () => {
    const ctx = createToolContext();
    const state = playingState();
    state.clocks[0]!.filled = 3; // 3 of 4
    seedPlaying(ctx, state);

    const result = expectToolOk<{ clockEvents: { clock: string; trigger: string }[] }>(
      await run("update_state", { advanceClockName: "Doom" }, ctx),
    );
    expect(result.clockEvents).toEqual([{ clock: "Doom", trigger: "The doom arrives" }]);
  });

  test("a clock can be advanced by the ordinal the player used", async () => {
    const ctx = createToolContext();
    const state = playingState();
    state.clocks.push({
      id: "clock_2",
      name: "The Long Night",
      clockType: "progress",
      segments: 2,
      filled: 1,
      triggerDescription: "Dawn breaks",
    });
    seedPlaying(ctx, state);

    const result = expectToolOk<{ clockEvents: { clock: string; trigger: string }[] }>(
      await run("update_state", { advanceClockName: "the second one" }, ctx),
    );
    expect(result.clockEvents).toEqual([{ clock: "The Long Night", trigger: "Dawn breaks" }]);
    expect(gameSlot.get(ctx).clocks[1]?.filled).toBe(2);
  });

  test("removing by ordinal drops exactly that clock", async () => {
    const ctx = createToolContext();
    const state = playingState();
    state.clocks.push({
      id: "clock_2",
      name: "The Long Night",
      clockType: "progress",
      segments: 2,
      filled: 0,
      triggerDescription: "Dawn breaks",
    });
    seedPlaying(ctx, state);

    expectToolOk(await run("update_state", { removeClockName: "the first clock" }, ctx));
    expect(gameSlot.get(ctx).clocks.map((c) => c.id)).toEqual(["clock_2"]);
  });

  test("a clock nobody has warns instead of silently doing nothing", async () => {
    const ctx = createToolContext();
    seedPlaying(ctx);
    const result = expectToolOk<{ warnings?: string[] }>(
      await run("update_state", { advanceClockName: "The Reckoning" }, ctx),
    );
    expect(result.warnings?.[0]).toMatch(/No clock matching/);
  });

  test("NPC count is capped at MAX_NPCS with a warning", async () => {
    const ctx = createToolContext();
    const state = playingState();
    while (state.npcs.length < MAX_NPCS) {
      state.npcs.push(makeNpc({ id: `npc_${state.npcs.length + 1}`, name: "Extra" }));
    }
    seedPlaying(ctx, state);

    const result = expectToolOk<{ warnings?: string[] }>(
      await run("update_state", { addNpcName: "One Too Many" }, ctx),
    );
    expect(result.warnings?.[0]).toMatch(/NPC limit/);
    const after = gameSlot.get(ctx);
    expect(after.npcs).toHaveLength(MAX_NPCS);
  });

  test("the chronicle is capped by the SLOT, keeping the newest entries", async () => {
    // The bound is declared as `caps` on `gameSlot` and enforced by nothing in
    // this tool, which is exactly why it is worth a test: `update_state` pushes
    // unconditionally, so a dropped `caps` key would leave the log growing into
    // every `syncState` frame with nothing red.
    const ctx = createToolContext();
    seedPlaying(ctx);
    for (let i = 1; i <= MAX_LOG_ENTRIES + 5; i++) {
      await run("update_state", { logEntry: `scene ${i}` }, ctx);
    }

    const log = gameSlot.get(ctx).sessionLog;
    expect(log).toHaveLength(MAX_LOG_ENTRIES);
    expect(log[0]?.summary).toBe("scene 6");
    expect(log.at(-1)?.summary).toBe(`scene ${MAX_LOG_ENTRIES + 5}`);
  });

  test("the input schema rejects out-of-range and malformed values", async () => {
    // `toolInputIssues` / `parseToolInput` (`@alexkroman1/aai/testing`) rather
    // than reaching for `inputSchema!["~standard"]` — the reach eighteen sites
    // across ten templates had re-derived. They also take the tool by NAME, so
    // this asks the agent's own registry the same question the runner above
    // does, and the rejection reports WHICH field failed instead of "it threw".
    for (const bad of [
      { addClockSegments: 1 }, // below min
      { addClockSegments: 13 }, // above max
      { addClockSegments: 2.5 }, // non-integer
      { updateNpcBond: 5 }, // above MAX_BOND
      { updateNpcBond: -1 },
      { timeOfDay: "noonish" }, // not a phase
    ]) {
      expect
        .soft(await toolInputIssues(agentDef, "update_state", bad), JSON.stringify(bad))
        .toBeDefined();
    }

    await expect(
      parseToolInput(agentDef, "update_state", {
        addClockSegments: 6,
        updateNpcBond: 4,
        timeOfDay: "night",
      }),
    ).resolves.toMatchObject({ addClockSegments: 6, timeOfDay: "night" });
  });
});

// A `save_game / load_game` suite stood here, driving cross-session persistence
// through a map-backed fake of `ctx.db`. Both tools are gone: `ctx.db` is gone,
// and a shipped template cannot reach a database (see `shared.ts`). This
// adventure is single-session now.

// ── the story flow ───────────────────────────────────────────────────────────

describe("the story flow", () => {
  test("a fresh session is awaiting setup, and the play tools refuse there", async () => {
    const ctx = createToolContext();
    expect(storyFlow.position(ctx).state).toBe("awaitingSetup");

    // All of these used to RUN before a character existed: `action_roll` rolled
    // 2d6 against the stats of nobody and applied consequences to a game that was
    // not there.
    for (const call of [
      run("action_roll", SWING, ctx),
      run("update_state", { location: "Nowhere" }, ctx),
      run("burn_momentum", ctx),
    ]) {
      const refusal = expectDialogRefused(await call, "awaitingSetup");
      expect(refusal.error).toContain("setup_character");
    }

    // And nothing ran.
    expect(gameSlot.get(ctx).initialized).toBe(false);
  });

  test("setup opens play, a roll leaves one standing, and settling closes the window", async () => {
    const ctx = createToolContext();
    // `state`/`instruction`, not `at`/`next`: the ungated tools spread the
    // `DialogPosition` verbatim now, so they report their position under the
    // same keys every gated tool's result carries — which is what the system
    // prompt already claimed.
    const created = (await run("setup_character", SETUP_ARGS, ctx)) as Answered;
    expect(created.state).toBe("playing.awaitingRoll");
    expect(created.instruction).toMatch(/action_roll/);

    expectToolOk(await run("action_roll", SWING, ctx));
    expect(storyFlow.position(ctx).state).toBe("playing.rollResolved");

    // Moving the scene on SPENDS the roll: the burn window is closed.
    expectToolOk(await run("update_state", { location: "The Bridge" }, ctx));
    expect(storyFlow.position(ctx).state).toBe("playing.awaitingRoll");
    expectDialogRefused(await run("burn_momentum", ctx), "playing.awaitingRoll");
  });

  test("check_state reports the position and is legal before setup", async () => {
    const ctx = createToolContext();
    const before = (await run("check_state", ctx)) as Answered;
    expect(before.state).toBe("awaitingSetup");
    expect(before.instruction).toMatch(/setup_character/);
    expect(before.done).toBe(false);
    expect(before.initialized).toBe(false);
  });

  test("a game over is terminal: nothing rolls, and setup starts a new story", async () => {
    const ctx = createToolContext();
    const dead = playingState();
    dead.health = 0;
    dead.spirit = 0;
    seedPlaying(ctx, dead);

    // `isGameOver` is what the result reports and the tool's `sendFrom` is what
    // turns it into a position — the flag used to be read by nobody who could
    // act on it, so a player could keep rolling after both tracks emptied. The
    // WRITE is `gameSlot`'s `after` hook; this tool no longer calls it, which
    // is the point of moving it there.
    expectToolOk(await run("update_state", { health: 0, spirit: 0 }, ctx));
    const at = storyFlow.position(ctx);
    expect(at.state).toBe("gameOver");
    expect(at.done).toBe(true);

    expectDialogRefused(await run("action_roll", SWING, ctx), "gameOver");

    // Starting over is legal from anywhere, the ending included.
    const restarted = (await run("setup_character", SETUP_ARGS, ctx)) as Answered;
    expect(restarted.state).toBe("playing.awaitingRoll");
  });

  test("the projection withholds the plot the player has not reached", () => {
    const game: GameState = {
      ...structuredClone(DEFAULT_STATE),
      backstory: "SPOILER backstory",
      playerWishes: "SPOILER wishes",
      contentLines: "SPOILER lines",
      settingTone: "SPOILER tone",
      settingArchetype: "SPOILER archetype",
      settingDescription: "SPOILER description",
      storyBlueprint: {
        structureType: "3act",
        centralConflict: "c",
        antagonistForce: "a",
        thematicThread: "t",
        currentAct: 1,
        storyComplete: false,
        acts: [
          { phase: "setup", title: "One", goal: "g1", mood: "m1", transitionTrigger: "SPOILER1" },
          { phase: "turn", title: "Two", goal: "g2", mood: "m2", transitionTrigger: "SPOILER2" },
        ],
      },
    };

    const view = gameView(game);
    // The sidebar needs how far along and which phase, and nothing else about
    // the arc: an act's goal, mood and transition trigger are the twists the
    // player has not reached, and slot state is otherwise server-side, so this
    // projection is the only thing standing between them and devtools.
    expect(view.storyArc).toEqual({
      currentAct: 1,
      totalActs: 2,
      phase: "setup",
      storyComplete: false,
    });
    expect(JSON.stringify(view)).not.toMatch(/SPOILER/);
  });

  // Two resume tests stood here — a saved game reopening in play, and one saved
  // after the ending reopening as over. Both drove `save_game`/`load_game`, which
  // are gone with `ctx.db`. What they proved about the FLOW (a resumed position is
  // restored rather than recomputed) has no path left to exercise it: a session
  // is the whole life of a game now.
});

// ── The prompt carries the sheet ─────────────────────────────────────────────
//
// `systemPrompt` is a RESOLVER here: `system-prompt.md` supplies the rules and
// `liveSheet` appends the campaign as it stands before every model request.
// What that replaced was FLOW rule 1 — "call check_state as your FIRST tool
// call every turn" — a model round trip in front of every turn of a live voice
// game, enforced by nothing.

describe("the campaign sheet the narrator is given", () => {
  /** The def's resolver, which is what a request assembles the instructions from. */
  const resolve = (ctx: AgentSessionContext): string => {
    const prompt = agentDef.systemPrompt;
    if (typeof prompt !== "function") throw new Error("systemPrompt is not a resolver");
    return prompt(ctx);
  };

  test("it is a resolver, and the rules file survives into it", () => {
    // The build discovers `system-prompt.md` and hands it to `withSystemPrompt`,
    // which leaves a resolver alone — so the file reaches the model through the
    // resolver's own import, and this is what proves it does.
    expect(typeof agentDef.systemPrompt).toBe("function");
    expect(resolve(createToolContext())).toContain("CORE MECHANIC - ACTION ROLL");
  });

  test("before setup it says so, rather than printing an empty sheet", () => {
    const ctx = createToolContext();
    const sheet = liveSheet(gameSlot.get(ctx));
    expect(sheet).toContain("no character yet");
    expect(sheet).toContain("setup_character");
    // The tracks of a campaign that does not exist would read as a live sheet.
    // (Asserted on the sheet, not the whole prompt: the rules file has its own
    // MOMENTUM section and always will.)
    expect(sheet).not.toContain("Momentum");
    expect(resolve(ctx).endsWith(sheet)).toBe(true);
  });

  test("a roll's consequences are in the NEXT request's prompt, with no tool call in between", async () => {
    const ctx = createToolContext();
    seedPlaying(ctx);
    // A MISS: the tracks and the momentum move, and the chaos factor with them.
    const before = resolve(ctx);
    expect(before).toContain(`Momentum ${DEFAULT_STATE.momentum}`);

    expectToolOk(
      await run(
        "action_roll",
        { move: "face_danger", stat: "iron", position: "desperate", effect: "standard" },
        createToolContext({ ...ctx, random: dice(1, 1, 10, 10) }),
      ),
    );

    const after = resolve(ctx);
    const game = gameSlot.get(ctx);
    expect(after).toContain(`Momentum ${game.momentum}`);
    expect(after).toContain(`chaos factor ${game.chaosFactor}`);
    expect(after).toContain(`Health ${game.health}/`);
    // And the burn window, which is the one thing the narrator most often lost
    // track of between turns.
    expect(after).toContain("burn_momentum can still upgrade it");
  });

  test("the cast, the clocks and the act are all on it", () => {
    const ctx = createToolContext();
    const state = playingState();
    state.playerName = "Kael";
    state.currentLocation = "Ashfall Keep";
    state.clocks[0]!.filled = 2;
    state.storyBlueprint = {
      structureType: "3act",
      centralConflict: "c",
      antagonistForce: "a",
      thematicThread: "t",
      currentAct: 2,
      storyComplete: false,
      acts: [
        { phase: "setup", title: "One", goal: "g1", mood: "m1", transitionTrigger: "t1" },
        { phase: "turn", title: "Two", goal: "g2", mood: "m2", transitionTrigger: "t2" },
      ],
    };
    seedPlaying(ctx, state);

    const sheet = resolve(ctx);
    expect(sheet).toContain("Kael");
    expect(sheet).toContain("Doom 2/4 (threat)");
    expect(sheet).toContain("Mira (neutral, bond 0)");
    expect(sheet).toContain("Act 2 of 2 (turn)");
  });

  test("crisis and game over are DERIVED, so an emptied track cannot read as survivable", () => {
    const ctx = createToolContext();
    const hurt = playingState();
    hurt.spirit = 0;
    seedPlaying(ctx, hurt);
    expect(liveSheet(gameSlot.get(ctx))).toContain("CRISIS");
    expect(inCrisis(gameSlot.get(ctx))).toBe(true);

    const dead = playingState();
    dead.health = 0;
    dead.spirit = 0;
    seedPlaying(ctx, dead);
    expect(liveSheet(gameSlot.get(ctx))).toContain("GAME OVER");
    expect(isGameOver(gameSlot.get(ctx))).toBe(true);
  });

  test("each session is told its OWN campaign", () => {
    // The resolver reads through `ctx.slots`, so it is per session for the same
    // reason every tool is.
    const one = createToolContext();
    const two = createToolContext();
    const named = playingState();
    named.playerName = "Kael";
    seedPlaying(one, named);

    expect(resolve(one)).toContain("Kael");
    expect(resolve(two)).toContain("no character yet");
  });
});
