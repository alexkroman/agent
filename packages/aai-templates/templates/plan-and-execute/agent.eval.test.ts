// An EVAL: does the desk really plan, work one step, and replan? Run it with
// `aai eval`.
//
// `agent.test.ts` drives the three nodes and the four tools directly. What it
// cannot see is the LOOP as a caller drives it: whether the flow gate stops a
// step being worked before there is a plan, and whether one turn does exactly
// one step rather than running the plan to completion down a silent line. Both
// of those are read off the event stream here.
//
// **One thing a SCRIPTED run cannot reach: `ctx.generate`.** The stub model
// registers as an LLM provider, so `ctx.generate` resolves it — and the fake
// answers `doStream` only, so any tool that calls a model comes back
// `{"error":"The planner failed: fake LLM: doGenerate not implemented"}`. That
// is three of this template's four tools. So the two cases that run without a
// key are the ones about the GATE, which refuses before the body runs, and
// everything about the plan itself is `{ live: true }`.
//
// **`system-prompt.md` is applied HERE, not by `agent.ts`.** The build discovers
// the file, so an eval driving the raw default export would run this agent with
// the FRAMEWORK DEFAULT prompt — and the discipline that prompt imposes is the
// entire subject of this file. Measured against the default: the model answers
// product questions from its own knowledge and skips the tools the prompt exists
// to route it through, so a case run that way measures nothing it claims to.

/** The def a DEPLOYED agent runs — see `agent.test.ts` on why the glob is here. */
import agentDef from "virtual:aai/agent";
import {
  describeToolCalls,
  describeTurn,
  type EvalSession,
  lastStateIn,
  toolNames,
} from "@alexkroman1/aai-runtime/eval";
import { describeEval } from "@alexkroman1/aai-runtime/eval/vitest";
import { expect } from "vitest";
import { z } from "zod";

/**
 * What the BROWSER is sent, as this eval reads it.
 *
 * Parsed rather than cast: `state.updated` carries `unknown`, so a projection
 * that stopped matching FAILS naming the field, where the cast this replaced
 * handed the assertions `undefined` and failed a line later on something else.
 * It names only the fields asserted below, so `planView` may grow without
 * touching this.
 */
const ProjectedPlan = z.object({
  objective: z.string().nullable(),
  plan: z.array(z.string()),
  done: z.array(z.object({ step: z.string(), result: z.string() })),
  response: z.string().nullable(),
  revisions: z.array(z.string()),
  progress: z.number(),
});

/**
 * The latest `syncState` frame — what the browser would be rendering.
 *
 * `planProjection` rides out on `state.updated` after every tool call, so this
 * is how an eval sees the plan at all: the session hands back events, and the
 * projection is the one of them that carries state. `lastStateIn` is the SDK's
 * reader for exactly this.
 */
const planState = (session: EvalSession) => lastStateIn(session.events(), ProjectedPlan);

describeEval(agentDef, (test) => {
  test(
    "the stage the desk reports is the flow's, not a guess at the plan",
    async ({ session }) => {
      const turn = await session.say("Where do we stand with all this?");

      // `plan_status` is the one tool that reads the machine's own position, and
      // it is legal in every state. Whatever the model did with the answer, the
      // desk must not have invented a plan to report.
      const view = planState(session);
      expect(view?.objective ?? null).toBeNull();
      expect(view?.progress ?? 0).toBe(0);

      for (const call of turn.toolCalls.filter((one) => one.name === "plan_status")) {
        // `stage` comes off `planFlow.position`, and `reads` off `stageLabel` —
        // deriving either from `!plan.objective` a second time is the drift this
        // template removed, and it would show up right here.
        expect(call.result).toMatch(/"stage":"idle"/);
        expect(call.result).toMatch(/no plan yet/);
        expect(call.result).toMatch(/start_plan/);
      }
    },
    { stubReply: [{ tool: "plan_status" }, "Nothing on the go yet — what are you trying to do?"] },
  );

  test(
    "no step can be worked before a plan exists",
    async ({ session, mode }) => {
      const turn = await session.say("Skip the planning — just go and do the next step.");

      const attempts = turn.toolCalls.filter((call) => call.name === "work_next_step");
      // The script FORCES the call in stub mode, so the gate really runs; a live
      // model that declines to call it has honoured the same rule a level
      // earlier, which is why the count is asserted only where it is decided.
      if (mode === "stub") expect(attempts).toHaveLength(1);
      for (const attempt of attempts) {
        // Refused BEFORE the body: `when: "working"` is what replaced the two
        // hand-rolled guards, and its refusal names the position and quotes the
        // state's instruction so the model can recover on its own turn.
        expect(attempt.result).toMatch(/Not available yet/);
        expect(attempt.result).toMatch(/idle/);
        expect(attempt.result).toMatch(/start_plan/);
      }
      // And whatever else happened, nothing was ANSWERED: a desk that produced
      // a response without working a step is the failure the flow exists to
      // prevent.
      expect(planState(session)?.response ?? null).toBeNull();
    },
    {
      stubReply: [
        { tool: "work_next_step" },
        "There's no plan yet — tell me what you're trying to get done.",
      ],
    },
  );

  test(
    "a step is worked once per call, and a worked step leaves the plan",
    async ({ session }) => {
      await session.say(
        "I want to work out whether it is cheaper to take the train or fly from London to Edinburgh next month.",
      );
      const started = session.toolCalls().find((call) => call.name === "start_plan");
      // The whole SESSION's calls, not one turn's: the plan may be started on
      // either utterance, and "expected undefined to be defined" says nothing
      // about a desk that talked instead. `describeToolCalls` is that sentence.
      expect(started, describeToolCalls(session.toolCalls())).toBeDefined();
      const planned = planState(session);
      // The tool's own result rides in the message: a planner that FAILED (a
      // gateway error, a schema the provider would not honour) writes nothing,
      // and "objective is null" on its own reads as a projection bug.
      expect(planned?.objective, `start_plan answered: ${started?.result}`).toBeTruthy();
      expect(planned?.plan.length ?? 0).toBeGreaterThan(0);

      const worked = await session.say("Yes, go ahead and start on it.");
      const calls = toolNames(worked.toolCalls).filter((name) => name === "work_next_step").length;
      expect(calls, describeTurn(worked)).toBeGreaterThan(0);

      const after = planState(session);
      const done = after?.done ?? [];
      expect(done.length).toBeGreaterThan(0);
      // ONE STEP PER CALL: `work_next_step` is one execute-then-replan turn, not
      // a loop. More steps recorded than calls made would mean the tool had run
      // the plan to completion, leaving the caller on a silent line with no gap
      // to change their mind in — which is the pause the whole design is for.
      //
      // Note this is the guarantee the template ENFORCES, and it is weaker than
      // the one it asks for: "call this once per step, never in a loop" is in the
      // system prompt AND the tool description, and a live model was measured
      // calling it twice in one turn anyway. One session has one tool list and
      // no per-turn hook, so the pause is asked for rather than enforced; what IS
      // enforced is everything below.
      expect(done.length).toBeLessThanOrEqual(calls);
      for (const step of done) expect(step.result).toBeTruthy();
      expect(after?.progress ?? 0).toBeGreaterThan(0);
      // The step is CLAIMED off the head of the plan inside the synchronous
      // update window, so no step can be done twice and a completed step is gone
      // from what is left — that claim is what makes two concurrent calls safe.
      const labels = done.map((step) => step.step);
      expect(new Set(labels).size, `a step was worked twice: ${labels.join(" | ")}`).toBe(
        labels.length,
      );
      for (const label of labels) expect(after?.plan ?? []).not.toContain(label);
    },
    // Live only: this step is a real model call and a real web search, which is
    // the point — a scripted planner is a template that "plans" by imagining
    // having looked something up.
    { live: true },
  );

  test(
    "when the caller changes their mind it is the replanner that rewrites the plan",
    async ({ session }) => {
      await session.say(
        "I need to sort out getting from London to Edinburgh next month — train or flight, whichever works.",
      );
      const before = planState(session);
      expect(before?.plan.length ?? 0).toBeGreaterThan(0);

      const turn = await session.say("Actually, forget the train entirely — I only want to fly.");

      const revised = turn.toolCalls.find((call) => call.name === "revise_plan");
      expect(
        revised,
        `${describeTurn(turn)} — the caller changed the objective, ` +
          "so this is `revise_plan`, not a plan rewritten by hand",
      ).toBeDefined();
      expect(revised?.args.instruction).toBeTruthy();

      const after = planState(session);
      // The trail is what the sidebar renders and what a caller cannot hold by
      // ear: a revision the caller asked for is recorded as theirs.
      expect(after?.revisions.some((entry) => entry.startsWith("Caller:"))).toBe(true);
      // A revision reopens the plan rather than answering it, and completed
      // steps are never redone — there are none here, so the whole plan is new.
      expect(after?.plan).not.toEqual(before?.plan);
      expect(after?.done).toHaveLength(0);
    },
    { live: true },
  );
});
