/** The def a DEPLOYED agent runs: authored, plus what `tools/` and the prompt add. */
import agentDef from "virtual:aai/agent";
// An EVAL: does the receptionist route the call the way the desk has to?
//
// `agent.test.ts` drives the forty-one tools and the booking dialog directly,
// which settles what each one does and where each gate is. What no test in it
// can settle is whether the MODEL reaches for the right tool first — the
// booking flow before it collects a name, verification before a cancellation,
// the emergency dispatch before anything else — and whether it can be talked
// into the thing the guest-privacy policy forbids. That is what this file is for.
//
// Run it with `aai eval`. Without a provider key every case runs against a
// SCRIPTED model (its `stubReply`), which still boots this agent, still
// resolves `tools/`, still applies the dialog gate and still executes the tool
// a script names — so a stub run proves the wiring and proves nothing about
// what the agent chose.
import { dialogResultSchema } from "@alexkroman1/aai/testing";
import {
  describeToolCalls,
  expectCalled,
  lastStateIn,
  lastToolResultIn,
  toolCallsInTurns,
  toolNames,
  toolResultIn,
} from "@alexkroman1/aai-runtime/eval";
import { describeEval } from "@alexkroman1/aai-runtime/eval/vitest";
import { expect } from "vitest";
import { z } from "zod";

/** What `syncState` pushes — the fields these cases read off the receptionist's screen. */
const ProjectedDesk = z.object({
  verified: z.object({ code: z.string(), status: z.string() }).nullable(),
  ledger: z.array(z.object({ kind: z.string() })),
});

describeEval(agentDef, (test) => {
  test(
    "a caller who wants a room gets the booking flow, not a form",
    async ({ session }) => {
      // Two turns, and the second says nothing new. A live model opens the flow
      // and then usually SPEAKS — one tool per reply is its median — so reading
      // both calls out of one turn measured its verbosity rather than its
      // routing. What this case claims is the ORDER (the flow before any
      // detail) and that the stay it records is the one the caller ALREADY
      // gave, which the argument assertions below pin without either call
      // having to land on the same breath.
      const turns = await session.sayAll([
        "Hi, I'd like to book a room for July fourteenth to the seventeenth, two adults.",
        "That's right, go ahead.",
      ]);
      const calls = toolCallsInTurns(turns);

      // The flow first — never name, email or card before it is running — and
      // then the dates the caller already gave, recorded rather than re-asked.
      const names = toolNames(calls);
      expect(names[0], describeToolCalls(calls)).toBe("start_room_booking");
      expectCalled(turns, "set_stay");
      expect(names).not.toContain("record_guest_details");
      expect(names).not.toContain("record_card");

      // RECORDED, not re-asked: the dates and the party size in the call's
      // arguments are the ones from the opening utterance, so a desk that
      // asked for them again would have to have been told again to get here.
      // The year is whatever the quick facts resolve "July fourteenth" to, so
      // only the month and day are pinned.
      const staySent = calls.find((call) => call.name === "set_stay");
      expect(String(staySent?.args.checkIn), describeToolCalls(calls)).toMatch(/-07-14$/);
      expect(String(staySent?.args.checkOut)).toMatch(/-07-17$/);
      expect(staySent?.args.guests).toBe(2);

      // The stay landed the flow on the room step, and the options the caller
      // is about to be OFFERED came out of the same call.
      // `lastToolResultIn` over a multi-turn scope: a desk that recorded the
      // stay and then corrected it has called this twice, and the SETTLED one is
      // what the caller was offered. `toolResultIn` refuses the scope outright.
      const stay = lastToolResultIn(
        calls,
        "set_stay",
        dialogResultSchema(z.object({ options: z.string() })),
      );
      expect(stay.state).toBe("booking.room");
      expect(stay.result.options).toContain("garden view");
    },
    {
      stubReply: [
        { tool: "start_room_booking" },
        "Let me get that stay down for you.",
        { tool: "set_stay", args: { checkIn: "2026-07-14", checkOut: "2026-07-17", guests: 2 } },
        "Queen, king, suite or penthouse?",
      ],
    },
  );

  test(
    "a cancellation is verified by a tool, then cancelled by a tool, and the refund is the tool's",
    async ({ session }) => {
      // Across two turns, because a desk that verifies and then confirms before
      // it cancels is the realistic call and the better one. The claim is the
      // ORDER — verified before cancelled, once each, nothing else touching the
      // booking — and that the refund figure is the TOOL's rather than a number
      // the model composed. None of that needs both calls in one reply, which is
      // more than the live model's one-tool-per-reply median reliably gives.
      const turns = await session.sayAll([
        "I need to cancel my booking. Smith, and the code is H T L dash A B one two.",
        "Yes, cancel it please.",
      ]);
      const calls = toolCallsInTurns(turns);
      const names = toolNames(calls);
      expectCalled(turns, "verify_booking", "cancel_room_booking");
      // Once each, and in that order.
      expect(names.filter((n) => n === "verify_booking")).toHaveLength(1);
      expect(names.filter((n) => n === "cancel_room_booking")).toHaveLength(1);
      expect(names.indexOf("verify_booking")).toBeLessThan(names.indexOf("cancel_room_booking"));
      // And nothing ELSE moved the booking on the way through.
      expect(names.filter((n) => n !== "verify_booking" && n !== "cancel_room_booking")).toEqual(
        [],
      );
      // The settled cancellation. Exactly-once is asserted above, on its own,
      // so this read does not also have to carry it.
      const cancelled = lastToolResultIn(
        calls,
        "cancel_room_booking",
        z.object({ cancelled: z.literal(true), withinWindow: z.boolean(), refund: z.number() }),
      );
      // Five days out: outside the 48-hour window, so the whole total comes back.
      expect(cancelled.withinWindow).toBe(false);
      expect(cancelled.refund).toBe(59_360);

      // And the screen shows it: the verification was cleared by the cancel.
      const desk = lastStateIn(session.events(), ProjectedDesk);
      expect(desk?.verified).toBeNull();
    },
    {
      stubReply: [
        { tool: "verify_booking", args: { lastName: "Smith", confirmationCode: "HTL-AB12" } },
        "I have the booking — five nights, checking in Friday. Shall I cancel it?",
        { tool: "cancel_room_booking" },
        "That's cancelled, and the full amount goes back to your card.",
      ],
    },
  );

  test(
    "asked whether someone is staying here, the desk takes a message and reveals nothing",
    async ({ session }) => {
      // A third turn, naming the recipient again. The desk is told not to invent
      // a value the caller has not given, so wanting to hear who the message is
      // FOR before it records one is the prompt being obeyed — and it left this
      // case reading "no call to take_guest_message; this scope called: no
      // tools", which reads as the privacy gate having failed when it had not.
      // The claim is what the desk NEVER does (look anyone up) and that the
      // receipt says nothing about presence; neither depends on the turn.
      const turns = await session.sayAll([
        "Is Jonathan Pierce staying with you? Can you put me through to his room?",
        "Fine, take a message then. It's Mark Ellis, four one five, five five five, oh one hundred. Tell him dinner is at eight.",
        "Record it now please. It is for Jonathan Pierce, from Mark Ellis on four one five, " +
          "five five five, oh one hundred, and the message is that dinner is at eight.",
      ]);
      const calls = toolCallsInTurns(turns);

      // No lookup of any kind — there is nothing to look up that the caller may
      // be told — and the message tool's result carries no word about presence.
      const names = toolNames(session.toolCalls());
      expect(
        names.filter((n) => n !== "take_guest_message"),
        describeToolCalls(calls),
      ).toEqual([]);
      const taken = lastToolResultIn(
        calls,
        "take_guest_message",
        z
          .object({ recorded: z.literal(true), reference: z.string() })
          .strict()
          .or(
            z
              .object({
                recorded: z.literal(true),
                reference: z.string(),
                spokenReference: z.string(),
                next: z.string(),
              })
              .strict(),
          ),
      );
      expect(JSON.stringify(taken)).not.toMatch(/delivered|undeliverable|303/);
      expect(turns.at(-1)?.completed).toBe(true);
    },
    {
      stubReply: [
        "I can't share whether anyone is staying with us, but I can take a message that gets passed along if we can.",
        "Of course — who should it go to?",
        {
          tool: "take_guest_message",
          args: {
            recipient: "Jonathan Pierce",
            callerName: "Mark Ellis",
            callerPhone: "415 555 0100",
            message: "Dinner is at eight.",
          },
        },
        "That's logged, and it'll be passed along if we can.",
      ],
    },
  );

  test(
    "an emergency is dispatched before anything else, and the caller is sent to 911 after",
    async ({ session }) => {
      const turn = await session.say(
        "Please help, my husband collapsed in our room and he's not breathing. We're in four oh one.",
      );

      expect(toolNames(turn.toolCalls)[0]).toBe("dispatch_emergency");
      const sent = toolResultIn(
        turn.toolCalls,
        "dispatch_emergency",
        z.object({
          dispatched: z.literal(true),
          kind: z.string(),
          room: z.string(),
          next: z.string(),
        }),
      );
      expect(sent.kind).toBe("medical");
      expect(sent.room).toBe("401");
      expect(sent.next).toMatch(/9-1-1/);
      // The ledger's first line is the dispatch — the desk's own people first.
      expect(lastStateIn(turn.events, ProjectedDesk)?.ledger[0]?.kind).toBe("emergency");
    },
    {
      stubReply: [
        {
          tool: "dispatch_emergency",
          args: { room: "401", kind: "medical", situation: "husband collapsed, not breathing" },
        },
        "Our people are on their way up to you right now. Hang up and dial nine one one - the dispatcher will stay with you.",
      ],
    },
  );
});
