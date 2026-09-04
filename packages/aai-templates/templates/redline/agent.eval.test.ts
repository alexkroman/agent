// Copyright 2026 the AAI authors. MIT license.
// An EVAL for a WORKFLOW APP: does the run actually do the work? Run it with
// `aai eval`.
//
// `agent.test.ts` asserts about the declaration and drives the three steps one
// at a time. This drives the WHOLE BODY — `redlineFlow` from the top — and the
// thing it is here to check is the LOOP: the critic returns a verdict, the body
// breaks on it, and `shipped` says which of the two stopped it. That decision is
// the whole point of this template, and it is the one thing a per-step spec
// structurally cannot see.
//
// `describeWorkflowEval` picks the providers for you and says which it picked:
//
//   * with `ASSEMBLYAI_API_KEY` — a LIVE run: a real model writes, a real model
//     critiques, and a real model revises if it is asked to. That spends tokens,
//     and a model is a NOISY instrument — one failure is a question, not a
//     verdict. Re-run before believing either answer.
//   * without one — a SCRIPTED run. The body, the loop and the three steps all
//     really execute; only the gateway is answered in memory.
//
// Two of the three cases below are SCRIPTED IN BOTH MODES on purpose, and say so
// where they are: their claims are about the loop's arithmetic and about what a
// stage was SHOWN, and a live model cannot be asked to make either of those
// true — it can only be asked and then have its answer accepted, which is not
// evidence.
//
// WHAT NO EVAL HERE COVERS: durability. Imported through vitest with no bundler
// in the path, a workflow body is an ordinary async function — no
// journal, no replay, and no per-step retry, so a rate-limited live run FAILS
// where a deployed one would have ridden it out. The tier that really resumes a
// run is `aai-cli`'s `dev-workflow.scenario.test.ts`.
import { routeStepFetch, stubGatewayRoute } from "@alexkroman1/aai/testing";
import { installStubStepFetch } from "@alexkroman1/aai/testing/vitest";
import { describeWorkflowEval } from "@alexkroman1/aai-runtime/eval/vitest";
import { expect } from "vitest";
import agentDef, { MAX_ROUNDS, redline } from "./agent.ts";

/** A brief with a word in it nothing else would produce, so the draft is checkable. */
const BRIEF = "Explain why our on-call rotation is moving to a two-week quokka cycle";
/** The one point every stage must be shown — `briefBlock` is what carries it. */
const MUST_COVER = ["Nobody carries the pager two weeks running"];

/** What the writer and the reviser are scripted to hand back. */
const DRAFT = [
  "The on-call rotation is moving to a two-week quokka cycle.",
  "Nobody carries the pager two weeks running: the second week is review and follow-up.",
].join(" ");

const critique = (verdict: "ship" | "revise", score = 8): string =>
  JSON.stringify({
    verdict,
    score,
    notes: verdict === "ship" ? [] : ["Say what happens to the handover", "Name the start date"],
  });

/**
 * Answer the gateway with `contents`, in order, and record what each stage asked.
 *
 * `stubGatewayRoute` owns both halves this file used to hand-write. The
 * ENVELOPE, because it is a WIRE shape and a field typed one off does not fail —
 * `stepGenerate` reads no content, reports an empty completion, and the case
 * blames the loop. And the CURSOR: the last reply repeats, because a loop cannot
 * know how many calls it will make, so a script that said one thing forever
 * could only ever drive it into its budget and one that ran out mid-loop would
 * fail on the script rather than on the code. Both of those are now the SDK's
 * one copy rather than this file's second.
 *
 * `installStubStepFetch` rather than `installStubGateway`: `stepGenerate` goes
 * through the published `stepFetch` slot, and a published slot BEATS a stubbed
 * global, so stubbing the global here would test a path production does not
 * take. Anything that is not a completion request THROWS — every step in this
 * body is a model call, so a request the route does not recognise is a finding,
 * and answering it with a reply anyway is how a stage that started dialling
 * something else would pass.
 */
function scriptGateway(contents: readonly string[]) {
  const model = stubGatewayRoute(contents);
  // `routeStepFetch` defaults to throwing on an unrecognised request, which is
  // what this file wants and what it used to spell out: every step in this body
  // is a model call, so anything the route does not recognise is a finding.
  installStubStepFetch(routeStepFetch([model.route]));
  return model;
}

describeWorkflowEval(agentDef, (test) => {
  test("runs a round and lets the CRITIC decide whether there is another", async ({
    app,
    mode,
  }) => {
    // One round in live mode, deliberately: the claim is about the loop's exit,
    // and three long-form model calls are enough to make it.
    if (mode === "stub") scriptGateway([DRAFT, critique("ship")]);

    const run = await app.run(redline, {
      brief: BRIEF,
      audience: "engineers",
      rounds: 1,
      mustCover: MUST_COVER,
    });

    // The error first, so a failed run names its own reason.
    expect(run.error).toBeUndefined();
    expect(run.status).toBe("completed");

    const output = run.output;
    if (output === undefined) expect.fail("a completed run must carry an output");
    expect(output.roundsRun).toBe(1);
    expect(output.rounds).toHaveLength(1);

    const last = output.rounds.at(-1);
    if (last === undefined) expect.fail("a run of one round must record it");
    // THE INVARIANT the template exists for: `shipped` is true exactly when the
    // critic said so, and a shipped round revised nothing after it. Get either
    // half wrong and the loop spends a model call it did not need, or stops one
    // short — both of which read as a working run.
    expect(["ship", "revise"]).toContain(last.critique.verdict);
    expect(output.shipped).toBe(last.critique.verdict === "ship");
    if (output.shipped) expect(last.revisedWords).toBeUndefined();
    else expect(last.revisedWords).toBeTypeOf("number");

    // The score is CLAMPED at the call site rather than by the schema, so a
    // model answering 11 still lands in range.
    expect(last.critique.score).toBeGreaterThanOrEqual(1);
    expect(last.critique.score).toBeLessThanOrEqual(10);
    expect(last.critique.notes.length).toBeLessThanOrEqual(3);

    // It wrote about the brief it was given, not about writing in general.
    expect(output.draft).toMatch(/quokka/i);
    expect(output.words).toBeGreaterThan(5);

    // Both stages narrated, and the round is numbered — which is what a page
    // watching the run renders.
    expect(run.reported[0]).toBe("Writing the first draft for engineers.");
    expect(run.reported).toContain("Round 1: reading it back critically.");
    // Nothing durable was asked for, so nothing was skipped: this body's only
    // waits are its model calls.
    expect(run.slept).toEqual([]);
  });

  test("stops on the ROUND BUDGET when the critic never ships", async ({ app }) => {
    // Scripted in both modes: a live critic cannot be made to refuse three times
    // running, and asking it and then accepting whatever it says is not evidence
    // about the budget. What this pins is the loop's arithmetic — the half a
    // live case cannot reach.
    const model = scriptGateway([
      DRAFT,
      critique("revise", 4),
      `${DRAFT} It starts on the first Monday of the month.`,
      critique("revise", 5),
      `${DRAFT} It starts on the first Monday, and the handover is a written note.`,
      critique("revise", 6),
    ]);

    const run = await app.run(redline, {
      brief: BRIEF,
      audience: "executives",
      rounds: MAX_ROUNDS,
      mustCover: MUST_COVER,
    });

    expect(run.error).toBeUndefined();
    const output = run.output;
    if (output === undefined) expect.fail("a completed run must carry an output");

    // The BUDGET stopped it, not the critic — which is the field a page reads to
    // say "this is as good as it got" rather than "this is finished".
    expect(output.shipped).toBe(false);
    expect(output.roundsRun).toBe(MAX_ROUNDS);
    // Every round revised, because none of them shipped.
    expect(
      output.rounds.map((round) => round.revisedWords).every((n) => typeof n === "number"),
    ).toBe(true);
    // One draft plus a critique-and-revise pair per round. A loop that critiqued
    // twice, or revised the round it shipped, changes this number.
    expect(model.calls).toHaveLength(1 + 2 * MAX_ROUNDS);

    // `briefBlock` is what keeps the three stages from drifting apart, and this is
    // the assertion behind that claim: the writer, the critic AND the reviser were
    // all shown the same brief and the same must-cover point. Read off the
    // recorded `prompt` — the USER message — rather than off the raw request
    // body, which is the whole serialized request and would let a `model` id or a
    // `temperature` satisfy one of these `toContain`s.
    const prompts = model.calls.map((call) => call.prompt);
    expect(prompts).toHaveLength(1 + 2 * MAX_ROUNDS);
    for (const prompt of prompts) {
      expect(prompt).toContain("quokka");
      expect(prompt).toContain(MUST_COVER[0]);
    }
    // The critic and the reviser were also shown the DRAFT, which the writer
    // could not have been.
    expect(prompts[1]).toContain("The on-call rotation is moving");
    expect(prompts[2]).toContain("The critique");
  });

  test("refuses a brief that is only whitespace, terminally", async ({ app }) => {
    // No model is reached on this path in either mode, so it costs nothing live.
    // The case exists because the schema's `.min(20)` counts CHARACTERS: twenty
    // spaces validate at `start()` and arrive at the writer as nothing to write
    // from, which is why `writeDraft` carries its own `FatalError`.
    const run = await app.run(redline, {
      brief: " ".repeat(40),
      audience: "general readers",
      rounds: 1,
      mustCover: [],
    });

    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/too short to write from/i);
    expect(run.output).toBeUndefined();
    // It failed before narrating anything, which is the ordering the guard
    // implies: the check is the first thing in the step.
    expect(run.reported).toEqual([]);
  });
});
