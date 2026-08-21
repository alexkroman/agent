// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { setup } from "xstate";
import { z } from "zod";
import { derivedFlow, UnknownFlowStateError } from "./derived-flow.ts";
import { sessionSlot } from "./session-slot.ts";
import { createToolContext } from "./testing.ts";
import type { ToolContext, ToolDef } from "./types.ts";
import { isToolFailure, toolFailure } from "./utils.ts";

/** A game whose position is entirely a function of three fields. */
interface Game {
  started: boolean;
  over: boolean;
  standingRoll: boolean;
  scene: number;
}

function gameSlot() {
  return sessionSlot(
    "game",
    (): Game => ({ started: false, over: false, standingRoll: false, scene: 0 }),
  );
}

/**
 * The `solo-rpg` shape, which is the case that motivated the primitive: a nested
 * `playing` with a child that says whether a roll is standing.
 */
function storyMachine() {
  return setup({}).createMachine({
    id: "story",
    initial: "awaitingSetup",
    states: {
      awaitingSetup: { meta: { instruction: "Make a character first." } },
      playing: {
        meta: { instruction: "Play on." },
        initial: "awaitingRoll",
        states: {
          awaitingRoll: { meta: { instruction: "Narrate, then roll for anything risky." } },
          rollResolved: { meta: { instruction: "A roll is standing; momentum can upgrade it." } },
          // A NESTED final: it completes the `playing` region, and the story is
          // not over — which is exactly the distinction `done` must not blur.
          sceneClosed: { type: "final", meta: { instruction: "The scene is closed." } },
        },
      },
      gameOver: { type: "final", meta: { instruction: "Narrate the ending and stop." } },
    },
  });
}

function story(slot: ReturnType<typeof gameSlot>) {
  return derivedFlow(storyMachine(), slot, (game) => {
    if (game.over) return "gameOver";
    if (!game.started) return "awaitingSetup";
    if (game.scene < 0) return "playing.sceneClosed";
    return game.standingRoll ? "playing.rollResolved" : "playing.awaitingRoll";
  });
}

async function run(tool: ToolDef, ctx: ToolContext): Promise<unknown> {
  return await tool.execute({}, ctx);
}

describe("locate", () => {
  // The whole transition relation as one pure function — no context, no session.
  // This is the property the primitive exists to buy.
  test.each([
    [{ started: false, over: false, standingRoll: false }, "awaitingSetup"],
    [{ started: true, over: false, standingRoll: false }, "playing.awaitingRoll"],
    [{ started: true, over: false, standingRoll: true }, "playing.rollResolved"],
    [{ started: true, over: true, standingRoll: true }, "gameOver"],
    // Over wins even from a state that never legally reached it.
    [{ started: false, over: true, standingRoll: false }, "gameOver"],
  ])("%o locates %s", (fields, expected) => {
    const flow = story(gameSlot());
    expect(flow.locate({ ...fields, scene: 0 })).toBe(expected);
  });
});

describe("position", () => {
  test("reads the deepest instruction on the located path", () => {
    const slot = gameSlot();
    const flow = story(slot);
    const ctx = createToolContext();
    slot.set(ctx, { started: true, over: false, standingRoll: true, scene: 3 });

    const at = flow.position(ctx);
    expect(at.state).toBe("playing.rollResolved");
    expect(at.instruction).toBe("A roll is standing; momentum can upgrade it.");
    expect(at.done).toBe(false);
  });

  test("done is decided by the TOP-LEVEL segment", () => {
    const slot = gameSlot();
    const flow = story(slot);
    const ctx = createToolContext();
    // A nested child is not an ending just because it is a leaf.
    slot.set(ctx, { started: true, over: false, standingRoll: false, scene: 1 });
    expect(flow.position(ctx).done).toBe(false);
    slot.set(ctx, { started: true, over: true, standingRoll: false, scene: 1 });
    expect(flow.position(ctx).done).toBe(true);
  });

  test("a NESTED final completes its region without ending the machine", () => {
    // `playing.sceneClosed` IS `type: "final"`, so a whole-path lookup would
    // report the story over. Only the ROOT segment decides, and `playing` is not
    // final — so this is `done: false` while still being a final state.
    const slot = gameSlot();
    const flow = story(slot);
    const ctx = createToolContext();
    slot.set(ctx, { started: true, over: false, standingRoll: false, scene: -1 });

    expect(flow.position(ctx).state).toBe("playing.sceneClosed");
    expect(flow.position(ctx).done).toBe(false);
  });

  test("a default slot value locates the initial state with no write at all", () => {
    const flow = story(gameSlot());
    expect(flow.position(createToolContext()).state).toBe("awaitingSetup");
  });

  test("a locate() that names an unknown state throws naming the real ones", () => {
    const slot = gameSlot();
    const flow = derivedFlow(storyMachine(), slot, () => "nowhere");
    expect(() => flow.position(createToolContext())).toThrow(UnknownFlowStateError);
    expect(() => flow.position(createToolContext())).toThrow(/not one of its states/);
  });
});

describe("matches", () => {
  test("a parent name matches a nested position, at a segment boundary only", () => {
    const slot = gameSlot();
    const flow = story(slot);
    const ctx = createToolContext();
    slot.set(ctx, { started: true, over: false, standingRoll: true, scene: 0 });

    expect(flow.matches(ctx, "playing")).toBe(true);
    expect(flow.matches(ctx, "playing.rollResolved")).toBe(true);
    expect(flow.matches(ctx, "playing.awaitingRoll")).toBe(false);
    // A prefix that is not a whole segment must NOT match.
    expect(flow.matches(ctx, "play")).toBe(false);
  });
});

describe("tool", () => {
  test("a gated body runs in state and the result carries the position it LANDED in", async () => {
    const slot = gameSlot();
    const flow = story(slot);
    const ctx = createToolContext();
    slot.set(ctx, { started: true, over: false, standingRoll: false, scene: 0 });

    // The body's own write is what moves the flow — there is no event to send.
    const roll = flow.tool({
      description: "roll",
      when: "playing",
      execute: (_args, c) =>
        slot.update(c, (game) => {
          game.standingRoll = true;
          game.scene += 1;
          return { rolled: true };
        }),
    });

    expect(await run(roll, ctx)).toEqual({
      state: "playing.rollResolved",
      done: false,
      instruction: "A roll is standing; momentum can upgrade it.",
      result: { rolled: true },
    });
  });

  test("out of state the body does not run and the refusal quotes the position", async () => {
    const slot = gameSlot();
    const flow = story(slot);
    const ctx = createToolContext();
    const ran = { body: false };
    const burn = flow.tool({
      description: "burn",
      when: "playing.rollResolved",
      execute: () => {
        ran.body = true;
        return { burned: true };
      },
    });

    const answered = await run(burn, ctx); // still awaitingSetup
    expect(isToolFailure(answered) && answered.error).toContain('at "awaitingSetup"');
    expect(isToolFailure(answered) && answered.error).toContain("Make a character first");
    expect(ran.body).toBe(false);
  });

  test("a ToolFailure body leaves the position where the data leaves it", async () => {
    const slot = gameSlot();
    const flow = story(slot);
    const ctx = createToolContext();
    slot.set(ctx, { started: true, over: false, standingRoll: false, scene: 0 });

    // The body refuses AND writes nothing, so nothing moved — which is the
    // derived flow's version of "a failure does not advance": there is no
    // separate transition that could have fired.
    const roll = flow.tool({
      description: "roll",
      when: "playing",
      execute: () => toolFailure("the dice are gone"),
    });
    expect(await run(roll, ctx)).toEqual({ error: "the dice are gone" });
    expect(flow.position(ctx).state).toBe("playing.awaitingRoll");
  });

  test("an async body is awaited before the position is read back", async () => {
    const slot = gameSlot();
    const flow = story(slot);
    const ctx = createToolContext();
    slot.set(ctx, { started: true, over: false, standingRoll: false, scene: 0 });

    const tool = flow.tool({
      description: "slow",
      inputSchema: z.object({}),
      when: "playing",
      execute: async (_args, c) => {
        await Promise.resolve();
        return slot.update(c, (game) => {
          game.over = true;
          return { ended: true };
        });
      },
    });

    expect(await run(tool, ctx)).toMatchObject({ state: "gameOver", done: true });
  });

  test("a `when` naming a state the machine lacks throws at DECLARATION", () => {
    const flow = story(gameSlot());
    expect(() => flow.tool({ description: "d", when: "winning", execute: () => 1 })).toThrow(
      /has no state "winning"/,
    );
  });

  test("inputSchema is passed through untouched", () => {
    const flow = story(gameSlot());
    const schema = z.object({ n: z.number() });
    expect(
      flow.tool({ description: "d", when: "playing", inputSchema: schema, execute: () => 1 }),
    ).toMatchObject({ description: "d", inputSchema: schema });
  });
});

describe("the divergence it makes unrepresentable", () => {
  test("a restore cannot leave the position behind the data", async () => {
    // This is the solo-rpg save/load bug, reproduced against a derived flow.
    // `slot.set` is the whole restore — there is no second thing to rebuild, so
    // there is nothing to rebuild INCOMPLETELY.
    const slot = gameSlot();
    const flow = story(slot);
    const saved: Game = { started: true, over: false, standingRoll: true, scene: 7 };

    const resumed = createToolContext();
    expect(flow.position(resumed).state).toBe("awaitingSetup");
    slot.set(resumed, saved);
    expect(flow.position(resumed).state).toBe("playing.rollResolved");

    // And the tool the old bug refused goes straight through.
    const burn = flow.tool({
      description: "burn",
      when: "playing.rollResolved",
      execute: () => ({ burned: true }),
    });
    expect(await run(burn, resumed)).toMatchObject({ result: { burned: true } });
  });

  test("each session derives its own position from its own data", () => {
    const slot = gameSlot();
    const flow = story(slot);
    const a = createToolContext();
    const b = createToolContext();
    slot.set(a, { started: true, over: false, standingRoll: true, scene: 2 });
    expect(flow.position(a).state).toBe("playing.rollResolved");
    expect(flow.position(b).state).toBe("awaitingSetup");
  });
});

describe("projection", () => {
  // A `StateProjection` is called with the slot's VALUE, not a context — that is
  // what the runtime pushes it, and `undefined` is the pre-first-tool frame.
  test("projects the computed position for a session that has run no tool yet", () => {
    const flow = story(gameSlot());
    const projection = flow.projection((at) => ({ step: at.state, next: at.instruction }));
    expect(projection(undefined)).toEqual({
      step: "awaitingSetup",
      next: "Make a character first.",
    });
  });

  test("projects the position the stored data implies", () => {
    const slot = gameSlot();
    const flow = story(slot);
    const ctx = createToolContext();
    slot.set(ctx, { started: true, over: true, standingRoll: false, scene: 4 });

    const projection = flow.projection((at) => ({ step: at.state, done: at.done }));
    expect(projection(ctx.slots.read("game"))).toEqual({ step: "gameOver", done: true });
  });

  test("carries the SLOT's key, since that is the value it reads", () => {
    const flow = story(gameSlot());
    expect(flow.projection((at) => at.state).key).toBe("game");
  });
});
