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
import { toolNames, toolResultIn } from "@alexkroman1/aai-runtime/eval";
import { describeEval } from "@alexkroman1/aai-runtime/eval/vitest";
import { expect } from "vitest";
import { z } from "zod";
import { disclosureFor, PLANS } from "./shared.ts";

/**
 * What a GATED tool answers with, as this eval reads it.
 *
 * The envelope is the SDK's: `result` is the tool's own return value and
 * `state` is where the call landed, written by `dialog.tool` rather than by any
 * tool file. Parsing rather than casting is what makes a template that stopped
 * carrying its position fail here naming the field.
 */
const gated = <T extends z.ZodType>(result: T) =>
  z.object({ result, state: z.string(), done: z.boolean() });

/** A refusal: what a `when` gate answers instead of running the body. */
const REFUSAL = z.object({ error: z.string() });

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
        gated(z.object({ where: z.string() })),
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
      await session.say(
        "My car won't start — route nine past Millfield, silver Corolla, I'm off the road.",
      );
      const turn = await session.say("The number on the card is R S four four one seven.");

      // The disclosure is not a sentence the model composes: it comes back from
      // the tool, and it must be the one this plan priced. Computed here from
      // the template's own function rather than pasted, so a change to the
      // wording moves both together and a change to the PLAN does not.
      const handed = toolResultIn(
        turn.toolCalls,
        "service_disclosure",
        gated(z.object({ readThisVerbatim: z.string() })),
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
        { tool: "service_disclosure" },
        "Before I send anyone, I have to read you this.",
      ],
    },
  );
});
