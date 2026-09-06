/** The def a DEPLOYED agent runs: authored, plus what `tools/` and the prompt add. */
import agentDef from "virtual:aai/agent";
import type { ToolContext } from "@alexkroman1/aai";
import {
  createToolContext,
  expectDialogOk,
  expectDialogRefused,
  stubGenerate,
  toolRunner,
} from "@alexkroman1/aai/testing";
import { afterEach, describe, expect, test, vi } from "vitest";
import { gameFlow } from "./game.ts";
import { containsWord, isCorrectGuess, normalizeWord } from "./guess.ts";
import { PLAYER_SYSTEM, playerPrompt } from "./player.ts";
import {
  currentWord,
  GAME_SECONDS,
  gameProjection,
  gameSlot,
  gameView,
  secondsLeft,
} from "./shared.ts";
import { allWords, pickWords, WORD_CATEGORIES } from "./words.ts";

// ─── Harness ─────────────────────────────────────────────────────────────────

/** A tool by the name the model calls it by, bound to this agent. */
const run = toolRunner(agentDef);

/** Where the round is, without going through a tool. */
const at = (ctx: ToolContext) => gameFlow.position(ctx).state;

/**
 * A scripted PLAYER. The tool reaches a model one way — `ctx.generate` on the
 * player's system prompt — so `stubGenerate` routed by that prompt is the one
 * fake this spec needs. The script answers whatever `nextGuess` holds, so a
 * test decides per call whether the player is right.
 */
function scriptedPlayer() {
  let nextGuess = "nothing";
  const model = stubGenerate({
    [PLAYER_SYSTEM]: () => ({ object: { guess: nextGuess, remark: `Is it a ${nextGuess}?` } }),
  });
  return {
    model,
    /** A context whose player will answer `guess` next. */
    ctx: (messages: { role: "user" | "assistant"; content: string }[] = []) =>
      createToolContext({ generate: model.generate, messages }),
    guess(word: string) {
      nextGuess = word;
    },
  };
}

/** Start a round and hand back the word the describer is looking at. */
async function startRound(ctx: ToolContext): Promise<string> {
  expectDialogOk(await run("start_game", ctx));
  const word = currentWord(gameSlot.get(ctx));
  if (word === null) throw new Error("no word after start_game");
  return word;
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── 1. The referee ──────────────────────────────────────────────────────────

describe("guess.ts", () => {
  test("a guess is the word after articles, case, punctuation and a plural are set aside", () => {
    expect(normalizeWord("  Is it... The Giraffe? ")).toBe("is it the giraffe");
    expect(isCorrectGuess("giraffe", "giraffe")).toBe(true);
    expect(isCorrectGuess("A Giraffe!", "giraffe")).toBe(true);
    expect(isCorrectGuess("giraffes", "giraffe")).toBe(true);
    expect(isCorrectGuess("Is it a giraffe?", "giraffe")).toBe(true);
    expect(isCorrectGuess("ice creams", "ice cream")).toBe(true);
    // Close is not right: a game that rounds up has no reason to keep score.
    expect(isCorrectGuess("gazelle", "giraffe")).toBe(false);
    expect(isCorrectGuess("giraffe", "gazelle")).toBe(false);
    expect(isCorrectGuess("", "giraffe")).toBe(false);
  });

  test("a description that says the word, or a part of a phrase, is a foul", () => {
    expect(containsWord("it has a long neck like elephants do", "elephant")).toBe(true);
    expect(containsWord("It's an ELEPHANT.", "elephant")).toBe(true);
    expect(containsWord("a tall animal with spots", "giraffe")).toBe(false);
    // A word inside another word is not the word.
    expect(containsWord("you see it at the seaside", "sea")).toBe(false);
    // Any part of a multi-word phrase counts; a part under three letters never does.
    expect(containsWord("you eat it cold, made from cream", "ice cream")).toBe(true);
    expect(containsWord("you eat it cold", "ice cream")).toBe(false);
  });
});

// ─── 2. The words ────────────────────────────────────────────────────────────

describe("words.ts", () => {
  test("eleven categories, no duplicates, and a round samples without replacement", () => {
    expect(Object.keys(WORD_CATEGORIES)).toHaveLength(11);
    const pool = allWords();
    expect(pool.length).toBeGreaterThanOrEqual(200);
    expect(new Set(pool).size).toBe(pool.length);
    const round = pickWords(20);
    expect(round).toHaveLength(20);
    expect(new Set(round).size).toBe(20);
    // A fixed generator gives a fixed round — which is what lets a spec know the word.
    expect(pickWords(3, () => 0)).toEqual(pickWords(3, () => 0));
  });
});

// ─── 3. The round ────────────────────────────────────────────────────────────

describe("a round", () => {
  test("nothing plays in the lobby, and start_game opens the round with the intro to read", async () => {
    const player = scriptedPlayer();
    const ctx = player.ctx();
    expect(at(ctx)).toBe("lobby");
    for (const call of [
      run("relay_description", { description: "it is tall" }, ctx),
      run("skip_word", ctx),
      run("repeat_word", ctx),
      run("final_score", ctx),
    ]) {
      const refused = expectDialogRefused(await call, "lobby");
      expect(refused.error).toMatch(/start_game/);
    }
    // No clock is armed before a round.
    expect(gameFlow.timeout(ctx)).toBeUndefined();

    const started = expectDialogOk<{ word: string; intro: string; wordsInRound: number }>(
      await run("start_game", ctx),
    );
    expect(started.state).toBe("playing");
    expect(started.result.wordsInRound).toBe(20);
    expect(started.result.intro).toBe(
      "Welcome to Word Wrangler! I'll give you words to describe, and the A.I. player will try to " +
        `guess them. Remember, don't say any part of the word itself. Here's your first word: ${started.result.word}.`,
    );
    expect(gameView(gameSlot.get(ctx))).toMatchObject({
      phase: "playing",
      word: started.result.word,
      score: 0,
      wordsLeft: 20,
    });
    // The two-minute clock IS the state's deadline, and it fires TIME_UP.
    expect(gameFlow.timeout(ctx)).toEqual({
      afterMs: GAME_SECONDS * 1000,
      event: { type: "TIME_UP" },
    });
    // A round cannot be restarted from under the describer.
    expectDialogRefused(await run("start_game", ctx), "playing");
  });

  test("a wrong guess is relayed and remembered; a right one scores and moves the word on", async () => {
    const player = scriptedPlayer();
    const ctx = player.ctx();
    const word = await startRound(ctx);

    player.guess("zzzz");
    const wrong = expectDialogOk<{ verdict: string; playerSaid: string; score: number }>(
      await run("relay_description", { description: "you find it at the zoo" }, ctx),
    );
    expect(wrong.result).toMatchObject({ verdict: "wrong", playerSaid: "Is it a zzzz?", score: 0 });
    // The position did NOT move — which is what keeps the clock a wall clock.
    expect(wrong.state).toBe("playing");
    expect(gameSlot.get(ctx)).toMatchObject({
      wrongGuesses: ["zzzz"],
      descriptions: ["you find it at the zoo"],
    });
    // The player was handed this word's description and nothing about any other word.
    expect(player.model.calls[0]?.prompt).toContain("1. you find it at the zoo");
    expect(player.model.calls[0]?.prompt).toContain("None yet.");

    player.guess(word);
    const right = expectDialogOk<{ verdict: string; score: number; nextWord: string | null }>(
      await run("relay_description", { description: "it has spots and a long neck" }, ctx),
    );
    expect(right.result).toMatchObject({ verdict: "correct", score: 1 });
    expect(right.result.nextWord).toBe(currentWord(gameSlot.get(ctx)));
    expect(right.result.nextWord).not.toBe(word);
    // The second call carried both descriptions AND the wrong guess, so the
    // player could not repeat it.
    expect(player.model.calls[1]?.prompt).toContain("2. it has spots and a long neck");
    expect(player.model.calls[1]?.prompt).toContain("- zzzz");
    const game = gameSlot.get(ctx);
    expect(game.rounds).toEqual([{ word, outcome: "solved", guesses: 1 }]);
    expect(game.descriptions).toEqual([]);
    expect(game.wrongGuesses).toEqual([]);
  });

  test("saying the word is a foul: the word is forfeited and the player is never asked", async () => {
    const player = scriptedPlayer();
    const ctx = player.ctx();
    const word = await startRound(ctx);
    const foul = expectDialogOk<{ verdict: string; word: string; score: number; nextWord: string }>(
      await run("relay_description", { description: `well, it's a ${word}, obviously` }, ctx),
    );
    expect(foul.result).toMatchObject({ verdict: "foul", word, score: 0 });
    expect(player.model.calls).toHaveLength(0);
    expect(gameSlot.get(ctx)).toMatchObject({
      fouls: 1,
      index: 1,
      rounds: [{ word, outcome: "fouled", guesses: 0 }],
    });
  });

  test("the foul check reads the describer's own transcript, not only the host's relay", async () => {
    const player = scriptedPlayer();
    // The host sanitized the word out of what it passed; the caller's turn still has it.
    const ctx = player.ctx();
    const word = await startRound(ctx);
    const laundered = createToolContext({
      generate: player.model.generate,
      messages: [{ role: "user", content: `Okay so the word is ${word}, how do I describe that` }],
    });
    gameSlot.set(
      laundered,
      structuredClone(gameSlot.get(ctx)) as Parameters<typeof gameSlot.set>[1],
    );
    gameFlow.send(laundered, { type: "STARTED" });
    const foul = expectDialogOk<{ verdict: string }>(
      await run("relay_description", { description: "something you would describe" }, laundered),
    );
    expect(foul.result.verdict).toBe("foul");
    expect(player.model.calls).toHaveLength(0);
  });

  test("skip moves on without a point; repeat says the word and changes nothing", async () => {
    const player = scriptedPlayer();
    const ctx = player.ctx();
    const word = await startRound(ctx);
    const said = expectDialogOk<{ word: string; say: string }>(await run("repeat_word", ctx));
    expect(said.result).toMatchObject({ word, say: `Your word is ${word}.` });

    const skipped = expectDialogOk<{ skipped: string; nextWord: string; score: number }>(
      await run("skip_word", ctx),
    );
    expect(skipped.result).toMatchObject({ skipped: word, score: 0 });
    expect(skipped.result.nextWord).toBe(currentWord(gameSlot.get(ctx)));
    expect(gameSlot.get(ctx)).toMatchObject({ skips: 1, index: 1 });
    expect(skipped.state).toBe("playing");
  });

  test("the last word solved ends the round, and final_score closes it", async () => {
    const player = scriptedPlayer();
    const ctx = player.ctx();
    await startRound(ctx);
    // Shrink the round to one word so the last solve is reachable.
    gameSlot.update(ctx, (game) => {
      game.words = ["lantern"];
    });
    player.guess("lanterns");
    const last = expectDialogOk<{ verdict: string; nextWord: string | null }>(
      await run("relay_description", { description: "you carry it to light the way" }, ctx),
    );
    expect(last.result).toMatchObject({ verdict: "correct", nextWord: null });
    expect(last.state).toBe("over");
    // Nothing plays after the round.
    expectDialogRefused(await run("relay_description", { description: "more" }, ctx), "over");

    const final = expectDialogOk<{ score: number; best: number; solved: string[]; say: string }>(
      await run("final_score", ctx),
    );
    expect(final.result).toMatchObject({ score: 1, best: 1, solved: ["lantern"] });
    expect(final.result.say).toContain("Your final score is 1 point.");
    expect(gameView(gameSlot.get(ctx)).phase).toBe("over");

    // Another round: the score resets, the best survives.
    expectDialogOk(await run("start_game", ctx));
    expect(at(ctx)).toBe("playing");
    expect(gameSlot.get(ctx)).toMatchObject({ score: 0, best: 1, index: 0 });
  });

  test("a description arriving after two minutes ends the round even if the deadline was lost", async () => {
    const player = scriptedPlayer();
    const ctx = player.ctx();
    await startRound(ctx);
    const startedAt = gameSlot.get(ctx).startedAt ?? 0;
    expect(secondsLeft(gameSlot.get(ctx), startedAt)).toBe(GAME_SECONDS);
    // The process restarted and the timer with it; the slot's own clock still knows.
    vi.spyOn(Date, "now").mockReturnValue(startedAt + GAME_SECONDS * 1000 + 1);
    const late = expectDialogOk<{ verdict: string }>(
      await run("relay_description", { description: "too late" }, ctx),
    );
    expect(late.result.verdict).toBe("time_up");
    expect(late.state).toBe("over");
    expect(player.model.calls).toHaveLength(0);
  });

  test("the clock firing is a dialog move, and the scoreboard follows the slot", async () => {
    const player = scriptedPlayer();
    const ctx = player.ctx();
    await startRound(ctx);
    // What the runtime does when the two minutes elapse.
    const deadline = gameFlow.timeout(ctx);
    if (deadline === undefined) throw new Error("no deadline armed");
    expect(gameFlow.send(ctx, deadline.event as { type: "TIME_UP" }).state).toBe("over");
    // The projection still reads `playing` until final_score stamps the end — the
    // client's own countdown is what shows the describer the clock ran out.
    expect(gameView(gameSlot.get(ctx)).phase).toBe("playing");
    expectDialogOk(await run("final_score", ctx));
    expect(gameView(gameSlot.get(ctx)).phase).toBe("over");
  });

  test("an untouched session projects the idle frame the client renders first", () => {
    expect(gameProjection()).toMatchObject({
      phase: "idle",
      word: null,
      score: 0,
      wordsLeft: 0,
      rounds: [],
    });
  });

  test("the player's prompt is built from this word alone", () => {
    const prompt = playerPrompt({ descriptions: ["a", "b"], wrongGuesses: ["x"] });
    expect(prompt).toContain("1. a\n2. b");
    expect(prompt).toContain("- x");
    expect(playerPrompt({ descriptions: ["a"], wrongGuesses: [] })).toContain("None yet.");
  });

  test("two contexts never share a round", async () => {
    const player = scriptedPlayer();
    const a = player.ctx();
    const b = player.ctx();
    await startRound(a);
    expect(at(b)).toBe("lobby");
    expect(gameSlot.get(b).startedAt).toBeNull();
  });
});
