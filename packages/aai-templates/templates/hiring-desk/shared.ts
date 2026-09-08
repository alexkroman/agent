/**
 * The desk's state, the shape of the call, and what the browser is shown.
 *
 * **The state is CrewAI's `LeadScoreState`, field for field, plus what a phone
 * call needs on top.** Theirs is `{candidates, candidate_score,
 * hydrated_candidates, scored_leads_feedback}`; {@link HiringState} holds the
 * first two as a roster and a score table keyed by candidate id, drops the
 * third (a JOIN of the first two, derived here by {@link ranked} rather than
 * stored beside them where the two copies could disagree), and turns the
 * fourth into a LIST — one entry per round of feedback, because a caller who
 * says "more weight on TypeScript" and then "and ignore years of experience"
 * means both, where their `input()` overwrote the first with the second.
 *
 * Two things theirs has no field for, because a script that runs once needs
 * none: `rounds`, the guard from their `self_evaluation_loop_flow` (see
 * {@link MAX_FEEDBACK_ROUNDS}), and `drafts`, which is their
 * `email_responses/*.txt` directory held in the session instead of on disk —
 * a desk on a phone reads a draft back; it does not open a folder.
 *
 * **A screening does not survive the call, and that is a decision.** One
 * `sessionSlot`, keyed per session, so two hiring managers screening at once
 * never see each other's shortlist. `crews.ts` holds the two crews; `tools/`
 * holds the flow's steps.
 */

import {
  type DeepReadonly,
  type DialogEvent,
  type DialogPosition,
  type DialogSpec,
  dialog,
  type ResolveOneOptions,
  resolveOne,
  type StateProjection,
  sessionSlot,
  type ToolContext,
  type ToolFailure,
} from "@alexkroman1/aai";
import leads from "./leads.json" with { type: "json" };

// ─── The roster and the job ──────────────────────────────────────────────────

/** Their `Candidate` — one row of `leads.csv`. */
export interface Candidate {
  id: string;
  name: string;
  email: string;
  bio: string;
  skills: string;
}

/**
 * Their `leads.csv`, as a bundled asset.
 *
 * Twelve rather than their thirty: every screening round is one model call
 * per candidate, run while a caller holds the line, and twelve is enough to
 * make a ranking worth reading back without making the wait worth apologizing
 * for. A real desk swaps this import for a lookup against its applicant
 * tracking system; the tools never read the file directly, only the roster
 * `screen_candidates` loads into the slot.
 */
export const LEADS: readonly Candidate[] = leads;

/** Their `JobDescription` — declared in their `types.py` and never used, since
 *  the JD was a flat string constant. It is used here: a caller may describe
 *  a different role than the one shipped. */
export interface JobDescription {
  title: string;
  description: string;
}

/**
 * Their `JOB_DESCRIPTION` constant, condensed. The default the desk screens
 * against when the caller names no other role.
 */
export const DEFAULT_JOB: JobDescription = {
  title: "Junior React Developer",
  description: [
    "A twelve-month contract on a small product team building AI features into a",
    "consumer web app. The developer works in Next.js with TypeScript, ships",
    "streaming AI features on the Vercel AI SDK, integrates REST APIs, and pairs",
    "with a designer on Tailwind-based UI.",
    "",
    "Qualifications: one to three years of React experience, or a strong",
    "portfolio of shipped projects; comfort with TypeScript; some exposure to",
    "Next.js and to building on an LLM API; Git and code review as a daily",
    "habit. The team values people who learn quickly, communicate clearly, and",
    "have shipped something end to end, and it is happy to grow someone into",
    "the AI SDK work.",
  ].join("\n"),
};

// ─── Scores and drafts ───────────────────────────────────────────────────────

/**
 * Their `CandidateScore`, minus the `id`.
 *
 * Their evaluator returns the candidate's id in its own output and
 * `combine_candidates_with_scores` JOINS on it — so a model that echoes the
 * wrong id, or the id of the candidate it just scored, quietly writes one
 * candidate's verdict against another's name. The desk knows which candidate
 * it asked about; the score is stored under THAT id, and the model is not
 * asked to repeat it.
 */
export interface CandidateScore {
  /** 1–100. */
  score: number;
  /** Why — read back down the phone, so two sentences rather than a report. */
  reason: string;
}

/** One file of their `email_responses/` directory, held in the session. */
export interface Draft {
  candidateId: string;
  /** Their `proceed_with_candidate`: an invitation, or a polite no. */
  proceed: boolean;
  /** The `Subject:` line, which the desk reads out rather than the body. */
  subject: string;
  body: string;
  /**
   * Whether the coordinator's guardrail accepted this draft. A draft that
   * exhausted its retries still comes back — the caller is on the phone — but
   * the desk must say it needs a look rather than present it as finished.
   */
  accepted: boolean;
}

export interface HiringState {
  /** The role being screened for; `null` until `screen_candidates` runs. */
  job: JobDescription | null;
  /** Their `candidates`: the roster loaded for this screening. */
  candidates: Candidate[];
  /** Their `candidate_score`, keyed by candidate id. */
  scores: Record<string, CandidateScore>;
  /** Candidates whose evaluation FAILED this round, so the desk can say so. */
  unscored: string[];
  /** Their `scored_leads_feedback`, one entry per round, oldest first. */
  feedback: string[];
  /** Feedback rounds taken so far — the loop counter theirs did not have. */
  rounds: number;
  /** Their `top_candidate_ids`: who the caller chose to proceed with. */
  shortlist: string[];
  /** Their `email_responses/`. */
  drafts: Draft[];
}

export function emptyHiring(): HiringState {
  return {
    job: null,
    candidates: [],
    scores: {},
    unscored: [],
    feedback: [],
    rounds: 0,
    shortlist: [],
    drafts: [],
  };
}

/**
 * Rounds of "score them again, with this feedback" one call may take.
 *
 * Their flow's feedback edge is UNBOUNDED: option 2 loops back into
 * `score_leads` for as long as the human keeps choosing it, and each loop is a
 * model call per candidate. `self_evaluation_loop_flow`, their other looping
 * example, bounds its retry with `if retry_count > 3` and routes to an exit —
 * that guard is borrowed here, because a caller who is never quite happy with
 * the ranking is otherwise a bill with no ceiling. Past it the desk is told to
 * proceed with what it has or stop, rather than to score once more.
 */
export const MAX_FEEDBACK_ROUNDS = 3;

/** Feedback entries the state holds. One per round, so this is the round cap
 *  restated as a growth bound on something that rides in every prompt — held
 *  by the slot's `caps`, so no writer has to remember it. */
export const MAX_FEEDBACK_ENTRIES = MAX_FEEDBACK_ROUNDS + 1;

export const hiringSlot = sessionSlot("hiring", emptyHiring, {
  caps: { feedback: MAX_FEEDBACK_ENTRIES },
});

/**
 * How many candidates the caller is read back, and how many are invited by
 * default — their `sorted_candidates[:3]`.
 */
export const SHORTLIST_SIZE = 3;

// ─── The shape of the call ───────────────────────────────────────────────────

/**
 * Their `Flow`, as the position of one conversation.
 *
 * ```text
 * @start load_leads ─→ score_leads ─→ @router human_in_the_loop
 *                          ▲               │ "2" → feedback ──┘ (loop)
 *                          │               │ "3" → generate_emails → write_and_save_emails
 *                          └───────────────┘ "1" → exit()
 * ```
 *
 * Their router is a blocking `input()` with three numbered options, and it is
 * the most voice-shaped code in the CrewAI examples: read the top three out,
 * ask which of three things to do next. Here the three options are three
 * things the caller can SAY, and the router is the dialog gating which tools
 * are legal where:
 *
 * - `idle` — nothing scored. `screen_candidates` is their `load_leads` and
 *   `score_leads` in one tool, since the second follows the first with nothing
 *   for a human to do between them.
 * - `reviewing` — their `human_in_the_loop`. Option 2 is
 *   `rescore_with_feedback` (back to `reviewing`, with a bound), option 3 is
 *   `proceed_to_emails`, and option 1 is hanging up, which needs no tool.
 * - `emailed` — their `write_and_save_emails` has run. A new screening starts
 *   the loop over, which their script cannot do and a desk plainly should.
 *
 * Their fourth arm — an invalid choice routes back to `human_in_the_loop` —
 * has no equivalent because a conversation has no invalid input: the model
 * asks again. The `instruction` on each state is what does that asking.
 */
const hiringSpec = {
  initial: "idle",
  states: {
    idle: {
      instruction:
        "Nothing has been screened yet. Confirm which role the caller is hiring for " +
        "(the default is the Junior React Developer contract), then use screen_candidates.",
      on: { SCORED: "reviewing" },
    },
    reviewing: {
      instruction:
        "The scores are in. Read the top three back, one sentence of reasoning each, then " +
        "offer the three choices: score again with their feedback (rescore_with_feedback), " +
        "proceed to emails (proceed_to_emails), or stop here.",
      on: { SCORED: "reviewing", PROCEEDED: "emailed" },
    },
    emailed: {
      instruction:
        "The emails are drafted. Offer to read one back with read_email. A new screening " +
        "(screen_candidates) starts over.",
      on: { SCORED: "reviewing" },
    },
  },
} as const satisfies DialogSpec;

/**
 * The flow. Its own slot key: a dialog stores a position and {@link hiringSlot}
 * stores the data, and one tool call moves both.
 */
export const hiringFlow = dialog("hiringFlow", hiringSpec);

/**
 * The flow's alphabet — the events its tools send, which is the whole of what
 * can move this conversation.
 *
 * Named once because the two of them are sent two different ways, and reading
 * the same event in both spellings is what makes the pair legible: a
 * `hiringFlow.tool` declares `send: SCORED` and lets the dialog move it after a
 * successful body, while `screen_candidates` — an ordinary `tool()`, because
 * `SCORED` is legal in every state — calls `hiringFlow.send(ctx, SCORED)`
 * itself.
 */
export type HiringEvent = DialogEvent<typeof hiringSpec>;

/** Their `score_leads` finished: a ranking exists to review. */
export const SCORED: HiringEvent = { type: "SCORED" };

/** Their option 3 was taken: the emails are written. */
export const PROCEEDED: HiringEvent = { type: "PROCEEDED" };

/** How the stage reads to a caller, from the flow's own position. */
export function stageLabel(at: DialogPosition): string {
  if (at.state === "idle") return "nothing screened yet";
  return at.state === "emailed" ? "emails drafted" : "shortlist under review";
}

// ─── Reads ───────────────────────────────────────────────────────────────────

/**
 * The state as a READ hands it out: deep-frozen, and typed to say so.
 *
 * Every helper below takes this rather than {@link HiringState}: a mutable
 * value still satisfies it, so an `update` draft passes unchanged, while a
 * helper that WOULD have mutated stops compiling.
 */
export type FrozenHiringState = DeepReadonly<HiringState>;

/** Their `ScoredCandidate` — the roster joined onto the score table, plus the
 *  position the join gives it, which is what a caller refers to ("the second
 *  one"). */
export interface RankedCandidate extends Candidate {
  score: number;
  reason: string;
  /** 1-based, best first. */
  rank: number;
}

/**
 * Their `combine_candidates_with_scores` and the `sorted(…, reverse=True)`
 * after it, as one function over the frozen state.
 *
 * A candidate with no score this round is NOT in the ranking — it is in
 * `unscored`, and the desk says so — because ranking someone at zero would
 * read as a verdict on them rather than on the tooling. Ties break by roster
 * order, so a ranking is stable across reads.
 */
export function ranked(state: FrozenHiringState): RankedCandidate[] {
  const scored: Omit<RankedCandidate, "rank">[] = [];
  for (const candidate of state.candidates) {
    const verdict = state.scores[candidate.id];
    if (verdict) scored.push({ ...candidate, score: verdict.score, reason: verdict.reason });
  }
  return scored
    .sort((a, b) => b.score - a.score)
    .map((candidate, index) => ({ ...candidate, rank: index + 1 }));
}

/** The top {@link SHORTLIST_SIZE}, as the desk reads them back. */
export function topCandidates(state: FrozenHiringState): RankedCandidate[] {
  return ranked(state).slice(0, SHORTLIST_SIZE);
}

/** A ranked candidate, in the words the desk would use: "2. Priya Raman (87)". */
export function describeRanked(candidate: RankedCandidate): string {
  return `${candidate.rank}. ${candidate.name} (${candidate.score})`;
}

/**
 * How a caller names one of twelve applicants — the desk's own vocabulary,
 * which is the half {@link resolveOne} does not own.
 *
 * A name matches on WHOLE parts: every part of the candidate's name the
 * utterance contains scores one, so "Priya" and "Raman" each resolve and
 * "Priya Raman" outscores both — a substring test would let "an" match Raman,
 * Tanaka and Kowalski at once. Declared as a constant rather than inline
 * because the annotation is what types `candidate` and `text` here; the three
 * tools that resolve a candidate all reach it through the one function below.
 */
const CANDIDATE_MATCH: ResolveOneOptions<RankedCandidate> = {
  label: "candidate",
  describe: describeRanked,
  score: (candidate, text) =>
    candidate.name
      .toLowerCase()
      .split(/\s+/)
      .filter((part) => part.length > 1 && text.includes(part)).length,
};

/**
 * The candidate a caller MEANT.
 *
 * Over the RANKING rather than the roster, because that is the list the caller
 * was read: "the second one" is the second-best score, not the second row of
 * the CSV. A first name, a surname, or a position all resolve; anything
 * ambiguous is a failure listing the options, never a guess — the consequence
 * of guessing here is inviting the wrong person to interview.
 */
export function resolveCandidate(
  state: FrozenHiringState,
  spoken: string,
): RankedCandidate | ToolFailure {
  return resolveOne(ranked(state), spoken, CANDIDATE_MATCH);
}

/** The draft written for one candidate, if `proceed_to_emails` has run. */
export function draftFor(
  state: FrozenHiringState,
  candidateId: string,
): DeepReadonly<Draft> | undefined {
  return state.drafts.find((draft) => draft.candidateId === candidateId);
}

// ─── The projection ──────────────────────────────────────────────────────────

/** One row of the sidebar's leaderboard. No email address: the caller is read
 *  a name and a score, and the browser needs nothing the caller was not told. */
export interface LeaderboardRow {
  id: string;
  name: string;
  score: number;
  reason: string;
  rank: number;
  shortlisted: boolean;
}

export interface DraftRow {
  candidateId: string;
  name: string;
  proceed: boolean;
  subject: string;
  accepted: boolean;
}

export interface HiringView {
  jobTitle: string | null;
  /** Best first, capped at nothing: the roster is twelve. */
  leaderboard: LeaderboardRow[];
  /** Names the evaluator could not score this round. */
  unscored: string[];
  rounds: number;
  feedback: readonly string[];
  drafts: DraftRow[];
}

/** What the browser sees: the ranking, the feedback trail, the drafts' subjects. */
export function hiringView(state: FrozenHiringState): HiringView {
  const shortlisted = new Set(state.shortlist);
  const nameOf = new Map(state.candidates.map((candidate) => [candidate.id, candidate.name]));
  return {
    jobTitle: state.job?.title ?? null,
    leaderboard: ranked(state).map((candidate) => ({
      id: candidate.id,
      name: candidate.name,
      score: candidate.score,
      reason: candidate.reason,
      rank: candidate.rank,
      shortlisted: shortlisted.has(candidate.id),
    })),
    unscored: state.unscored.map((id) => nameOf.get(id) ?? id),
    rounds: state.rounds,
    feedback: state.feedback,
    drafts: state.drafts.map((draft) => ({
      candidateId: draft.candidateId,
      name: nameOf.get(draft.candidateId) ?? draft.candidateId,
      proceed: draft.proceed,
      subject: draft.subject,
      accepted: draft.accepted,
    })),
  };
}

/**
 * The projection BOTH ends use: `syncState` on the agent, `useAgentState` in
 * the client. Annotated, because it is the contract between the two halves —
 * a `hiringView` whose return type drifted should fail here, at the export the
 * browser imports, rather than inside a component.
 */
export const hiringProjection: StateProjection<HiringView> = hiringSlot.projection(hiringView);

// ─── Progress, which is a MOMENT and not state ───────────────────────────────

/**
 * The event a fan-out ticks while the caller holds the line.
 *
 * Twelve model calls is a real wait — the desk is told to say so before it
 * calls the tool — and until now the browser had nothing to show for it: the
 * leaderboard is written once, at the end, deliberately (see
 * `tools/screen_candidates.ts`, "the await comes first, then the mutation").
 * Progress is the case for the OTHER mechanism a tool has for telling a page
 * something: re-rendering "scoring seven of twelve" after a reload would be a
 * lie, so it is a moment (`ctx.send` → `useEvent`) rather than state in the
 * slot, and putting it in the slot would also undo the one thing that write is
 * careful about — the whole table landing at once, so nothing ever reads half
 * a screening.
 */
export const SCREENING_PROGRESS = "screening-progress";

export interface ScreeningProgress {
  /** Which fan-out is running: the evaluator's, or the coordinator's. */
  phase: "scoring" | "writing";
  /** How many have settled — failures counted, since the waiting is over for
   *  those too and a ticker that stops short of `total` reads as a hang. */
  done: number;
  total: number;
}

/**
 * A tick to hand a fan-out: one {@link SCREENING_PROGRESS} event per item that
 * settles. `Pick<ToolContext, "send">` because the ticker wants the one channel
 * and nothing else the tool was handed.
 */
export function progressTicker(
  ctx: Pick<ToolContext, "send">,
  phase: ScreeningProgress["phase"],
  total: number,
): () => void {
  let done = 0;
  return () => {
    done += 1;
    ctx.send(SCREENING_PROGRESS, { phase, done, total } satisfies ScreeningProgress);
  };
}
