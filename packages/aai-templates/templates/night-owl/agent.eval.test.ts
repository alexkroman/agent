// An EVAL: does the companion actually pick from its own shelf?
//
// `agent.test.ts` calls `recommend` directly, which settles what the tool does
// with a category and a mood it is handed. What it cannot settle is whether the
// MODEL turns "something cozy to watch" into `{ category: "movie", mood:
// "cozy" }` rather than reciting three films it likes — and whether the night's
// log, which lives in a `sessionSlot`, is still there two turns later.
//
// Run it with `aai eval`. Without a provider key every case runs against a
// SCRIPTED model (its `stubReply`): the real session, the real slot, the real
// tool, a fake reply. That proves the wiring and nothing about the choice.

/**
 * The def a DEPLOYED agent runs: authored, plus what `tools/` declares.
 *
 * The glob is written HERE rather than reached for from a shared helper because
 * this file SHIPS — a scaffolded project has no repo helper to import. Without
 * it the eval would drive an agent with no `recommend` at all, which is the one
 * failure a green eval must never be able to hide.
 *
 * And plus its PROMPT. `agent.ts` does not declare one — `system-prompt.md` is
 * resolved by the BUILD (`aai build`/`aai deploy`), so the raw default export
 * carries the FRAMEWORK DEFAULT prompt. An eval that drives it measures a
 * different agent than the one that deploys, and every tool-choice claim below
 * then passes or fails for the wrong reason.
 */
import agentDef from "virtual:aai/agent";
import type { SessionEvent } from "@alexkroman1/aai/protocol";
import {
  createVmRunCode,
  customEventsIn,
  lastStateIn,
  toolArgsIn,
  toolResultIn,
} from "@alexkroman1/aai-runtime/eval";
import { describeEval } from "@alexkroman1/aai-runtime/eval/vitest";
import { expect } from "vitest";
import { z } from "zod";
import { CATEGORIES, MOODS } from "./shared.ts";

/**
 * One `recommend` answer, and the whole projection, as the wire carries them.
 *
 * Schemas rather than casts, which is what `toolResultIn` and `lastStateIn`
 * take one for: a shelf or a projection that stopped matching FAILS here naming
 * the field, where a cast hands the assertions `undefined` and fails a line
 * later on something unrelated.
 */
const RecSchema = z.object({
  category: z.enum(CATEGORIES),
  mood: z.enum(MOODS),
  picks: z.array(z.string()),
});
const ProjectedNight = z.object({ recs: z.array(RecSchema) });

/**
 * The night's log as the PAGE has it: the last `syncState` frame pushed.
 *
 * This agent declares one projection, so the frame IS `nightProjection`'s
 * result — the same `{ recs }` value `useAgentState(nightProjection)` reads in
 * `client.tsx`. Asserting on it is asserting on what the sidebar shows.
 */
const pushedRecs = (events: readonly SessionEvent[]) =>
  lastStateIn(events, ProjectedNight)?.recs ?? [];

/** The `wind_down` nudges in `events` — `customEventsIn` filters by name. */
const nudges = (events: readonly SessionEvent[]) => customEventsIn(events, "wind_down");

/**
 * A `run_code` executor, so the sleep-cycle case can assert the bedtime NUMBER
 * and not merely the call — this template's headline feature is the arithmetic.
 * `createVmRunCode`'s own doc carries why the builtin refuses without one.
 */
const runCode = createVmRunCode();

/**
 * The `code` argument a `run_code` call carries.
 *
 * The schema is what `toolArgsIn` takes one for: `args` is
 * `Record<string, unknown>` on the wire — the model wrote it and nothing
 * validated it — so the `String(c.args.code ?? "")` this replaced turned an
 * argument the companion renamed, or never sent, into `""`, and the two
 * constants asserted below would have been looked for in nothing at all.
 */
const RunCodeArgs = z.object({ code: z.string() });

/** Two-digit, for the clock arithmetic below. */
const pad = (n: number): string => String(n).padStart(2, "0");

/**
 * Every bedtime `system-prompt.md`'s recipe admits for a given wake-up hour,
 * in each of the spellings a tutor might print it in.
 *
 * Derived from the recipe rather than typed out — 90 minutes a cycle plus 15 to
 * fall asleep, wrapped into the previous day — so this and the prompt cannot
 * disagree about the arithmetic the case is checking.
 */
const bedtimesFor = (wakeHour: number): string[] =>
  [3, 4, 5, 6].flatMap((cycles) => {
    const at = (wakeHour * 60 - (cycles * 90 + 15) + 1440) % 1440;
    const hour = Math.floor(at / 60);
    const minute = pad(at % 60);
    // Three spellings per time, because the prompt asks for HH:MM and a tutor
    // reasonably prints any of them: padded, unpadded (measured — a live run
    // printed "0:45" for four cycles), and the 12-hour clock.
    return [
      `${pad(hour)}:${minute}`,
      `${hour}:${minute}`,
      `${hour % 12 === 0 ? 12 : hour % 12}:${minute}`,
    ];
  });

describeEval(
  agentDef,
  (test) => {
    test(
      "turns a mood into the category and mood the tool takes",
      async ({ session }) => {
        const turn = await session.say("I want something cozy to watch tonight.");

        // "to watch" is the category and "cozy" is the mood; the shelf is the
        // tool's, so answering from the model's own taste is the regression.
        expect(turn.toolCalls.map((c) => c.name)).toEqual(["recommend"]);
        const call = turn.toolCalls[0]!;
        expect(call.args).toEqual({ category: "movie", mood: "cozy" });

        // And what it read out came back from the shelf: the tool answers with
        // the picks for exactly the pair it was asked for.
        const rec = toolResultIn(turn.toolCalls, "recommend", RecSchema);
        expect(rec).toMatchObject({ category: "movie", mood: "cozy" });
        expect(rec.picks.length).toBeGreaterThan(0);
        // It read out what the shelf handed back rather than a title of its own.
        expect(rec.picks.some((pick) => turn.text.includes(pick))).toBe(true);
      },
      {
        stubReply: [
          { tool: "recommend", args: { category: "movie", mood: "cozy" } },
          "Paddington 2 is the coziest thing I own.",
        ],
      },
    );

    test(
      "the night's log keeps what an earlier turn picked, newest first",
      async ({ session }) => {
        await session.say("I want something cozy to watch tonight.");
        const turn = await session.say("Now give me something spooky to read.");

        expect(turn.toolCalls.map((c) => c.name)).toEqual(["recommend"]);
        expect(turn.toolCalls[0]!.args).toEqual({ category: "book", mood: "spooky" });

        // The slot survived the turn boundary: the frame the page renders after
        // the second answer still carries the first, and the newest is first —
        // which is the order the sidebar lists them in.
        const recs = pushedRecs(session.events());
        expect(recs.map((r) => `${r.category}/${r.mood}`)).toEqual(["book/spooky", "movie/cozy"]);
      },
      {
        stubReply: [
          { tool: "recommend", args: { category: "movie", mood: "cozy" } },
          "Paddington 2 it is.",
          { tool: "recommend", args: { category: "book", mood: "spooky" } },
          "Mexican Gothic, then.",
        ],
      },
    );

    test(
      "the wind-down nudge arrives once, on the third pick",
      async ({ session }) => {
        const first = await session.say("I want something cozy to watch tonight.");
        expect(nudges(first.events)).toEqual([]);
        const second = await session.say("Now give me something spooky to read.");
        expect(nudges(second.events)).toEqual([]);

        // Counted in the SLOT, so the third pick is only the third if the two
        // before it were still there — and it is a `ctx.send`, not a field on the
        // projection, so it must arrive exactly once and never be replayed.
        const third = await session.say("And some chill music too.");
        expect(nudges(third.events)).toHaveLength(1);

        const fourth = await session.say("One funny book as well, please.");
        expect(nudges(fourth.events)).toEqual([]);
        expect(nudges(session.events())).toHaveLength(1);
        expect(pushedRecs(session.events())).toHaveLength(4);
      },
      {
        stubReply: [
          { tool: "recommend", args: { category: "movie", mood: "cozy" } },
          "Paddington 2 it is.",
          { tool: "recommend", args: { category: "book", mood: "spooky" } },
          "Mexican Gothic, then.",
          { tool: "recommend", args: { category: "music", mood: "chill" } },
          "Tycho, Dive.",
          { tool: "recommend", args: { category: "book", mood: "funny" } },
          "Good Omens.",
        ],
      },
    );
    test(
      "works the bedtime out in CODE, and the number is right",
      async ({ session }) => {
        const turn = await session.say(
          "I need to be up at 7 in the morning. When should I fall asleep?",
        );

        // The CALLS, not their arguments: what this asserts is that the companion
        // reached for code at all, and the results are read off the same list
        // below. `toolArgsIn` answers the other half, the code it submitted.
        const ran = turn.toolCalls.filter((c) => c.name === "run_code");
        expect(
          ran,
          `tools called: [${turn.toolCalls.map((c) => c.name).join(", ")}]; said: ${turn.text}`,
        ).not.toEqual([]);
        // The recipe is the prompt's, and it is two constants: a 90-minute cycle
        // plus the 15 minutes it takes to fall asleep. Arithmetic done in the
        // model's head has neither of them anywhere in the code.
        const code = toolArgsIn(turn.toolCalls, "run_code", RunCodeArgs)
          .map((args) => args.code)
          .join("\n");
        expect(code).toContain("90");
        expect(code).toContain("15");

        const output = ran.map((c) => c.result ?? "").join("\n");
        // The builtin really EXECUTED. With no `runCode` executor this string is
        // "run_code is only available in the sandboxed runtime", which every
        // assertion about a CALL sails past — so this template's headline
        // feature could be checked as a call and never as an answer.
        expect(output).not.toMatch(/only available in the sandboxed runtime/);
        // And the answer is a whole number of cycles back from 07:00 with the
        // quarter hour added. A tutor that dropped the 15 lands on :00 and a
        // tutor that guessed lands anywhere; both fail here.
        expect(output, `run_code printed: ${output}`).toMatch(new RegExp(bedtimesFor(7).join("|")));
      },
      {
        stubReply: [
          {
            tool: "run_code",
            args: {
              code: [
                "const wake = 7 * 60;",
                "const at = (wake - (6 * 90 + 15) + 1440) % 1440;",
                "const two = (n) => String(n).padStart(2, '0');",
                "console.log(two(Math.floor(at / 60)) + ':' + two(at % 60));",
              ].join("\n"),
            },
          },
          "Aim for nine forty-five tonight — that's six full cycles before seven.",
        ],
      },
    );
  },
  // `runCode` is what makes the case above about an ANSWER rather than a call.
  { runCode },
);
