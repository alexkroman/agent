import agentDef from "virtual:aai/agent";
import type { Message, ToolContext } from "@alexkroman1/aai";
import { createSeededRandom } from "@alexkroman1/aai";
import type { ToolContextOverrides } from "@alexkroman1/aai-runtime/testing";
import {
  createToolContext,
  expectDialogRefused,
  expectSlotContract,
  expectToolOk,
  fireEvent,
  sessionEvent,
  stubGenerate,
} from "@alexkroman1/aai-runtime/testing";
import { describeAgent } from "@alexkroman1/aai-runtime/testing/vitest";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { gameFlow, TIME_UP_LINE } from "./game.ts";
import { containsWord, isCorrectGuess, normalizeWord } from "./guess.ts";
import { PLAYER_SYSTEM, playerPrompt } from "./player.ts";
import {
  currentWord,
  GAME_CAPS,
  GAME_SECONDS,
  gameSlot,
  gameView,
  secondsLeft,
  WORDS_PER_GAME,
} from "./shared.ts";
// The tool FILES: each default export is the object `agentDef` registers, so
// `run(startGame, …)` is typed by the def — arguments and result, gate included.
import finalScore from "./tools/final_score.ts";
import relayDescription from "./tools/relay_description.ts";
import repeatWord from "./tools/repeat_word.ts";
import skipWord from "./tools/skip_word.ts";
import startGame from "./tools/start_game.ts";
import { allWords, pickWords, WORD_CATEGORIES } from "./words.ts";

// ─── Harness ─────────────────────────────────────────────────────────────────

// `start_game` arms a two-minute `setTimeout` (`armTimeUpLine`). Faked for every
// test so a round a test opens and abandons leaves no real timer behind; the
// clock itself stays real. Section 4 drives the fake clock on purpose.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});
afterEach(() => {
  vi.useRealTimers();
});

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
    routes: {
      [PLAYER_SYSTEM]: () => ({ object: { guess: nextGuess, remark: `Is it a ${nextGuess}?` } }),
    },
  });
  return {
    model,
    /**
     * A context whose player will answer `guess` next. The overrides are
     * `createToolContext`'s own — a spec that wants a seeded `random` or a
     * conversation behind the call fills in that field and nothing else.
     */
    ctx: (overrides: ToolContextOverrides = {}) =>
      createToolContext({ generate: model.generate, messages: [], ...overrides }),
    guess(word: string) {
      nextGuess = word;
    },
  };
}

/**
 * A turn the RUNTIME handed the tool: what `ctx.messages` holds.
 *
 * Pair it with {@link heard} below. The two are different evidence of the same
 * describer — this is the conversation a tool call arrives with, that is the
 * transcript stream — and `relay_description` rules a foul off either.
 */
const saidAloud = (content: string): Message => ({ role: "user", content });

/**
 * What the describer said, delivered the way the RUNTIME delivers it — through
 * the def's own `events`. `game.spoken` is maintained by something the model
 * never calls, and nothing else in this file would notice if the hook stopped
 * running.
 */
const heard = (text: string, ctx: ToolContext) =>
  fireEvent(agentDef, sessionEvent("userTranscript.committed", { text }), ctx);

describeAgent(agentDef, (run) => {
  /** Start a round and hand back the word the describer is looking at. */
  async function startRound(ctx: ToolContext): Promise<string> {
    expectToolOk(await run(startGame, ctx));
    const word = currentWord(gameSlot.get(ctx));
    if (word === null) throw new Error("no word after start_game");
    return word;
  }

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
      // A SEEDED generator gives a fixed round — which is what lets a spec know
      // the word. `createSeededRandom` rather than a `() => 0` stand-in: a
      // constant is not a shuffle, so it would pin the arithmetic to a degenerate
      // case the real game never draws.
      expect(pickWords(3, createSeededRandom(7))).toEqual(pickWords(3, createSeededRandom(7)));
      expect(pickWords(3, createSeededRandom(7))).not.toEqual(pickWords(3, createSeededRandom(8)));
    });
  });

  // ─── 3. The round ────────────────────────────────────────────────────────────

  describe("a round", () => {
    test("nothing plays in the lobby, and start_game opens the round with the intro to read", async () => {
      const player = scriptedPlayer();
      const ctx = player.ctx();
      expect(at(ctx)).toBe("lobby");
      for (const call of [
        run(relayDescription, { description: "it is tall" }, ctx),
        run(skipWord, ctx),
        run(repeatWord, ctx),
        run(finalScore, ctx),
      ]) {
        const refused = expectDialogRefused(await call, "lobby");
        expect(refused.error).toMatch(/start_game/);
      }
      // No clock is armed before a round.
      expect(gameFlow.timeout(ctx)).toBeUndefined();

      const started = expectToolOk(await run(startGame, ctx));
      expect(at(ctx)).toBe("playing");
      expect(started.wordsInRound).toBe(20);
      expect(started.intro).toBe(
        "Welcome to Word Wrangler! I'll give you words to describe, and the A.I. player will try to " +
          `guess them. Remember, don't say any part of the word itself. Here's your first word: ${started.word}.`,
      );
      expect(gameView(gameSlot.get(ctx))).toMatchObject({
        phase: "playing",
        word: started.word,
        score: 0,
        wordsLeft: 20,
      });
      // The two-minute clock IS the state's deadline, and it fires TIME_UP.
      expect(gameFlow.timeout(ctx)).toEqual({
        afterMs: GAME_SECONDS * 1000,
        event: { type: "TIME_UP" },
      });
      // A round cannot be restarted from under the describer.
      expectDialogRefused(await run(startGame, ctx), "playing");
    });

    test("a wrong guess is relayed and remembered; a right one scores and moves the word on", async () => {
      const player = scriptedPlayer();
      const ctx = player.ctx();
      const word = await startRound(ctx);

      player.guess("zzzz");
      const wrong = expectToolOk(
        await run(relayDescription, { description: "you find it at the zoo" }, ctx),
      );
      expect(wrong).toMatchObject({ verdict: "wrong", playerSaid: "Is it a zzzz?", score: 0 });
      // The position did NOT move — which is what keeps the clock a wall clock.
      expect(at(ctx)).toBe("playing");
      expect(gameSlot.get(ctx)).toMatchObject({
        wrongGuesses: ["zzzz"],
        descriptions: ["you find it at the zoo"],
      });
      // The player was handed this word's description and nothing about any other word.
      expect(player.model.calls[0]?.prompt).toContain("1. you find it at the zoo");
      expect(player.model.calls[0]?.prompt).toContain("None yet.");

      player.guess(word);
      const right = expectToolOk(
        await run(relayDescription, { description: "it has spots and a long neck" }, ctx),
      );
      if (right.verdict !== "correct") throw new Error(`expected a point, got ${right.verdict}`);
      expect(right.score).toBe(1);
      expect(right.nextWord).toBe(currentWord(gameSlot.get(ctx)));
      expect(right.nextWord).not.toBe(word);
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
      const foul = expectToolOk(
        await run(relayDescription, { description: `well, it's a ${word}, obviously` }, ctx),
      );
      expect(foul).toMatchObject({ verdict: "foul", word, score: 0 });
      expect(player.model.calls).toHaveLength(0);
      // The round LOG is the fact; the foul count and the position are read off it.
      expect(gameSlot.get(ctx)).toMatchObject({
        rounds: [{ word, outcome: "fouled", guesses: 0 }],
      });
      expect(gameView(gameSlot.get(ctx))).toMatchObject({ fouls: 1, score: 0 });
    });

    test("the foul check reads the describer's own transcript, not only the host's relay", async () => {
      const player = scriptedPlayer();
      // The host sanitized the word out of what it passed; the caller's turn still has it.
      const ctx = player.ctx();
      const word = await startRound(ctx);
      const laundered = player.ctx({
        messages: [saidAloud(`Okay so the word is ${word}, how do I describe that`)],
      });
      gameSlot.set(laundered, gameSlot.snapshot(ctx));
      gameFlow.send(laundered, { type: "STARTED" });
      const foul = expectToolOk(
        await run(relayDescription, { description: "something you would describe" }, laundered),
      );
      expect(foul.verdict).toBe("foul");
      expect(player.model.calls).toHaveLength(0);
    });

    test("skip moves on without a point; repeat says the word and changes nothing", async () => {
      const player = scriptedPlayer();
      const ctx = player.ctx();
      const word = await startRound(ctx);
      const said = expectToolOk(await run(repeatWord, ctx));
      expect(said).toMatchObject({ word, say: `Your word is ${word}.` });

      const skipped = expectToolOk(await run(skipWord, ctx));
      expect(skipped).toMatchObject({ skipped: word, score: 0 });
      expect(skipped.nextWord).toBe(currentWord(gameSlot.get(ctx)));
      expect(gameSlot.get(ctx)).toMatchObject({ rounds: [{ word, outcome: "skipped" }] });
      expect(gameView(gameSlot.get(ctx))).toMatchObject({ skips: 1, score: 0 });
      expect(at(ctx)).toBe("playing");
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
      const last = expectToolOk(
        await run(relayDescription, { description: "you carry it to light the way" }, ctx),
      );
      expect(last).toMatchObject({ verdict: "correct", nextWord: null });
      expect(at(ctx)).toBe("over");
      // Nothing plays after the round.
      expectDialogRefused(await run(relayDescription, { description: "more" }, ctx), "over");

      const final = expectToolOk(await run(finalScore, ctx));
      expect(final).toMatchObject({ score: 1, best: 1, solved: ["lantern"] });
      expect(final.say).toContain("Your final score is 1 point.");
      expect(gameView(gameSlot.get(ctx)).phase).toBe("over");

      // Another round: the score resets, the best survives.
      expectToolOk(await run(startGame, ctx));
      expect(at(ctx)).toBe("playing");
      expect(gameSlot.get(ctx)).toMatchObject({ best: 1, rounds: [] });
      expect(gameView(gameSlot.get(ctx))).toMatchObject({ score: 0, best: 1 });
    });

    test("a description arriving after two minutes ends the round even if the deadline was lost", async () => {
      const player = scriptedPlayer();
      // The tools read `ctx.now()`, so the clock is the spec's to set.
      let now = 1_700_000_000_000;
      const ctx = player.ctx({ now: () => now });
      await startRound(ctx);
      const startedAt = gameSlot.get(ctx).startedAt ?? 0;
      expect(secondsLeft(gameSlot.get(ctx), startedAt)).toBe(GAME_SECONDS);
      // The process restarted and the timer with it; the slot's own clock still knows.
      now = startedAt + GAME_SECONDS * 1000 + 1;
      const late = expectToolOk(await run(relayDescription, { description: "too late" }, ctx));
      expect(late.verdict).toBe("time_up");
      expect(at(ctx)).toBe("over");
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
      expectToolOk(await run(finalScore, ctx));
      expect(gameView(gameSlot.get(ctx)).phase).toBe("over");
    });

    test("an untouched session projects the idle frame the client renders first", () => {
      expect(gameSlot.projected()).toMatchObject({
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

    test("a foul the host never relayed is still a foul: the hook heard it", async () => {
      const player = scriptedPlayer();
      const ctx = player.ctx();
      const word = await startRound(ctx);
      // Two committed turns, neither of them the one the host relays below, and
      // `ctx.messages` is empty — so `game.spoken` is the only evidence there is.
      await heard(`hmm, ${word}, how would you even describe that`, ctx);
      await heard("okay, here goes", ctx);
      await heard("   ", ctx); // blank: nothing to record, and nothing recorded
      expect(gameSlot.get(ctx).spoken).toEqual([
        `hmm, ${word}, how would you even describe that`,
        "okay, here goes",
      ]);

      const foul = expectToolOk(
        await run(relayDescription, { description: "okay, here goes" }, ctx),
      );
      expect(foul).toMatchObject({ verdict: "foul", word });
      expect(player.model.calls).toHaveLength(0);
      // Settling the word clears what was said about it, so the next word starts
      // clean and cannot inherit a foul.
      expect(gameSlot.get(ctx).spoken).toEqual([]);
    });

    test("the per-word lists are capped on the slot, keeping the newest clue", () => {
      // The newest clue is the one the player should be guessing from.
      expectSlotContract(gameSlot, {
        write: (game) => {
          game.spoken.push("clue");
        },
        caps: GAME_CAPS,
      });
    });

    test("the round log is deliberately NOT capped", async () => {
      // `rounds` carries no cap, and this is why: its length IS the index into
      // `words`, so dropping the oldest entry would rewind the describer.
      const ctx = scriptedPlayer().ctx();
      await startRound(ctx);
      for (let i = 0; i < 15; i++) expectToolOk(await run(skipWord, ctx));
      const played = gameSlot.get(ctx);
      expect(played.rounds).toHaveLength(15);
      expect(currentWord(played)).toBe(played.words[15]);
    });

    test("a seeded round is reproducible, which is what `ctx.random` is for", async () => {
      const player = scriptedPlayer();
      const a = player.ctx({ random: createSeededRandom(4242) });
      const b = player.ctx({ random: createSeededRandom(4242) });
      const c = player.ctx({ random: createSeededRandom(1) });
      const [wordA, wordB, wordC] = [await startRound(a), await startRound(b), await startRound(c)];
      expect(wordA).toBe(wordB);
      expect(gameSlot.get(a).words).toEqual(gameSlot.get(b).words);
      expect(wordC).not.toBe(wordA);
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

  // ─── 4. "Time's up!", on the clock ───────────────────────────────────────────

  describe("the time-up line", () => {
    /** Run `body` on fake timers, restoring the real ones whatever happens. */
    async function onFakeTimers(body: () => Promise<void>): Promise<void> {
      vi.useFakeTimers();
      try {
        await body();
      } finally {
        vi.useRealTimers();
      }
    }

    test("is said verbatim, cutting the host off, the moment the two minutes are up", () =>
      onFakeTimers(async () => {
        const ctx = scriptedPlayer().ctx();
        await startRound(ctx);
        await vi.advanceTimersByTimeAsync(GAME_SECONDS * 1000 - 1);
        expect(ctx.said).toEqual([]);
        await vi.advanceTimersByTimeAsync(1);
        expect(ctx.said).toEqual([
          { text: TIME_UP_LINE, interrupt: true, interruptible: false, record: true },
        ]);
      }));

    test("stays silent when the WORDS ran out first — time was not up", () =>
      onFakeTimers(async () => {
        const ctx = scriptedPlayer().ctx();
        await startRound(ctx);
        for (let i = 0; i < WORDS_PER_GAME; i++) await run(skipWord, ctx);
        expect(at(ctx)).toBe("over");
        await vi.advanceTimersByTimeAsync(GAME_SECONDS * 1000);
        expect(ctx.said).toEqual([]);
      }));

    test("a timer from an earlier round says nothing into the next one", () =>
      onFakeTimers(async () => {
        const ctx = scriptedPlayer().ctx();
        await startRound(ctx);
        for (let i = 0; i < WORDS_PER_GAME; i++) await run(skipWord, ctx);
        expectToolOk(await run(finalScore, ctx));
        await vi.advanceTimersByTimeAsync(1000);
        await startRound(ctx);
        // The first round's timer fires here, one second before the second's.
        await vi.advanceTimersByTimeAsync(GAME_SECONDS * 1000 - 1000);
        expect(ctx.said).toEqual([]);
        await vi.advanceTimersByTimeAsync(1000);
        expect(ctx.said).toEqual([
          { text: TIME_UP_LINE, interrupt: true, interruptible: false, record: true },
        ]);
      }));
  });
});
