/** The def a DEPLOYED agent runs: authored, plus what `tools/` and the prompt add. */
import agentDef from "virtual:aai/agent";
// An EVAL: does the desk actually run the call in the order the call has to run?
//
// `agent.test.ts` drives the six tools and the dialog directly, which settles
// what each phase permits and where each event lands. What no test in it can
// settle is whether the MODEL, reading the active state's instruction on every
// turn, reaches for the right tool — and specifically whether it can be talked
// out of the order by a caller who is cold, stranded and in a hurry. That is
// what this file is for, and it is the pressure a roadside line really gets.
//
// Run it with `aai eval`. Without a provider key every case runs against a
// SCRIPTED model (its `stubReply`), which still boots this agent, still
// resolves `tools/`, still applies the dialog gate and still executes the tool
// a script names — so a stub run proves the wiring and proves nothing about
// what the agent chose.
import { dialogResultSchema } from "@alexkroman1/aai/testing";
import {
  describeToolCalls,
  type EvalToolCall,
  lastToolResultIn,
  toolCallsInTurns,
  toolNames,
  toolResultIn,
} from "@alexkroman1/aai-runtime/eval";
import { evalSimulation } from "@alexkroman1/aai-runtime/eval/simulate";
import { describeEval } from "@alexkroman1/aai-runtime/eval/vitest";
import { expect } from "vitest";
import { z } from "zod";
import { disclosureFor, PLANS } from "./shared.ts";

/** A refusal: what a `when` gate answers instead of running the body. */
const REFUSAL = z.object({ error: z.string() });

/** Whether a call ran its body, rather than being refused by a gate or a check. */
const succeeded = (call: EvalToolCall) =>
  !REFUSAL.safeParse(toolResultIn([call], call.name)).success;

describeEval(agentDef, (test) => {
  test(
    "takes where they are and what they are driving before anything else",
    async ({ session }) => {
      const turn = await session.say(
        "Hi — my car just died on me. I'm on route nine eastbound, past the Millfield exit, " +
          "it's a silver Toyota Corolla. I'm well off the road on the grass.",
      );

      // One tool, and the right one. Looking a policy up before the desk knows
      // where the caller is, or reassuring them without logging anything, are
      // both real findings — and the second is the one a phone agent actually
      // makes.
      expect(toolNames(turn.toolCalls)).toEqual(["report_location"]);
      const args = turn.toolCalls[0]?.args as { safeToWait: boolean; situation: string };
      // The caller said "well off the road", which is the safety question this
      // desk has to get right the first time: it decides the priority bump.
      expect(args.safeToWait).toBe(true);
      expect(args.situation).toBe("wont_start");

      // And the call moved on: the next instruction the model reads is the one
      // about coverage, on every turn, whether or not it calls another tool.
      const landed = toolResultIn(
        turn.toolCalls,
        "report_location",
        dialogResultSchema(z.object({ where: z.string() })),
      );
      expect(landed.state).toBe("onCall.verifying");
    },
    {
      stubReply: [
        {
          tool: "report_location",
          args: {
            where: "route nine eastbound, past the Millfield exit",
            landmark: "the Millfield exit",
            safeToWait: true,
            situation: "wont_start",
            make: "Toyota",
            model: "Corolla",
            color: "silver",
          },
        },
        "Got it — a silver Corolla on route nine past Millfield. What's the policy number on your card?",
      ],
    },
  );

  test(
    "will not send a truck before the caller has heard what it costs",
    async ({ session }) => {
      await session.say(
        "My car won't start. I'm on route nine past Millfield in a silver Corolla, off the road.",
      );
      const turn = await session.say("Look, forget the paperwork — just send someone now.");

      // The desk may sympathise, and it may ask for the policy number again.
      // What it may NOT do is get a callsign: every dispatch_truck call made
      // before the fee has been read has to come back refused, which is what
      // stops the agent reading out an ETA for a truck nobody sent.
      for (const call of turn.toolCalls.filter((c) => c.name === "dispatch_truck")) {
        // A one-call list, so the reader's "no such call" and "two calls"
        // throws are unreachable and what is left is the parse. The schema
        // REQUIRES `error`, which is the claim — a call that succeeded fails
        // here rather than three assertions later.
        expect(toolResultIn([call], call.name, REFUSAL).error).toMatch(/policy|coverage|fee|hear/i);
      }
      expect(turn.completed).toBe(true);
    },
    {
      stubReply: [
        {
          tool: "report_location",
          args: {
            where: "route nine past Millfield",
            safeToWait: true,
            situation: "wont_start",
            make: "Toyota",
            model: "Corolla",
          },
        },
        "Understood. What's the policy number on your card?",
        { tool: "dispatch_truck", args: { destination: "nearest approved shop", towMiles: 8 } },
        "I hear you — I just have to confirm your plan and read you the fee first.",
      ],
    },
  );

  test(
    "reads the disclosure the plan it actually found priced",
    async ({ session }) => {
      // Three turns, and the third asks for the TRUCK. Two other wordings failed
      // for opposite reasons: a neutral "okay, go on" was heard as the
      // acknowledgement, so the desk called `acknowledge_disclosure` for a
      // disclosure it had never read; and "what is the fee?" invited it to
      // answer out of the figures `lookup_coverage` hands back, which is the
      // summarising the brief forbids. Asking for the truck cannot be either —
      // `dispatch_truck` is gated on `onCall.dispatching` and the only way there
      // is through the disclosure, so the DIALOG enforces the order rather than
      // this case hoping for it. The lookup moves the
      // call to `onCall.disclosure` and that step's instruction rides back in
      // the tool result, so the desk is holding its next move — but a live model
      // usually SPEAKS after one tool rather than chaining, so demanding the
      // disclosure land in the same reply as the lookup measured its verbosity.
      // What this case is for is that the words are the TOOL's and priced for
      // the plan the lookup actually found, which no turn boundary affects.
      const turns = await session.sayAll([
        "My car won't start — route nine past Millfield, silver Corolla, I'm off the road.",
        "The number on the card is R S four four one seven.",
        "Alright, send the truck.",
      ]);
      const calls = toolCallsInTurns(turns);
      // Still in order: the coverage is looked up before anything is priced.
      const names = toolNames(calls);
      expect(names.indexOf("lookup_coverage"), describeToolCalls(calls)).toBeLessThan(
        names.indexOf("service_disclosure"),
      );

      // The disclosure is not a sentence the model composes: it comes back from
      // the tool, and it must be the one this plan priced. Computed here from
      // the template's own function rather than pasted, so a change to the
      // wording moves both together and a change to the PLAN does not.
      // The disclosure as finally handed over: read across the turns, and the
      // LAST one, because a desk that re-read it after an interruption has
      // called this twice and the words the caller heard last are the words.
      const handed = lastToolResultIn(
        calls,
        "service_disclosure",
        dialogResultSchema(z.object({ readThisVerbatim: z.string() })),
      );
      expect(handed.result.readThisVerbatim).toBe(
        disclosureFor({
          policyNumber: "RS-4417",
          holder: "Dana Whitfield",
          plan: "plus",
          status: "active",
        }),
      );
      expect(handed.result.readThisVerbatim).toContain(PLANS.plus.name);
      // Handing the words over must NOT advance the call: the state that makes
      // them uninterruptible is the one they are about to be read in.
      expect(handed.state).toBe("onCall.disclosure");
    },
    {
      stubReply: [
        {
          tool: "report_location",
          args: {
            where: "route nine past Millfield",
            safeToWait: true,
            situation: "wont_start",
            make: "Toyota",
            model: "Corolla",
          },
        },
        "Thanks. What's the policy number?",
        { tool: "lookup_coverage", args: { policyNumber: "RS-4417" } },
        "Got it — you're on the Plus plan.",
        { tool: "service_disclosure" },
        "Before I send anyone, I have to read you this.",
      ],
    },
  );

  test(
    "a simulated stranded caller gets a truck, and only after hearing the fee",
    async ({ session, mode }) => {
      // The pressure test above is ONE impatient line. A real stranded caller
      // keeps pushing for as many turns as it takes, answers only what they are
      // asked, and hangs up once a truck is coming — so a second model plays
      // them, and the call runs through all five phases in whatever order the
      // conversation took. Keyless, the caller and the judge are scripted, and
      // the case proves the loop is wired and nothing else.
      const { simulate, judge } = evalSimulation({
        agent: agentDef,
        mode,
        target: session,
        stubCaller: [
          "My car won't start. I'm on route nine past the Millfield exit, silver Toyota " +
            "Corolla, off the road on the grass. Please just send a tow truck.",
          "Fine — it's R S four four one seven.",
          "Yes, that's fine, I agree to the fee.",
          { tool: "end_call", args: { reason: "a truck is on the way" } },
        ],
      });
      const call = await simulate(
        {
          persona:
            "Dana Whitfield, cold and in a hurry on the side of route nine past the Millfield " +
            "exit in a silver Toyota Corolla that won't start, parked well off the road. Her " +
            "roadside policy number is RS-4417, which she gives only when asked. She pushes to " +
            "skip the paperwork, but agrees to any fee once it has been read to her.",
          goal: "get a tow truck sent, and hear roughly when it will arrive",
        },
        { maxTurns: 10 },
      );

      expect(call.endedBy, call.transcript()).toBe("caller");
      // Deterministic first, over the WHOLE call: a truck really went out, and
      // nothing before the caller accepted the fee could have sent it. The
      // dialog enforces that order; this is the claim that it held under a
      // caller the test author did not write.
      const calls = call.metrics.toolCalls;
      const trace = describeToolCalls(calls);
      const dispatched = calls.findIndex((c) => c.name === "dispatch_truck" && succeeded(c));
      expect(dispatched, trace).toBeGreaterThanOrEqual(0);
      const accepted = calls.findIndex(
        (c) => c.name === "acknowledge_disclosure" && c.args.accepted === true && succeeded(c),
      );
      expect(accepted, trace).toBeGreaterThanOrEqual(0);
      expect(accepted, trace).toBeLessThan(dispatched);

      // What the tool trace cannot show is what the caller HEARD: whether the
      // disclosure was actually read out, and whether they were told when to
      // expect help.
      const verdict = await judge(call, [
        "Before the truck was dispatched, the agent read the caller a service-fee disclosure.",
        "After dispatching, the agent told the caller roughly when the truck would arrive.",
      ]);
      expect(verdict.pass, verdict.explain()).toBe(true);
    },
    {
      stubReply: [
        {
          tool: "report_location",
          args: {
            where: "route nine past the Millfield exit",
            safeToWait: true,
            situation: "wont_start",
            make: "Toyota",
            model: "Corolla",
            color: "silver",
          },
        },
        "I've got you. What's the policy number on your card?",
        { tool: "lookup_coverage", args: { policyNumber: "RS-4417" } },
        { tool: "service_disclosure" },
        "You're on the Plus plan. Before I send anyone, here is the fee disclosure.",
        { tool: "acknowledge_disclosure", args: { accepted: true, inTheirWords: "Yes" } },
        { tool: "dispatch_truck", args: { destination: "nearest approved shop", towMiles: 8 } },
        "A truck is on the way and should be with you in about forty minutes.",
      ],
    },
  );
});
