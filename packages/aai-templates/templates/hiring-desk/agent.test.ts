/** The def a DEPLOYED agent runs: authored, plus what `tools/` declares. */
import agentDef from "virtual:aai/agent";
import type {
  GenerateFn,
  GenerateOptions,
  GuardrailVerdict,
  SubagentAnswer,
  ToolContext,
} from "@alexkroman1/aai";
import { isToolFailure } from "@alexkroman1/aai";
import {
  createToolContext,
  expectDialogOk,
  expectDialogRefused,
  type StubDelegateCall,
  type StubGenerateCall,
  stubDelegate,
  stubGenerate,
  toolRunner,
} from "@alexkroman1/aai/testing";
import { describe, expect, test } from "vitest";
import {
  COORDINATOR_NAME,
  crewAgentPrompt,
  crewExpectedOutput,
  EMAIL_FOLLOWUP_AGENT,
  EVALUATOR_SYSTEM,
  emailGuardrail,
  emailTask,
  emailWriter,
  evaluationTask,
  HR_EVALUATION_AGENT,
  parseEmail,
  SCORING_CONCURRENCY,
} from "./crews.ts";
import {
  DEFAULT_JOB,
  emptyHiring,
  hiringFlow,
  hiringSlot,
  hiringView,
  LEADS,
  MAX_FEEDBACK_ENTRIES,
  MAX_FEEDBACK_ROUNDS,
  noteFeedback,
  ranked,
  resolveCandidate,
  SHORTLIST_SIZE,
  stageLabel,
} from "./shared.ts";

// ─── A scripted desk ─────────────────────────────────────────────────────────
//
// TWO fakes, because the desk reaches a model two ways — and that split is the
// port showing through in the spec. The evaluator is a `ctx.generate` with a
// schema, so `stubGenerate` drives it, routed by its system prompt; the
// coordinator is a subagent, so `stubDelegate` drives it, routed by name.
// Nothing here runs a model: what is worth asserting is what the desk ASKS for
// and what it does with what comes back.

const run = toolRunner(agentDef);

/** What the evaluator says about each applicant, keyed by id — so the stub
 *  really "reads" the brief it was handed rather than answering by position. */
const SCORES: Readonly<Record<string, number>> = {
  c01: 87,
  c07: 84,
  c04: 71,
  c11: 69,
  c05: 66,
  c09: 63,
  c02: 52,
  c08: 47,
  c12: 41,
  c10: 38,
  c03: 34,
  c06: 22,
};

/** The same table after "weight TypeScript more": Aisha and Mei climb into the
 *  top three, Tom drops out, Priya stays. */
const TYPESCRIPT_SCORES: Readonly<Record<string, number>> = {
  ...SCORES,
  c05: 86,
  c11: 85,
  c04: 60,
};

/** The candidate a brief is about, read back out of the prompt. */
function candidateIdIn(prompt: string): string {
  const id = prompt.match(/Candidate ID: (c\d\d)/)?.[1];
  if (!id) throw new Error("the evaluator's brief names no candidate");
  return id;
}

/** A coordinator's email, as the guardrail requires it. */
function emailFor(call: StubDelegateCall): string {
  const name = call.task.match(/^Name: (.+)$/m)?.[1] ?? "there";
  const proceed = call.task.includes("PROCEEDING WITH CANDIDATE: True");
  const subject = proceed ? "Next steps on your application" : "Your application";
  const body = proceed
    ? `Hi ${name},\n\nWe'd like to talk. Could you share your availability for a Zoom call this week?`
    : `Hi ${name},\n\nThank you for applying. We've decided to move forward with other candidates.`;
  return `Subject: ${subject}\n\n${body}\n\nBest,\n${COORDINATOR_NAME}`;
}

interface Script {
  /** The score table the evaluator answers from. */
  scores?: Readonly<Record<string, number>>;
  /** Candidate ids whose evaluation FAILS. */
  failScoring?: readonly string[];
  /** Candidate names whose email FAILS. */
  failEmail?: readonly string[];
  /** The coordinator's reply, when the default is not the case at hand. */
  email?: (call: StubDelegateCall) => string | { text: string; complaint?: string };
}

/**
 * The two fakes over one MUTABLE script: a test that screens and then re-scores
 * changes `script.scores` between the two calls, and the routes read the script
 * at call time — the slot is keyed by the context, so swapping the context to
 * swap the model would also swap the state.
 */
function scriptedDesk(script: Script = {}) {
  const model = stubGenerate({
    [EVALUATOR_SYSTEM]: (call: StubGenerateCall) => {
      const id = candidateIdIn(call.prompt);
      if (script.failScoring?.includes(id)) throw new Error(`gateway said no for ${id}`);
      const table = script.scores ?? SCORES;
      return { object: { score: table[id] ?? 50, reason: `Scripted reasoning for ${id}.` } };
    },
  });
  const desk = stubDelegate({
    "hr-coordinator": (call) => {
      const name = call.task.match(/^Name: (.+)$/m)?.[1] ?? "";
      if (script.failEmail?.includes(name)) throw new Error(`coordinator timed out on ${name}`);
      const reply = script.email ? script.email(call) : emailFor(call);
      return typeof reply === "string" ? { text: reply } : reply;
    },
  });
  const ctx = createToolContext({ generate: model.generate, delegate: desk.delegate });
  return { ctx, model, desk, script };
}

const at = (ctx: ToolContext) => hiringFlow.position(ctx).state;
const stateOf = (ctx: ToolContext) => hiringSlot.get(ctx);
const nameAt = (ctx: ToolContext, rank: number) =>
  ranked(stateOf(ctx)).find((one) => one.rank === rank)?.name;

/** A screening that has run, so a test about the review stage starts there. */
async function screened(script: Script = {}) {
  const desk = scriptedDesk(script);
  await run("screen_candidates", {}, desk.ctx);
  desk.model.calls.length = 0;
  return desk;
}

interface ScreenResult {
  job: string;
  screened: number;
  top: { rank: number; name: string; score: number; reason: string }[];
  unscored?: string;
  message: string;
  state: string;
}

// ─── The flow ────────────────────────────────────────────────────────────────

describe("the flow", () => {
  test("starts with nothing screened", () => {
    const { ctx } = scriptedDesk();
    expect(at(ctx)).toBe("idle");
    expect(stageLabel(hiringFlow.position(ctx))).toBe("nothing screened yet");
  });

  test("refuses feedback and emails before anything is scored, spending no model", async () => {
    const { ctx, model, desk } = scriptedDesk();
    for (const [name, args] of [
      ["rescore_with_feedback", { feedback: "more TypeScript" }],
      ["proceed_to_emails", {}],
    ] as const) {
      // Their router is only reachable after `score_leads`; here that is the
      // gate, and its refusal names the position and quotes the state's own
      // instruction so the model can recover on its turn.
      const refused = expectDialogRefused(await run(name, args, ctx), "idle");
      expect(refused.error).toMatch(/screen_candidates/);
    }
    expect(model.calls).toEqual([]);
    expect(desk.calls).toEqual([]);
    expect(at(ctx)).toBe("idle");
  });
});

// ─── Crew A: screen_candidates ───────────────────────────────────────────────

describe("screen_candidates (their load_leads + score_leads)", () => {
  test("scores every applicant once, through the evaluator, and lands in reviewing", async () => {
    const { ctx, model } = scriptedDesk();

    const result = (await run("screen_candidates", {}, ctx)) as ScreenResult;

    expect(model.calls).toHaveLength(LEADS.length);
    expect(new Set(model.calls.map((call) => call.system))).toEqual(new Set([EVALUATOR_SYSTEM]));
    // Every brief names a different applicant — one evaluation each, none twice.
    expect(new Set(model.calls.map((call) => candidateIdIn(call.prompt))).size).toBe(LEADS.length);
    expect(result.screened).toBe(LEADS.length);
    expect(result.state).toBe("reviewing");
    expect(at(ctx)).toBe("reviewing");
  });

  test("reads back the top three, best first, with the evaluator's reasoning", async () => {
    const { ctx } = scriptedDesk();
    const result = (await run("screen_candidates", {}, ctx)) as ScreenResult;

    expect(result.top.map((one) => one.name)).toEqual([
      "Priya Raman",
      "Sofia Lindqvist",
      "Tom Whitfield",
    ]);
    expect(result.top.map((one) => one.rank)).toEqual([1, 2, 3]);
    expect(result.top.map((one) => one.score)).toEqual([87, 84, 71]);
    for (const one of result.top) expect(one.reason).toMatch(/Scripted reasoning/);
    expect(result.message).toContain("1. Priya Raman (87)");
    expect(result.unscored).toBeUndefined();
  });

  test("screens against the shipped role unless the caller named another", async () => {
    const { ctx, model } = scriptedDesk();
    const result = (await run("screen_candidates", {}, ctx)) as ScreenResult;
    expect(result.job).toBe(DEFAULT_JOB.title);
    expect(stateOf(ctx).job).toEqual(DEFAULT_JOB);
    for (const call of model.calls) {
      expect(call.prompt).toContain(`Title: ${DEFAULT_JOB.title}`);
      // The first round carries no feedback section: there is nothing yet.
      expect(call.prompt).not.toContain("hiring manager has reviewed");
    }
  });

  test("carries a role the caller described into every brief", async () => {
    const { ctx, model } = scriptedDesk();
    await run(
      "screen_candidates",
      { jobTitle: "Design Systems Engineer", jobDescription: "Storybook, tokens, accessibility." },
      ctx,
    );
    for (const call of model.calls) {
      expect(call.prompt).toContain("Title: Design Systems Engineer");
      expect(call.prompt).toContain("Storybook, tokens, accessibility.");
    }
    // A title alone keeps the default's description under the caller's title.
    const { ctx: ctx2, model: model2 } = scriptedDesk();
    await run("screen_candidates", { jobTitle: "Frontend Engineer" }, ctx2);
    expect(model2.calls[0]?.prompt).toContain("Title: Frontend Engineer");
    expect(model2.calls[0]?.prompt).toContain("twelve-month contract");
  });

  test("runs the evaluations through a window, not all at once and not one by one", async () => {
    const { model } = scriptedDesk();
    let inFlight = 0;
    let peak = 0;
    // The fake answers on a microtask, so `inFlight` only ever exceeds 1 if the
    // fan-out really issued several briefs before awaiting any — and it never
    // exceeds the window if the window is real.
    const generate = ((options: GenerateOptions) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      return model.generate(options).finally(() => {
        inFlight -= 1;
      });
    }) as GenerateFn;
    const ctx = createToolContext({ generate });

    await run("screen_candidates", {}, ctx);

    expect(LEADS.length).toBeGreaterThan(SCORING_CONCURRENCY);
    expect(peak).toBe(SCORING_CONCURRENCY);
  });

  test("one applicant the evaluator could not score does not sink the screening", async () => {
    const { ctx } = scriptedDesk({ failScoring: ["c07"] });

    const result = (await run("screen_candidates", {}, ctx)) as ScreenResult;

    expect(result.screened).toBe(LEADS.length - 1);
    expect(result.unscored).toBe("Sofia Lindqvist");
    expect(result.message).toMatch(/could not be scored/);
    // Not ranked at zero — absent, and named. A zero would read as a verdict.
    expect(result.top.map((one) => one.name)).toEqual([
      "Priya Raman",
      "Tom Whitfield",
      "Mei Tanaka",
    ]);
    expect(stateOf(ctx).unscored).toEqual(["c07"]);
    expect(hiringView(stateOf(ctx)).unscored).toEqual(["Sofia Lindqvist"]);
  });

  test("fails as a tool when nobody could be scored, and the flow does not move", async () => {
    const { ctx } = scriptedDesk({ failScoring: LEADS.map((one) => one.id) });

    const result = await run("screen_candidates", {}, ctx);

    expect(result).toEqual({ error: expect.stringContaining("gateway said no") });
    expect(at(ctx)).toBe("idle");
    expect(stateOf(ctx)).toEqual(emptyHiring());
  });

  test("a second screening starts over: feedback, rounds, shortlist and drafts are cleared", async () => {
    const { ctx } = await screened();
    await run("rescore_with_feedback", { feedback: "more TypeScript" }, ctx);
    await run("proceed_to_emails", {}, ctx);
    expect(at(ctx)).toBe("emailed");
    expect(stateOf(ctx).drafts).not.toEqual([]);

    await run("screen_candidates", { jobTitle: "Another role" }, ctx);

    const state = stateOf(ctx);
    expect(state.feedback).toEqual([]);
    expect(state.rounds).toBe(0);
    expect(state.shortlist).toEqual([]);
    expect(state.drafts).toEqual([]);
    expect(state.job?.title).toBe("Another role");
    expect(at(ctx)).toBe("reviewing");
  });
});

// ─── The router's option 2: rescore_with_feedback ────────────────────────────

interface RescoreResult {
  round: number;
  roundsLeft: number;
  feedbackApplied: string[];
  top: { name: string; score: number }[];
  promoted: string[];
  dropped: string[];
  message: string;
}

describe("rescore_with_feedback (their option 2)", () => {
  test("re-scores everyone with the feedback in every brief, and reports who moved", async () => {
    const { ctx, model, script } = await screened();
    // The evaluator reads the feedback, so the table changes with it.
    script.scores = TYPESCRIPT_SCORES;

    const moved = expectDialogOk<RescoreResult>(
      await run("rescore_with_feedback", { feedback: "Weight TypeScript much more heavily" }, ctx),
    );

    expect(model.calls).toHaveLength(LEADS.length);
    for (const call of model.calls) {
      expect(call.prompt).toContain("hiring manager has reviewed");
      expect(call.prompt).toContain("- Weight TypeScript much more heavily");
    }
    expect(moved.state).toBe("reviewing");
    expect(moved.result.round).toBe(1);
    expect(moved.result.roundsLeft).toBe(MAX_FEEDBACK_ROUNDS - 1);
    expect(moved.result.top.map((one) => one.name)).toEqual([
      "Priya Raman",
      "Aisha Bello",
      "Mei Tanaka",
    ]);
    expect(moved.result.promoted).toEqual(["Aisha Bello", "Mei Tanaka"]);
    expect(moved.result.dropped).toEqual(["Sofia Lindqvist", "Tom Whitfield"]);
    expect(moved.result.message).toMatch(/moved in \(Aisha Bello, Mei Tanaka\)/);
    expect(stateOf(ctx).rounds).toBe(1);
  });

  test("feedback ACCUMULATES across rounds, in order", async () => {
    const { ctx, model } = await screened();

    await run("rescore_with_feedback", { feedback: "more TypeScript" }, ctx);
    await run("rescore_with_feedback", { feedback: "less weight on years of experience" }, ctx);

    expect(stateOf(ctx).feedback).toEqual([
      "more TypeScript",
      "less weight on years of experience",
    ]);
    const last = model.calls.at(-1)?.prompt ?? "";
    // Theirs overwrote; a caller who said both meant both, and in that order.
    expect(last.indexOf("- more TypeScript")).toBeGreaterThan(-1);
    expect(last.indexOf("- more TypeScript")).toBeLessThan(
      last.indexOf("- less weight on years of experience"),
    );
    expect(stateOf(ctx).rounds).toBe(2);
  });

  test("says so when the same three people are still on top", async () => {
    const { ctx } = await screened();
    const same = expectDialogOk<RescoreResult>(
      await run("rescore_with_feedback", { feedback: "nothing really" }, ctx),
    );
    expect(same.result.promoted).toEqual([]);
    expect(same.result.message).toMatch(/same people/);
  });

  test("refuses blank feedback without spending the evaluator", async () => {
    const { ctx, model } = await screened();
    const refused = await run("rescore_with_feedback", { feedback: "   " }, ctx);
    expect(refused).toEqual({ error: expect.stringContaining("what the caller wants changed") });
    expect(model.calls).toEqual([]);
    expect(stateOf(ctx).rounds).toBe(0);
  });

  test("is BOUNDED: past MAX_FEEDBACK_ROUNDS it refuses, naming the two ways out", async () => {
    const { ctx, model } = await screened();
    for (let round = 1; round <= MAX_FEEDBACK_ROUNDS; round++) {
      const again = expectDialogOk<RescoreResult>(
        await run("rescore_with_feedback", { feedback: `round ${round}` }, ctx),
      );
      expect(again.result.roundsLeft).toBe(MAX_FEEDBACK_ROUNDS - round);
    }
    // The last accepted round says it was the last.
    model.calls.length = 0;

    const refused = await run("rescore_with_feedback", { feedback: "one more" }, ctx);

    expect(isToolFailure(refused)).toBe(true);
    if (isToolFailure(refused)) {
      expect(refused.error).toMatch(/limit is 3/);
      expect(refused.error).toMatch(/proceed to emails/);
      expect(refused.error).toMatch(/stop/);
    }
    // No model spent, no round counted, and the position did not move on a failure.
    expect(model.calls).toEqual([]);
    expect(stateOf(ctx).rounds).toBe(MAX_FEEDBACK_ROUNDS);
    expect(stateOf(ctx).feedback).toHaveLength(MAX_FEEDBACK_ROUNDS);
    expect(at(ctx)).toBe("reviewing");
  });

  test("tells the desk the last round was the last", async () => {
    const { ctx } = await screened();
    let last: RescoreResult | undefined;
    for (let round = 1; round <= MAX_FEEDBACK_ROUNDS; round++) {
      last = expectDialogOk<RescoreResult>(
        await run("rescore_with_feedback", { feedback: `round ${round}` }, ctx),
      ).result;
    }
    expect(last?.message).toMatch(/last round of feedback/);
  });

  test("keeps the previous ranking when nobody could be re-scored", async () => {
    const { ctx, script } = await screened();
    const before = stateOf(ctx);
    script.failScoring = LEADS.map((one) => one.id);

    const result = await run("rescore_with_feedback", { feedback: "more TypeScript" }, ctx);

    expect(result).toEqual({ error: expect.stringContaining("ranking is unchanged") });
    expect(stateOf(ctx).scores).toEqual(before.scores);
    expect(stateOf(ctx).rounds).toBe(0);
    expect(stateOf(ctx).feedback).toEqual([]);
    expect(at(ctx)).toBe("reviewing");
  });
});

// ─── The router's option 3: proceed_to_emails ────────────────────────────────

interface ProceedResult {
  invited: string[];
  declined: number;
  drafted: number;
  failed: string[];
  needsLook: string[];
  message: string;
}

describe("proceed_to_emails (their option 3 → write_and_save_emails)", () => {
  test("writes EVERY applicant an email through the coordinator, inviting the top three", async () => {
    const { ctx, desk } = await screened();

    const done = expectDialogOk<ProceedResult>(await run("proceed_to_emails", {}, ctx));

    expect(desk.calls).toHaveLength(LEADS.length);
    expect(new Set(desk.calls.map((call) => call.subagent.name))).toEqual(
      new Set(["hr-coordinator"]),
    );
    // Their `proceed_with_candidate`: True for the shortlist, False for everyone else.
    const proceeding = desk.calls
      .filter((call) => call.task.includes("PROCEEDING WITH CANDIDATE: True"))
      .map((call) => call.task.match(/^Name: (.+)$/m)?.[1]);
    // In ROSTER order — the fan-out walks the roster, not the ranking.
    expect(proceeding).toEqual(["Priya Raman", "Tom Whitfield", "Sofia Lindqvist"]);
    expect(done.state).toBe("emailed");
    expect(done.done).toBe(false);
    expect(done.result.invited).toEqual([
      "1. Priya Raman (87)",
      "2. Sofia Lindqvist (84)",
      "3. Tom Whitfield (71)",
    ]);
    expect(done.result.declined).toBe(LEADS.length - SHORTLIST_SIZE);
    expect(done.result.drafted).toBe(LEADS.length);
    expect(done.result.needsLook).toEqual([]);
    expect(stateOf(ctx).shortlist).toEqual(["c01", "c07", "c04"]);
  });

  test("keeps each draft's subject apart from its body, and the role in the brief", async () => {
    const { ctx, desk } = await screened();
    await run("proceed_to_emails", {}, ctx);
    const priya = stateOf(ctx).drafts.find((draft) => draft.candidateId === "c01");
    expect(priya).toMatchObject({
      proceed: true,
      subject: "Next steps on your application",
      accepted: true,
    });
    expect(priya?.body).toMatch(/^Hi Priya Raman,/);
    expect(priya?.body).not.toMatch(/Subject:/);
    // Theirs never told the coordinator which job; every brief here names it.
    for (const call of desk.calls)
      expect(call.task).toContain(`ROLE APPLIED FOR: ${DEFAULT_JOB.title}`);
  });

  test("a spoken shortlist replaces the top three, by name or by position", async () => {
    const { ctx, desk } = await screened();

    const done = expectDialogOk<ProceedResult>(
      await run("proceed_to_emails", { shortlist: ["Priya", "the fifth one", "Mehta"] }, ctx),
    );

    expect(done.result.invited).toEqual([
      "1. Priya Raman (87)",
      "5. Aisha Bello (66)",
      "8. Rahul Mehta (47)",
    ]);
    const proceeding = desk.calls.filter((call) =>
      call.task.includes("PROCEEDING WITH CANDIDATE: True"),
    );
    expect(proceeding).toHaveLength(3);
    expect(stateOf(ctx).shortlist).toEqual(["c01", "c05", "c08"]);
  });

  test("names the same person twice as one invitation", async () => {
    const { ctx } = await screened();
    const done = expectDialogOk<ProceedResult>(
      await run("proceed_to_emails", { shortlist: ["Priya", "Raman"] }, ctx),
    );
    expect(done.result.invited).toEqual(["1. Priya Raman (87)"]);
  });

  test("never guesses: a name that matches nobody is refused, listing the ranking, before any email", async () => {
    const { ctx, desk } = await screened();

    const refused = await run("proceed_to_emails", { shortlist: ["Priya", "Zelda"] }, ctx);

    expect(isToolFailure(refused)).toBe(true);
    if (isToolFailure(refused)) expect(refused.error).toContain("Priya Raman (87)");
    expect(desk.calls).toEqual([]);
    expect(at(ctx)).toBe("reviewing");
    expect(stateOf(ctx).drafts).toEqual([]);
  });

  test("a draft the guardrail never accepted comes back flagged, not hidden", async () => {
    const { ctx } = await screened({
      email: (call) =>
        call.task.includes("Name: Tom Whitfield")
          ? { text: "Hi Tom, let's talk soon.", complaint: "no subject line" }
          : emailFor(call),
    });

    const done = expectDialogOk<ProceedResult>(await run("proceed_to_emails", {}, ctx));

    expect(done.result.needsLook).toEqual(["Tom Whitfield"]);
    expect(done.result.message).toMatch(/need a look/);
    const tom = stateOf(ctx).drafts.find((draft) => draft.candidateId === "c04");
    expect(tom).toMatchObject({ accepted: false, subject: "(no subject)" });
    expect(hiringView(stateOf(ctx)).drafts.find((d) => d.name === "Tom Whitfield")?.accepted).toBe(
      false,
    );
  });

  test("one email the coordinator could not write does not sink the rest", async () => {
    const { ctx } = await screened({ failEmail: ["Elena Vasquez"] });

    const done = expectDialogOk<ProceedResult>(await run("proceed_to_emails", {}, ctx));

    expect(done.result.drafted).toBe(LEADS.length - 1);
    expect(done.result.failed).toEqual(["Elena Vasquez"]);
    expect(done.result.message).toMatch(/No email could be written for Elena Vasquez/);
    expect(done.state).toBe("emailed");
  });

  test("fails as a tool when no email could be written, and the flow does not move", async () => {
    const { ctx } = await screened({ failEmail: LEADS.map((one) => one.name) });

    const result = await run("proceed_to_emails", {}, ctx);

    expect(result).toEqual({ error: expect.stringContaining("coordinator timed out") });
    expect(at(ctx)).toBe("reviewing");
    expect(stateOf(ctx).drafts).toEqual([]);
  });

  test("refuses a second round of emails for one ranking", async () => {
    const { ctx, desk } = await screened();
    await run("proceed_to_emails", {}, ctx);
    desk.calls.length = 0;

    const again = await run("proceed_to_emails", {}, ctx);

    expect(isToolFailure(again)).toBe(true);
    if (isToolFailure(again)) expect(again.error).toMatch(/emailed/);
    expect(desk.calls).toEqual([]);
  });
});

// ─── The reads ───────────────────────────────────────────────────────────────

describe("candidate_details", () => {
  test("has nothing to say before a screening", async () => {
    const { ctx } = scriptedDesk();
    expect(await run("candidate_details", { candidate: "Priya" }, ctx)).toEqual({
      error: expect.stringContaining("screen_candidates"),
    });
  });

  test("resolves 'the second one' against the RANKING the caller was read", async () => {
    const { ctx } = await screened();
    const second = (await run("candidate_details", { candidate: "the second one" }, ctx)) as {
      rank: number;
      name: string;
      score: number;
      bio: string;
      emailDrafted: string | null;
    };
    expect(second.rank).toBe(2);
    expect(second.name).toBe(nameAt(ctx, 2));
    expect(second.score).toBe(84);
    expect(second.bio).toMatch(/Stockholm/);
    expect(second.emailDrafted).toBeNull();
  });

  test("resolves a surname, and reports the draft once one exists", async () => {
    const { ctx } = await screened();
    await run("proceed_to_emails", {}, ctx);
    const rahul = (await run("candidate_details", { candidate: "Mehta" }, ctx)) as {
      name: string;
      shortlisted: boolean;
      emailDrafted: string | null;
    };
    expect(rahul).toMatchObject({
      name: "Rahul Mehta",
      shortlisted: false,
      emailDrafted: "decline",
    });
    const priya = (await run("candidate_details", { candidate: "Priya" }, ctx)) as {
      shortlisted: boolean;
      emailDrafted: string | null;
    };
    expect(priya).toMatchObject({ shortlisted: true, emailDrafted: "invitation" });
  });

  test("lists the ranking rather than guessing at a name nobody has", async () => {
    const { ctx } = await screened();
    const refused = await run("candidate_details", { candidate: "Zelda" }, ctx);
    expect(isToolFailure(refused)).toBe(true);
    if (isToolFailure(refused)) expect(refused.error).toContain("12. Daniel Kowalski (22)");
  });
});

describe("read_email", () => {
  test("says the emails are not written yet, naming the tool that writes them", async () => {
    const { ctx } = await screened();
    expect(await run("read_email", { candidate: "Priya" }, ctx)).toEqual({
      error: expect.stringContaining("proceed_to_emails"),
    });
  });

  test("reads back a draft's subject and body, saying which kind it is", async () => {
    const { ctx } = await screened();
    await run("proceed_to_emails", {}, ctx);
    const invite = (await run("read_email", { candidate: "the first one" }, ctx)) as {
      to: string;
      kind: string;
      subject: string;
      body: string;
      message: string;
    };
    expect(invite).toMatchObject({
      to: "Priya Raman",
      kind: "invitation",
      subject: "Next steps on your application",
    });
    expect(invite.body).toMatch(/availability/);
    expect(invite.message).toMatch(/subject line/);
    const decline = (await run("read_email", { candidate: "Kowalski" }, ctx)) as { kind: string };
    expect(decline.kind).toBe("decline");
  });

  test("warns before reading a draft the guardrail never accepted", async () => {
    const { ctx } = await screened({
      email: (call) =>
        call.task.includes("Name: Priya Raman")
          ? { text: "Priya — let's talk.", complaint: "unsigned" }
          : emailFor(call),
    });
    await run("proceed_to_emails", {}, ctx);
    const flagged = (await run("read_email", { candidate: "Priya" }, ctx)) as {
      accepted: boolean;
      message: string;
    };
    expect(flagged.accepted).toBe(false);
    expect(flagged.message).toMatch(/did not pass/);
  });

  test("says so when the coordinator's run for that person failed", async () => {
    const { ctx } = await screened({ failEmail: ["Rahul Mehta"] });
    await run("proceed_to_emails", {}, ctx);
    expect(await run("read_email", { candidate: "Mehta" }, ctx)).toEqual({
      error: expect.stringContaining("No email was written for Rahul Mehta"),
    });
  });
});

describe("screening_status", () => {
  test("reads the stage off the flow, not off the data", async () => {
    const { ctx, model } = scriptedDesk();
    const idle = (await run("screening_status", ctx)) as {
      stage: string;
      state: string;
      screened: number;
      top: string[];
      message: string;
    };
    expect(idle).toMatchObject({
      stage: "nothing screened yet",
      state: "idle",
      screened: 0,
      top: [],
    });
    expect(idle.message).toMatch(/offer to screen/);
    expect(model.calls).toEqual([]);
  });

  test("sums the screening up once it has run", async () => {
    const { ctx } = await screened({ failScoring: ["c06"] });
    await run("rescore_with_feedback", { feedback: "more TypeScript" }, ctx);
    await run("proceed_to_emails", {}, ctx);
    const status = (await run("screening_status", ctx)) as {
      stage: string;
      job: string;
      screened: number;
      unscored: number;
      feedbackRounds: string;
      feedback: string[];
      drafts: number;
    };
    expect(status).toMatchObject({
      stage: "emails drafted",
      job: DEFAULT_JOB.title,
      screened: LEADS.length - 1,
      unscored: 1,
      feedbackRounds: `1 of ${MAX_FEEDBACK_ROUNDS}`,
      feedback: ["more TypeScript"],
      drafts: LEADS.length,
    });
  });
});

// ─── The crews ───────────────────────────────────────────────────────────────

/** The coordinator's guardrail, called the way the runtime calls it. */
function check(text: string): GuardrailVerdict {
  const answer: SubagentAnswer = { text, steps: 1, toolCalls: [] };
  const verdict = emailGuardrail(answer);
  if (typeof verdict === "object") throw new Error("this guardrail is synchronous by design");
  return verdict;
}

describe("the crews", () => {
  test("render a CrewAI agent through CrewAI's own role_playing template", () => {
    expect(crewAgentPrompt(HR_EVALUATION_AGENT)).toBe(
      `You are ${HR_EVALUATION_AGENT.role}. ${HR_EVALUATION_AGENT.backstory}\n` +
        `Your personal goal is: ${HR_EVALUATION_AGENT.goal}`,
    );
    expect(EVALUATOR_SYSTEM).toMatch(/^You are Senior HR Evaluation Expert\./);
    expect(emailWriter.systemPrompt).toBe(crewAgentPrompt(EMAIL_FOLLOWUP_AGENT));
    expect(crewExpectedOutput("X")).toMatch(/expected criteria for your final answer: X/);
  });

  test("the evaluator's brief keeps their anti-round-number rule and asks for two sentences", () => {
    const brief = evaluationTask(LEADS[0] as (typeof LEADS)[number], DEFAULT_JOB, []);
    expect(brief).toContain("Don't use numbers like 100, 75, or 50");
    expect(brief).toContain("two sentences");
    expect(brief).toContain("Candidate ID: c01");
    expect(brief).toContain("expected criteria for your final answer");
  });

  test("the coordinator's brief carries their proceed flag as they spelled it", () => {
    const candidate = LEADS[0] as (typeof LEADS)[number];
    expect(emailTask(candidate, DEFAULT_JOB, true)).toContain("PROCEEDING WITH CANDIDATE: True");
    expect(emailTask(candidate, DEFAULT_JOB, false)).toContain("PROCEEDING WITH CANDIDATE: False");
  });

  test("the coordinator declares what a good email is, and a guardrail that holds it", () => {
    expect(emailWriter.expectedOutput).toMatch(/Subject:/);
    expect(emailWriter.expectedOutput).toContain(COORDINATOR_NAME);
    expect(emailWriter.guardrail).toBe(emailGuardrail);
    // No tools, one step: a writing pass, which is exactly what their agent is.
    expect(emailWriter.tools).toBeUndefined();
    expect(emailWriter.maxSteps).toBe(1);
  });

  test("the guardrail accepts a subject line and a signature, and names what is missing", () => {
    expect(check("Subject: Hello\n\nHi,\n\nBest,\nSarah")).toBe(true);
    expect(check("  Subject: Hello\nHi — Sarah")).toBe(true);
    expect(String(check("Hi,\n\nBest,\nSarah"))).toMatch(/Subject:/);
    expect(String(check("Subject: Hello\n\nHi,\n\nBest,\nThe team"))).toMatch(
      /Sign the email as Sarah/,
    );
  });

  test("parseEmail splits the subject from the body, and copes with a draft that has none", () => {
    expect(parseEmail("Subject: Next steps\n\nHi Priya,\n\nSarah")).toEqual({
      subject: "Next steps",
      body: "Hi Priya,\n\nSarah",
    });
    expect(parseEmail("Hi Priya — talk soon.")).toEqual({
      subject: "(no subject)",
      body: "Hi Priya — talk soon.",
    });
  });
});

// ─── The state ───────────────────────────────────────────────────────────────

describe("the ranking", () => {
  test("joins scores onto the roster, best first, and leaves the unscored out", () => {
    const state = emptyHiring();
    state.candidates = [...LEADS];
    state.scores = { c03: { score: 40, reason: "r" }, c01: { score: 90, reason: "r" } };
    const rows = ranked(state);
    expect(rows.map((row) => [row.rank, row.id, row.score])).toEqual([
      [1, "c01", 90],
      [2, "c03", 40],
    ]);
  });

  test("breaks a tie by roster order, so a ranking is stable across reads", () => {
    const state = emptyHiring();
    state.candidates = [...LEADS];
    state.scores = { c05: { score: 70, reason: "r" }, c02: { score: 70, reason: "r" } };
    expect(ranked(state).map((row) => row.id)).toEqual(["c02", "c05"]);
    expect(ranked(state).map((row) => row.id)).toEqual(["c02", "c05"]);
  });

  test("resolves a first name, a surname or a position, and lists the options otherwise", () => {
    const state = emptyHiring();
    state.candidates = [...LEADS];
    state.scores = Object.fromEntries(
      Object.entries(SCORES).map(([id, score]) => [id, { score, reason: "r" }]),
    );
    expect(resolveCandidate(state, "priya")).toMatchObject({ id: "c01" });
    expect(resolveCandidate(state, "O'Connor")).toMatchObject({ id: "c10" });
    expect(resolveCandidate(state, "the third one")).toMatchObject({ id: "c04" });
    const nobody = resolveCandidate(state, "Zelda");
    expect(isToolFailure(nobody)).toBe(true);
    if (isToolFailure(nobody)) expect(nobody.error).toContain("1. Priya Raman (87)");
    // An empty ranking is answered, not thrown at.
    expect(isToolFailure(resolveCandidate(emptyHiring(), "Priya"))).toBe(true);
  });

  test("holds MAX_FEEDBACK_ENTRIES entries of feedback, dropping the oldest", () => {
    const state = emptyHiring();
    for (let index = 0; index < MAX_FEEDBACK_ENTRIES + 2; index++) noteFeedback(state, `f${index}`);
    expect(state.feedback).toHaveLength(MAX_FEEDBACK_ENTRIES);
    expect(state.feedback[0]).toBe("f2");
    // The cap is the round cap restated: no round can be dropped while it counts.
    expect(MAX_FEEDBACK_ENTRIES).toBeGreaterThan(MAX_FEEDBACK_ROUNDS);
  });

  test("the projection carries names and scores, never an email address", async () => {
    const { ctx } = await screened();
    await run("proceed_to_emails", {}, ctx);
    const view = hiringView(stateOf(ctx));
    expect(view.jobTitle).toBe(DEFAULT_JOB.title);
    expect(view.leaderboard).toHaveLength(LEADS.length);
    expect(view.leaderboard[0]).toMatchObject({ rank: 1, name: "Priya Raman", shortlisted: true });
    expect(view.leaderboard.filter((row) => row.shortlisted)).toHaveLength(SHORTLIST_SIZE);
    expect(view.drafts).toHaveLength(LEADS.length);
    expect(view.drafts[0]).toMatchObject({ name: "Priya Raman", proceed: true, accepted: true });
    expect(JSON.stringify(view)).not.toContain("@example.com");
  });

  test("stageLabel reads every state", () => {
    expect(stageLabel({ state: "idle", done: false })).toBe("nothing screened yet");
    expect(stageLabel({ state: "reviewing", done: false })).toBe("shortlist under review");
    expect(stageLabel({ state: "emailed", done: false })).toBe("emails drafted");
  });
});
