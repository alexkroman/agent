// An EVAL: does the desk really run the FLOW, or does it rank people itself?
//
// `agent.test.ts` settles what each tool does once it has been called — it
// scripts the evaluator and the coordinator and asserts on the table. What it
// cannot settle is the two things this port exists to demonstrate: that the
// MODEL, told "screen them", spends ONE `screen_candidates` call and reads the
// evaluator's top three back rather than forming its own opinion of twelve
// bios, and that "weight TypeScript more" becomes `rescore_with_feedback` with
// the caller's words in it rather than a re-ordered list the desk made up.
//
// Run it with `aai eval`. Without a provider key every case runs against a
// SCRIPTED model — `stubReply` for the turn, `stubGenerate` for the evaluator,
// whose calls resolve a model instance of their own — which proves the wiring
// and nothing about the choice, so the two claims above are `{ live: true }`.
// The gate case is the mirror: a competent model does not call a tool its
// prompt says is not yet available, so the refusal can only be OBSERVED under a
// script that forces the call.
//
// **`system-prompt.md` is applied HERE, not by `agent.ts`.** The build discovers
// the file, so an eval driving the raw default export would run this agent with
// the FRAMEWORK DEFAULT prompt — and "do not rank applicants yourself" is the
// discipline the whole file measures.

/** The def a DEPLOYED agent runs: authored, plus what `tools/` declares, plus its PROMPT. */
import agentDef from "virtual:aai/agent";
import { dialogRefusalPattern, dialogResultSchema } from "@alexkroman1/aai/testing";
import { countWords } from "@alexkroman1/aai/utils";
import {
  describeTurn,
  type EvalSession,
  expectCalled,
  lastStateIn,
  toolNames,
  toolResultIn,
} from "@alexkroman1/aai-runtime/eval";
import { describeEval } from "@alexkroman1/aai-runtime/eval/vitest";
import { expect } from "vitest";
import { z } from "zod";
import { LEADS, MAX_FEEDBACK_ROUNDS, SHORTLIST_SIZE } from "./shared.ts";

/**
 * Every tool the desk declares, typed out rather than derived, so the negative
 * below — nothing else was called — is a second, independent statement of what
 * this agent may do.
 */
const DESK_TOOLS: readonly string[] = [
  "screen_candidates",
  "rescore_with_feedback",
  "proceed_to_emails",
  "candidate_details",
  "read_email",
  "screening_status",
];

/**
 * What the BROWSER is sent, as this eval reads it — parsed rather than cast, so
 * a projection that stopped matching fails naming the field.
 */
const ProjectedHiring = z.object({
  jobTitle: z.string().nullable(),
  leaderboard: z.array(z.object({ name: z.string(), score: z.number(), rank: z.number() })),
  rounds: z.number(),
  feedback: z.array(z.string()),
  drafts: z.array(z.unknown()),
});

const hiringState = (session: EvalSession) => lastStateIn(session.events(), ProjectedHiring);

/** What `screen_candidates` answers with. */
const Screened = z.object({
  screened: z.number(),
  top: z.array(
    z.object({ rank: z.number(), name: z.string(), score: z.number(), reason: z.string() }),
  ),
  state: z.string(),
});

/**
 * What `rescore_with_feedback` answers with, inside the dialog's envelope —
 * asked of the SDK rather than restated, which is the drift the comment used to
 * assert away.
 */
const Rescored = dialogResultSchema(
  z.object({
    round: z.number(),
    feedbackApplied: z.array(z.string()),
    top: z.array(z.object({ name: z.string() })),
  }),
);

/** What `screening_status` answers with on an untouched desk. */
const IdleStatus = z.object({ stage: z.string(), state: z.string(), screened: z.number() });

/** The evaluator's verdict, as the JSON a scripted `ctx.generate` returns. The
 *  script's last line repeats, so every applicant scores the same — enough to
 *  prove twelve calls were made and a table was written, which is all a script
 *  can prove. */
const FLAT_VERDICT = JSON.stringify({ score: 71, reason: "Scripted: a fair match." });

describeEval(agentDef, (test) => {
  test(
    "the stage the desk reports is the flow's, and an untouched desk spends no evaluator",
    async ({ session }) => {
      const turn = await session.say("Where are we with this?");

      expect(toolNames(turn.toolCalls), describeTurn(turn)).toEqual(["screening_status"]);
      // `stage` comes off `hiringFlow.position`, and `state` is the position
      // itself — deriving either from "is there a job" is the drift the dialog
      // exists to end, and it would show up here.
      const status = toolResultIn(turn.toolCalls, "screening_status", IdleStatus);
      expect(status).toMatchObject({ stage: "nothing screened yet", state: "idle", screened: 0 });
      expect(hiringState(session)?.leaderboard ?? []).toEqual([]);
    },
    {
      stubReply: [
        { tool: "screening_status", args: {} },
        "Nothing's been screened yet — want me to run the applicants for the React role?",
      ],
    },
  );

  test(
    "no feedback can be applied before there is a ranking",
    async ({ session }) => {
      const turn = await session.say("Just weight TypeScript more heavily and score them.");

      // Their router is only reachable after `score_leads`. The script FORCES
      // the call so the gate really runs; the refusal names the position and
      // quotes the state's instruction so the model can recover on its turn.
      const attempts = turn.toolCalls.filter((call) => call.name === "rescore_with_feedback");
      expect(attempts, describeTurn(turn)).toHaveLength(1);
      for (const attempt of attempts) {
        expect(attempt.result).toMatch(dialogRefusalPattern("idle"));
        expect(attempt.result).toMatch(/screen_candidates/);
      }
      expect(hiringState(session)?.rounds ?? 0).toBe(0);
    },
    {
      // A gate can only be observed refusing if something CALLS the gated tool,
      // and a live model, told the tool is not yet available, sensibly does not.
      scripted: true,
      stubReply: [
        { tool: "rescore_with_feedback", args: { feedback: "weight TypeScript more heavily" } },
        "I haven't screened anyone yet — shall I run them against the React role first?",
      ],
    },
  );

  test(
    "a screening is one call, one evaluation per applicant, and the top three come back",
    async ({ session }) => {
      const turn = await session.say(
        "Yes, the Junior React Developer contract — screen the applicants for me.",
      );

      // ONE call: their `load_leads` and `score_leads` are one tool, and a desk
      // that called it once per applicant, or once per read-back, is spending
      // twelve evaluations each time.
      const calls = turn.toolCalls.filter((call) => call.name === "screen_candidates");
      expect(calls, describeTurn(turn)).toHaveLength(1);
      const screened = toolResultIn(turn.toolCalls, "screen_candidates", Screened);
      expect(screened.screened).toBe(LEADS.length);
      expect(screened.top).toHaveLength(SHORTLIST_SIZE);
      expect(screened.top.map((one) => one.rank)).toEqual([1, 2, 3]);
      expect(screened.state).toBe("reviewing");
      // The browser was sent the whole table, not the three the caller heard.
      const view = hiringState(session);
      expect(view?.leaderboard).toHaveLength(LEADS.length);
      // CONTAINS, not equals: the title is whatever the desk passed through from
      // the caller, who said "the Junior React Developer contract" — so a model
      // that carried the word "contract" across was being faithful, and pinning
      // the exact string failed it for that.
      expect(view?.jobTitle).toContain("Junior React Developer");
      // Nothing outside the desk's own six tools was called: the evaluator is a
      // `ctx.generate` inside a tool, never a tool the desk holds.
      expect(toolNames(turn.toolCalls).filter((name) => !DESK_TOOLS.includes(name))).toEqual([]);
      expect(turn.text).not.toBe("");
    },
    {
      stubReply: [
        { tool: "screen_candidates", args: {} },
        "All twelve are scored. The top three are Priya, Sofia and Tom — want the reasons?",
      ],
      stubGenerate: [FLAT_VERDICT],
    },
  );

  test(
    "scores are the evaluator's, spread apart, and the desk does not rank from its own reading",
    async ({ session }) => {
      const turn = await session.say(
        "Screen the applicants for the Junior React Developer role and tell me who stands out.",
      );

      const calls = turn.toolCalls.filter((call) => call.name === "screen_candidates");
      expect(calls, describeTurn(turn)).toHaveLength(1);
      const screened = toolResultIn(turn.toolCalls, "screen_candidates", Screened);
      // Their "don't use numbers like 100, 75, or 50" rule, measured — but only
      // as far as the rule can reach. Each candidate is a SEPARATE
      // `ctx.generate` that never sees the others' numbers, so two independent
      // evaluations landing on the same score is arithmetic rather than a
      // failure, and demanding all three distinct failed this case on a 2-of-3
      // collision. What the rule actually buys is numbers specific enough that
      // the sort is a RANKING and not the three-way tie at 75 it was written
      // against.
      const scores = screened.top.map((one) => one.score);
      expect(new Set(scores).size, JSON.stringify(scores)).toBeGreaterThan(1);
      for (const score of scores) expect([50, 75, 100]).not.toContain(score);
      // And the read-back order IS those numbers sorted — not the desk's own
      // view of twelve bios.
      expect([...scores].sort((a, b) => b - a)).toEqual(scores);
      for (const one of screened.top) expect(one.reason.length).toBeGreaterThan(30);
      // What the caller HEARS names the evaluator's top pick. A desk that read
      // twelve bios and formed its own view would name whoever it fancied.
      const first = screened.top[0]?.name.split(" ")[0] ?? "";
      expect(turn.text).toContain(first);
      expect(toolNames(turn.toolCalls).filter((name) => !DESK_TOOLS.includes(name))).toEqual([]);
    },
    // Live only: a script cannot spread the scores, and the spread is the claim.
    { live: true },
  );

  test(
    "the caller's feedback reaches the evaluator as a re-score, in their own words",
    async ({ session }) => {
      await session.say("Screen the applicants for the Junior React Developer contract.");
      expect(hiringState(session)?.leaderboard.length ?? 0).toBe(LEADS.length);

      const turn = await session.say(
        "Hmm. I care much more about TypeScript depth than about years of experience — " +
          "score them again with that in mind.",
      );

      // Option 2 of their router. The desk must not re-order the list itself —
      // it has no scores of its own to re-order by — and it must not screen from
      // scratch, which would throw the ranking the caller just heard away.
      const names = toolNames(turn.toolCalls);
      expectCalled(turn, "rescore_with_feedback");
      expect(names).not.toContain("screen_candidates");
      const rescored = toolResultIn(turn.toolCalls, "rescore_with_feedback", Rescored);
      expect(rescored.state).toBe("reviewing");
      expect(rescored.result.round).toBe(1);
      // The feedback is the caller's, carried whole — not a keyword.
      const feedback = rescored.result.feedbackApplied.at(-1) ?? "";
      expect(feedback.toLowerCase()).toContain("typescript");
      expect(countWords(feedback)).toBeGreaterThan(3);
      expect(rescored.result.top).toHaveLength(SHORTLIST_SIZE);
      const view = hiringState(session);
      expect(view?.rounds).toBe(1);
      expect(view?.rounds).toBeLessThanOrEqual(MAX_FEEDBACK_ROUNDS);
      expect(view?.feedback).toHaveLength(1);
    },
    // Live only: choosing option 2 over a fresh screening IS the measurement.
    { live: true },
  );
});
