/**
 * The two crews — and where they come from.
 *
 * **Adapted from CrewAI's `lead-score-flow` example** (MIT,
 * <https://github.com/crewAIInc/crewAI-examples>, `flows/lead-score-flow`):
 * two single-agent crews driven by a `Flow`, with a human choosing between
 * three options in the middle. It is the most complex example that repository
 * ships — two crews, a cyclic `@router`, Pydantic state and structured output,
 * and two `asyncio.gather` fan-outs — and the only one with a person in the
 * loop, which is what a voice agent fundamentally is.
 *
 * | lead-score-flow | here |
 * | --- | --- |
 * | `LeadScoreState` (Pydantic flow state) | `HiringState` in `shared.ts`, one `sessionSlot` |
 * | `Flow` with `@start` / `@listen(or_)` / `@router` | `hiringFlow` in `shared.ts`, a `dialog()` |
 * | `load_leads` + `score_leads` | `tools/screen_candidates.ts` |
 * | `human_in_the_loop` (the `input()` menu) | the `reviewing` state and its three ways out |
 * | option 2, `"scored_leads_feedback"` | `tools/rescore_with_feedback.ts`, bounded |
 * | option 3, `"generate_emails"` → `write_and_save_emails` | `tools/proceed_to_emails.ts` |
 * | option 1, `exit()` | hanging up |
 * | `LeadScoreCrew` → `hr_evaluation_agent` + `evaluate_candidate` | {@link scoreCandidate}, a `ctx.generate` with a schema |
 * | `CandidateScore` (`output_pydantic`) | {@link candidateScoreSchema} |
 * | `LeadResponseCrew` → `email_followup_agent` + `send_followup_email` | {@link emailWriter}, a `subagent()` |
 * | `asyncio.gather` over `kickoff_async` | `mapSettled`, a bounded window that settles per item |
 * | `email_responses/<name>.txt` | `Draft`s in the slot, read back by `tools/read_email.ts` |
 * | `JOB_DESCRIPTION` / `leads.csv` | `DEFAULT_JOB` / `leads.json` |
 *
 * **Which SDK primitive a crew task becomes is decided by its OUTPUT, and the
 * two crews land on different ones.** `evaluate_candidate` declares
 * `output_pydantic=CandidateScore` — a shape — and `ctx.generate({ schema })`
 * IS `output_pydantic`: one call, validated on the way back, no loop to run.
 * `send_followup_email` produces prose with a rule no schema can carry (it has
 * to be signed, it has to open with a subject the desk can read out), and
 * that is what `subagent()` with `expectedOutput` and a `guardrail` is for.
 * The SDK's own doc on `expectedOutput` cites CrewAI's `expected_output` as
 * the split it copies, so the second crew ports almost line for line.
 *
 * **What a CrewAI agent's prompt actually looks like is kept.** Their
 * `role`/`goal`/`backstory` are not three fields the model sees; they are
 * rendered through one template (`translations/en.json`, `role_playing`), and
 * {@link crewAgentPrompt} renders the same one. What is DROPPED is the ReAct
 * scaffolding around it — `Thought: I now can give a great answer` /
 * `Final Answer:` — because a tool-calling model has no free-text action
 * format to parse and a schema call has no "final answer" to extract.
 *
 * **Three things the port had to change for a phone**, each stated where it
 * lives: the score's `reason` is two sentences rather than "detailed
 * reasoning", because it is read aloud; the feedback loop gained a bound; and
 * the returned score is stored under the id the desk ASKED about rather than
 * the id the model echoed back (see `CandidateScore` in `shared.ts`).
 */

import {
  DEFAULT_GUARDRAIL_MAX_RETRIES,
  type DelegateFn,
  type DelegateResult,
  type GenerateFn,
  type SubagentGuardrail,
  subagent,
} from "@alexkroman1/aai";
import { mapSettled, type Settled } from "@alexkroman1/aai/step";
import { z } from "zod";
import type { Candidate, CandidateScore, Draft, JobDescription } from "./shared.ts";

// ─── CrewAI's agent prompt ───────────────────────────────────────────────────

/** Their `agents.yaml` entry: the three fields every CrewAI agent is. */
export interface CrewAgent {
  role: string;
  goal: string;
  backstory: string;
}

/**
 * Their `role_playing` template, verbatim: how CrewAI turns an `agents.yaml`
 * entry into a system prompt. Rendered here so the two agents below read to a
 * model exactly as they read to CrewAI's.
 */
export function crewAgentPrompt(agent: CrewAgent): string {
  return `You are ${agent.role}. ${agent.backstory}\nYour personal goal is: ${agent.goal}`;
}

/**
 * Their `expected_output` template, verbatim — the sentence CrewAI appends to
 * every task description. The second line is the reason `expected_output` is a
 * separate field there and `expectedOutput` is one here: an agent told only
 * what to DO stops when it is done, which is the wrong moment to stop talking.
 */
export function crewExpectedOutput(expected: string): string {
  return (
    `\nThis is the expected criteria for your final answer: ${expected}\n` +
    "you MUST return the actual complete content as the final answer, not a summary."
  );
}

// ─── Crew A: LeadScoreCrew ───────────────────────────────────────────────────

/** Their `hr_evaluation_agent`, verbatim. */
export const HR_EVALUATION_AGENT: CrewAgent = {
  role: "Senior HR Evaluation Expert",
  goal:
    "Analyze candidates' qualifications and compare them against the job description to " +
    "provide a score and reasoning.",
  backstory:
    "As a Senior HR Evaluation Expert, you have extensive experience in assessing candidate " +
    "profiles. You excel at evaluating how well candidates match job descriptions by analyzing " +
    "their skills, experience, cultural fit, and growth potential. Your professional background " +
    "allows you to provide comprehensive evaluations with clear reasoning.",
};

/**
 * The evaluator's system prompt — the constant `stubGenerate` routes on, which
 * is why it is exported rather than inlined at the call.
 */
export const EVALUATOR_SYSTEM = crewAgentPrompt(HR_EVALUATION_AGENT);

/**
 * Their `CandidateScore`, as the schema the call is validated against.
 *
 * No `id` — see `CandidateScore` in `shared.ts`. The reason is capped and asked
 * for in two sentences, because it is the thing the desk reads down the phone
 * for each of the top three; theirs asks for "detailed reasoning" that a
 * notebook can scroll.
 */
export const candidateScoreSchema = z.object({
  score: z
    .number()
    .int()
    .min(1)
    .max(100)
    .describe("1 to 100. A specific number such as 87, 63 or 42 — never a round one"),
  reason: z
    .string()
    .max(500)
    .describe("Why, in two spoken sentences: skill match, experience, fit, growth potential"),
});

/**
 * Their `evaluate_candidate` task description, kept close to verbatim, with
 * the feedback rounds where their `{additional_instructions}` placeholder was.
 *
 * The "don't use numbers like 100, 75, or 50" line is theirs and it is the
 * best line in the file: it forces the scores apart so the sort produces a
 * ranking rather than a three-way tie at 75.
 */
export function evaluationTask(
  candidate: Candidate,
  job: JobDescription,
  feedback: readonly string[],
): string {
  const additional =
    feedback.length === 0
      ? ""
      : "\nThe hiring manager has reviewed an earlier ranking and asked for these adjustments, " +
        `in order — apply every one of them:\n${feedback.map((entry) => `- ${entry}`).join("\n")}\n`;
  return (
    [
      "Evaluate a candidate's bio based on the provided job description.",
      "",
      "Use your expertise to carefully assess how well the candidate fits the job requirements.",
      "Consider key factors such as:",
      "- Skill match",
      "- Relevant experience",
      "- Cultural fit",
      "- Growth potential",
      "",
      "CANDIDATE BIO",
      "-------------",
      `Candidate ID: ${candidate.id}`,
      `Name: ${candidate.name}`,
      `Bio: ${candidate.bio}`,
      `Skills: ${candidate.skills}`,
      "",
      "JOB DESCRIPTION",
      "---------------",
      `Title: ${job.title}`,
      job.description,
      "",
      "ADDITIONAL INSTRUCTIONS",
      "-----------------------",
      "Your final answer MUST include:",
      "- A score between 1 and 100. Don't use numbers like 100, 75, or 50. Instead, use specific",
      "  numbers like 87, 63, or 42.",
      "- Your reasoning, considering the candidate's skill match, experience, cultural fit, and",
      "  growth potential — in two sentences, because it will be read aloud.",
      additional,
    ].join("\n") +
    crewExpectedOutput(
      "A very specific score from 1 to 100 for the candidate, along with the reasoning " +
        "explaining why you assigned this score.",
    )
  );
}

/** Their `LeadScoreCrew().crew().kickoff_async(…)`, for one candidate. */
export async function scoreCandidate(
  generate: GenerateFn,
  candidate: Candidate,
  job: JobDescription,
  feedback: readonly string[],
): Promise<CandidateScore> {
  const { object } = await generate({
    system: EVALUATOR_SYSTEM,
    prompt: evaluationTask(candidate, job, feedback),
    schema: candidateScoreSchema,
  });
  return { score: object.score, reason: object.reason };
}

/**
 * Evaluations in flight at once.
 *
 * Their `score_leads` is `asyncio.gather` over every candidate — thirty model
 * calls issued in the same instant, which is the shape that meets a provider's
 * rate limit as thirty 429s together. `mapSettled` is the same fan-out
 * through a window: the caller still waits for roughly the slowest few rather
 * than the sum, and a limit arrives as one refusal rather than a wall of them.
 */
export const SCORING_CONCURRENCY = 6;

/** What one evaluation came back as — settled, so a failed one is a value
 *  beside the candidate it was for. */
export type Scored = Settled<Candidate, CandidateScore>;

/**
 * Their `score_leads`: every candidate through Crew A, concurrently.
 *
 * Settled per candidate rather than raced to the first rejection, for the
 * reason `briefing-desk` settles its angles: a caller on the phone would rather
 * hear eleven scores and one apology than an error, and the one that failed
 * is named so the desk can offer to score them again. `mapSettled` is that
 * policy — the `try` around each item, the window, and the item kept beside
 * its outcome — written once.
 */
export function scoreRoster(
  generate: GenerateFn,
  candidates: readonly Candidate[],
  job: JobDescription,
  feedback: readonly string[],
  onSettled: () => void = () => {},
): Promise<Scored[]> {
  return mapSettled(candidates, SCORING_CONCURRENCY, async (candidate) => {
    // In a `finally`, so a candidate the evaluator refused ticks too: the wait
    // is over for that one either way, and a ticker that never reaches the
    // total reads to whoever is watching as a hang.
    try {
      return await scoreCandidate(generate, candidate, job, feedback);
    } finally {
      onSettled();
    }
  });
}

// ─── Crew B: LeadResponseCrew ────────────────────────────────────────────────

/** Their `email_followup_agent`, verbatim — Sarah, by name, which is the one
 *  fact about her the guardrail below can check. */
export const EMAIL_FOLLOWUP_AGENT: CrewAgent = {
  role: "HR Coordinator",
  goal:
    "Compose personalized follow-up emails to candidates based on their bio and whether they " +
    "are being pursued for the job. If we are proceeding, request availability for a Zoom call. " +
    "Otherwise, send a polite rejection email.",
  backstory:
    "You are an HR professional named Sarah who works at CrewAI with excellent communication " +
    "skills and a talent for crafting personalized and thoughtful emails to job candidates. You " +
    "understand the importance of maintaining a positive and professional tone in all " +
    "correspondence.",
};

/** The coordinator's name, as the guardrail looks for it. */
export const COORDINATOR_NAME = "Sarah";

/**
 * Their `send_followup_email` `expected_output`, plus the two structural
 * requirements the desk depends on and their prose could only hope for.
 */
export const EMAIL_EXPECTED_OUTPUT =
  "A personalized email based on the candidate's information. It should be professional and " +
  "respectful, either inviting them for a Zoom call or letting them know we are pursuing other " +
  "candidates. Begin with a single line `Subject: …`, then a blank line, then the body, and " +
  `sign off with your name, ${COORDINATOR_NAME}. Nothing before the subject line and nothing ` +
  "after the sign-off.";

/**
 * The coordinator's guardrail — and the worked example of a check no schema
 * could do.
 *
 * The desk reads a draft's SUBJECT down the phone ("I've drafted 'Next steps
 * on your application' to Priya") and cannot from an email that has none; and
 * an email from a named coordinator that is not signed is one the candidate
 * cannot reply to by name. Both were in their `expected_output` as hopes.
 * Asking for the two in the prompt and hoping is what every version before a
 * guardrail did; the check is two lines and the retry is one more run of a
 * one-step subagent.
 */
export const emailGuardrail: SubagentGuardrail = ({ text }) => {
  if (!/^\s*Subject:\s*\S/m.test(text)) {
    return (
      "Start the email with one line reading `Subject: …` — the desk reads the subject " +
      "out to the hiring manager and cannot from an email that has none."
    );
  }
  if (!new RegExp(`\\b${COORDINATOR_NAME}\\b`).test(text)) {
    return `Sign the email as ${COORDINATOR_NAME}, so the candidate has a name to reply to.`;
  }
  return true;
};

/**
 * What a complaint buys the coordinator: one more run, and no more.
 *
 * CrewAI's task `guardrail` retries three times; the SDK's default is
 * {@link DEFAULT_GUARDRAIL_MAX_RETRIES}, which is one, and one is the right
 * budget on a phone. Every retry is another twelfth of a fan-out a caller is
 * holding the line through, and the two things this guardrail checks — a
 * subject line, a signature — are ones a model that missed them twice is not
 * about to produce on a third pass. What the budget buys instead is the flag:
 * an exhausted draft still comes back, marked `accepted: false`, and the desk
 * says it needs a look.
 *
 * Written out rather than inherited, because a retry budget nobody can see at
 * the declaration is a budget nobody decided.
 */
export const EMAIL_GUARDRAIL_RETRIES = DEFAULT_GUARDRAIL_MAX_RETRIES;

/**
 * Their `LeadResponseCrew`: `email_followup_agent` running
 * `send_followup_email`.
 *
 * A subagent with NO tools, which is exactly what their agent is
 * (`allow_delegation=False`, no `tools=`): a writing pass. One step, because
 * there is nothing to look up — the whole brief rides in the task.
 */
export const emailWriter = subagent({
  name: "hr-coordinator",
  systemPrompt: crewAgentPrompt(EMAIL_FOLLOWUP_AGENT),
  expectedOutput: EMAIL_EXPECTED_OUTPUT,
  guardrail: emailGuardrail,
  maxRetries: EMAIL_GUARDRAIL_RETRIES,
  maxSteps: 1,
});

/**
 * Their `send_followup_email` task description, close to verbatim, with the
 * role's title added — theirs never told the coordinator which job the
 * candidate had applied for, and an email that names it reads as written by
 * someone who knows.
 */
export function emailTask(candidate: Candidate, job: JobDescription, proceed: boolean): string {
  return [
    "Compose a personalized follow-up email for a candidate who applied to a specific job.",
    "",
    "You will use the candidate's name, bio, and whether the company wants to proceed with",
    "them to generate the email. If the candidate is proceeding, ask them for their",
    "availability for a Zoom call in the upcoming days. If not, send a polite rejection email.",
    "",
    "CANDIDATE DETAILS",
    "-----------------",
    `Candidate ID: ${candidate.id}`,
    `Name: ${candidate.name}`,
    `Bio: ${candidate.bio}`,
    "",
    `ROLE APPLIED FOR: ${job.title}`,
    `PROCEEDING WITH CANDIDATE: ${proceed ? "True" : "False"}`,
    "",
    "ADDITIONAL INSTRUCTIONS",
    "-----------------------",
    "- If we are proceeding, ask for their availability for a Zoom call within the next few days.",
    "- If we are not proceeding, send a polite rejection email, acknowledging their effort in",
    "  applying and appreciating their time.",
  ].join("\n");
}

/**
 * Split a coordinator's email into the subject the desk reads out and the
 * body it does not. The guardrail guarantees the `Subject:` line on an ACCEPTED
 * draft; an unaccepted one may lack it, and then the whole text is the body and
 * the subject says so.
 */
export function parseEmail(text: string): { subject: string; body: string } {
  const match = text.match(/^\s*Subject:[ \t]*(.+)$/m);
  if (!match) return { subject: "(no subject)", body: text.trim() };
  const subject = (match[1] ?? "").trim();
  const body = text.slice((match.index ?? 0) + match[0].length).trim();
  return { subject, body };
}

/**
 * Their `write_email`, for one candidate: hand the brief to Crew B and keep
 * what came back as a {@link Draft}. Takes the DELEGATE rather than the tool
 * context, so a spec drives it with `stubDelegate` and nothing else.
 */
export async function writeEmail(
  delegate: DelegateFn,
  candidate: Candidate,
  job: JobDescription,
  proceed: boolean,
): Promise<Draft> {
  const result: DelegateResult = await delegate(emailWriter, {
    task: emailTask(candidate, job, proceed),
  });
  const { subject, body } = parseEmail(result.text);
  return { candidateId: candidate.id, proceed, subject, body, accepted: result.accepted };
}

/** Emails in flight at once — one per candidate, so the same argument as
 *  {@link SCORING_CONCURRENCY}. */
export const EMAIL_CONCURRENCY = 6;

/** What one email came back as. */
export type Drafted = Settled<Candidate, Draft>;

/**
 * Their `write_and_save_emails`: EVERY candidate gets an email, and the
 * shortlist decides which kind. Settled per candidate, as {@link scoreRoster}.
 */
export function draftEmails(
  delegate: DelegateFn,
  candidates: readonly Candidate[],
  job: JobDescription,
  shortlist: ReadonlySet<string>,
  onSettled: () => void = () => {},
): Promise<Drafted[]> {
  return mapSettled(candidates, EMAIL_CONCURRENCY, async (candidate) => {
    try {
      return await writeEmail(delegate, candidate, job, shortlist.has(candidate.id));
    } finally {
      onSettled();
    }
  });
}
