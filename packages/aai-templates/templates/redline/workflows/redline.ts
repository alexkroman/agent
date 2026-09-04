/**
 * The durable half of the redline desk: write, critique, revise — in a loop
 * whose length the CRITIC decides.
 *
 * The rules a workflow body lives under are spelled out in
 * `research-workflow/workflows/research.ts` and `link-digest/workflows/digest.ts`:
 * the body is replayed from the top on every resume, so it holds no live handle
 * and makes no undurable decision, and a step's arguments and result cross a
 * queue. Read those first. What THIS one adds is the shape neither of them has:
 * **a loop whose exit is decided at run time**.
 *
 * ## A journaled result is what makes a data-dependent loop legal
 *
 * `transcription-workflow` derives its fan-out's WIDTH from a step's journaled
 * result, and its module doc gives the rule. This is the same rule spent on a
 * different thing: `critique` returns a verdict, the body breaks on it, and a
 * replay reads that verdict back out of the journal and takes the same branch.
 * Deciding it any other way — a clock, a random draw, a re-read of something
 * outside the run — would let a replay diverge. A step is identified by its
 * NAME plus the number of times that name has been reached in this run, so a
 * branch that takes a different path on replay reads a journal entry that was
 * written for a different call, rather than producing a slightly different essay.
 *
 * ## Why durability earns its keep here, specifically
 *
 * A three-round redline is up to seven model calls in sequence, each of them
 * long-form. That is minutes, not seconds — nobody is going to sit on a phone
 * for it, which is why this is a workflow app rather than a voice agent — and
 * it is exactly the work you do not want to redo: a rate limit in round three
 * replays rounds one and two from the journal for free and re-issues only the
 * call that failed. Each stage is its own step for that reason, not because
 * three functions read more tidily than one.
 */

import type { WorkflowCtx } from "@alexkroman1/aai";
import { stepReport } from "@alexkroman1/aai/step";
import {
  FatalError,
  stepGenerateJsonOrFail,
  stepGenerateOrFail,
} from "@alexkroman1/aai/step-errors";
import { countWords } from "@alexkroman1/aai/utils";
import { z } from "zod";
import { CRITIC_SYSTEM, REVISER_SYSTEM, WRITER_SYSTEM } from "./prompts.ts";

/** Shortest brief worth writing from. Below this the piece would be invention. */
export const MIN_BRIEF_CHARS = 20;

/** Notes one critique may return — their prompt asks for three at most. */
export const MAX_NOTES = 3;

/** What the form collects, once the page has mapped its fields. */
export interface RedlineInput {
  brief: string;
  audience: string;
  /** Critique-and-revise rounds this run may spend. Their `should_continue` cap. */
  rounds: number;
  /** Points the piece must cover. An ARRAY, which is why the page writes that
   *  field by hand — `<WorkflowFields>` renders scalars only. */
  mustCover: string[];
}

export interface Critique {
  verdict: "ship" | "revise";
  /** 1–10, for the page. Nothing branches on it — the verdict is the decision. */
  score: number;
  notes: string[];
}

/**
 * What the critic is asked to reply with, as something that CHECKS.
 *
 * `stepGenerateJson` validates against this, so a reply that missed is a plain
 * throw and therefore a retry — where the hand-written `isCritique` guard this
 * replaces had to restate every field's type by hand. The VERDICT is strict
 * because the body branches on it; the score is deliberately not, and is
 * clamped at the call site instead (see `critiqueDraft`).
 */
const CritiqueReply = z.object({
  verdict: z.enum(["ship", "revise"]),
  score: z.number(),
  notes: z.array(z.string()),
});

/** One round, as the page renders it and the journal records it. */
export interface Round {
  round: number;
  critique: Critique;
  /** Absent on the round that shipped: nothing was revised after it. */
  revisedWords?: number;
}

/**
 * Write, then critique and revise until the critic ships it or the rounds run
 * out.
 *
 * Whatever this returns is what a completed run reports as `output`, so it is
 * the page's render model — and `WorkflowOutputOf<typeof redline>` in
 * `client.tsx` is that type, derived rather than restated.
 */
export async function redlineFlow(input: RedlineInput, ctx: WorkflowCtx) {
  // The three `maxAttempts` below were `maxRetries` properties on the functions
  // (3, 5, 3 — retries AFTER the first attempt, so 4, 6, 4 in all). The policy
  // is an argument to the CALL now, which is where it belongs: the same function
  // called from two places may deserve different patience.
  let draft = await ctx.step("writeDraft", () => writeDraft(input), { maxAttempts: 4 });
  const rounds: Round[] = [];
  let shipped = false;

  for (let round = 1; round <= input.rounds; round++) {
    // ONE call site in a loop, which is exactly what `(name, occurrence)` step
    // identity is for: this is `critiqueDraft#0`, `critiqueDraft#1`, … so each
    // round journals separately and a resume replays the rounds already done.
    const critique = await ctx.step("critiqueDraft", () => critiqueDraft(draft, input, round), {
      maxAttempts: 6,
    });

    if (critique.verdict === "ship") {
      // The break is decided by a STEP'S JOURNALED RESULT, which is what makes
      // it replay-stable — see the module doc.
      rounds.push({ round, critique });
      shipped = true;
      break;
    }

    draft = await ctx.step("reviseDraft", () => reviseDraft(draft, critique, input, round), {
      maxAttempts: 4,
    });
    rounds.push({ round, critique, revisedWords: countWords(draft) });
  }

  return {
    draft,
    words: countWords(draft),
    roundsRun: rounds.length,
    /** True when the CRITIC stopped the loop, false when the budget did. */
    shipped,
    rounds,
  };
}

/** Their `generation_node`, first pass. */
export async function writeDraft(input: RedlineInput): Promise<string> {
  if (input.brief.trim().length < MIN_BRIEF_CHARS) {
    // Fatal rather than retryable: the same brief is the same brief on every
    // attempt, and four more model calls will not make it longer.
    //
    // Not redundant with the schema's `.min(20)`, which counts CHARACTERS: a
    // brief of twenty spaces passes validation at `start()` and arrives here
    // as nothing to write from.
    throw new FatalError(
      `The brief is too short to write from — give at least ${MIN_BRIEF_CHARS} characters of it.`,
    );
  }

  await stepReport(`Writing the first draft for ${input.audience}.`);
  // No empty-reply guard here or in `reviseDraft`, and that is not an omission:
  // `stepGenerate` already refuses an empty completion, as a RETRYABLE
  // `StepGenerateError` — which is the right answer, and one a hand-written
  // check would have to re-derive.
  const draft = await stepGenerateOrFail(briefBlock(input), { system: WRITER_SYSTEM });
  return draft.trim();
}

/**
 * Their `reflection_node`: grade the draft against its brief.
 *
 * Its own step rather than part of the revision, because the two fail
 * differently and because this one's RESULT is what the body branches on — a
 * revision folded into the same step would put the decision and the expensive
 * rewrite behind one journal entry.
 */
export async function critiqueDraft(
  draft: string,
  input: RedlineInput,
  round: number,
): Promise<Critique> {
  await stepReport(`Round ${round}: reading it back critically.`);
  // `stepGenerateJson` owns the fence, the parse, the non-object case and the
  // shape — and throws PLAINLY when any of them misses, unlike the fatal one
  // above: a model that answered with prose may well obey on the next attempt.
  const parsed = await stepGenerateJsonOrFail(`${briefBlock(input)}\n\nThe submission:\n${draft}`, {
    schema: CritiqueReply,
    system: CRITIC_SYSTEM,
  });

  const critique: Critique = {
    verdict: parsed.verdict,
    // The SCORE is still clamped here rather than in the schema: a model that
    // answered 11 has still answered, and the number is worth keeping at the
    // edge of the range rather than costing a whole retry.
    score: clampScore(parsed.score),
    notes: parsed.notes.slice(0, MAX_NOTES),
  };
  await stepReport(
    critique.verdict === "ship"
      ? `Round ${round}: the critic would ship it (${critique.score}/10).`
      : `Round ${round}: ${critique.notes.length} note(s) to address (${critique.score}/10).`,
  );
  return critique;
}

/** Their generation node re-entered with the critique. */
export async function reviseDraft(
  draft: string,
  critique: Critique,
  input: RedlineInput,
  round: number,
): Promise<string> {
  await stepReport(`Round ${round}: revising.`);
  const revised = await stepGenerateOrFail(
    [
      briefBlock(input),
      `Your current draft:\n${draft}`,
      `The critique:\n${critique.notes.map((note, index) => `${index + 1}. ${note}`).join("\n")}`,
    ].join("\n\n"),
    { system: REVISER_SYSTEM },
  );
  return revised.trim();
}

// ---- Pure helpers -----------------------------------------------------------

/** The brief as every stage restates it, so the three cannot drift apart. */
export function briefBlock(input: RedlineInput): string {
  const must =
    input.mustCover.length > 0
      ? `Must cover:\n${input.mustCover.map((point) => `- ${point}`).join("\n")}`
      : "Must cover: nothing specific was named.";
  return [`Brief: ${input.brief}`, `Audience: ${input.audience}`, must].join("\n\n");
}

/** Scores arrive from a model, so they arrive out of range often enough. */
export function clampScore(score: number): number {
  if (!Number.isFinite(score)) return 0;
  return Math.min(10, Math.max(1, Math.round(score)));
}

// ---- The model call ---------------------------------------------------------
//
// There is no local `ask()` any more, and its absence is the point. The SDK
// classifies the gateway's failure (`StepGenerateError.retryable`) and stops
// there — whether a terminal failure should burn the step's remaining attempts
// is the caller's call — so `stepGenerateOrFail` and
// `stepGenerateJsonOrFail` (`@alexkroman1/aai/step-errors`) are that call
// made one way: terminal stays terminal, and a rate limit becomes a
// `RetryableError` carrying the delay the gateway itself named, which beats
// `RetryableError`'s own one-second default. Three templates each wrapped the
// raw `/step` call to say that; the wrapper is a suffix on the import now.
