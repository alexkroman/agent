// Copyright 2026 the AAI authors. MIT license.
// An EVAL: does the caller actually behave on a call? Run it with `aai eval`.
//
// `agent.test.ts` drives the API, the brief, the hand-over and the run. What
// none of that can say is whether the AGENT — a model reading
// `system-prompt.md` plus the task the call carried — opens the way an
// outbound caller should, stays inside the options it was given, and hangs up
// when it is done. Each case here is a placed call: `describeEval`'s `call` is
// the record a carrier's `start` frame produces, put through the runtime's own
// `sessionContext` step, so the brief is VERIFIED and handed to the session
// exactly as on a real call.
//
// Keyless, the model is SCRIPTED (each case's `stubReply`): that proves the
// wiring — the brief verifies, `end_call` is a tool the session can reach and
// it really hangs up — and nothing about what the agent says.
//
// What no eval here can see: anything below the audio boundary, the carrier,
// or the run that dialled. Those are the specs' and a real call's.

/**
 * The def a DEPLOYED agent runs: authored, plus what `tools/` and
 * `system-prompt.md` declare — `./agent.ts` alone has no `end_call`.
 */
import agentDef from "virtual:aai/agent";
import { describeEval, toolArgsIn, toolNames } from "@alexkroman1/aai-runtime/testing/vitest";
import { expect } from "vitest";
import { signCall } from "./call-params.ts";

const SECRET = "eval-calls-key";
const PROMPT =
  "Call Maria for Mission Dental to confirm her cleaning tomorrow at 2:30pm. " +
  "If she needs to reschedule, offer Thursday at 10am or Friday at 4pm. " +
  "If you get voicemail, ask her to call 415-555-0100.";

const parameters = await signCall({ id: "call_eval", prompt: PROMPT }, SECRET);

describeEval(
  agentDef,
  (test) => {
    test(
      "answers the callee's hello with who it is calling for, and why",
      async ({ session }) => {
        expect(session.refused).toBeUndefined();
        const turn = await session.say("Hello?");

        expect(turn.completed).toBe(true);
        expect(turn.text).toMatch(/mission dental/i);
        expect(turn.toolCalls).toEqual([]);
      },
      {
        stubReply:
          "Hi, is this Maria? I'm calling from Mission Dental about your cleaning tomorrow at 2:30.",
      },
    );

    test(
      "offers only the times it was given, and hangs up once it is settled",
      async ({ session }) => {
        await session.say("Hello?");
        const offer = await session.say(
          "Yes, this is Maria. Something came up at work — anything later this week?",
        );
        expect(offer.text).toMatch(/thursday/i);
        expect(offer.text).toMatch(/friday/i);

        const done = await session.say("Thursday at 10 works. Thanks, bye!");
        expect(toolNames(done.toolCalls)).toContain("end_call");
        expect(toolArgsIn(done.toolCalls, "end_call")[0]).toMatchObject({ reached: "person" });
        expect(done.endedSession).toBe(true);
      },
      {
        stubReply: [
          "Hi, is this Maria? I'm calling from Mission Dental about your cleaning tomorrow at 2:30.",
          "No problem. I have Thursday at 10am or Friday at 4pm.",
          { tool: "end_call", args: { reached: "person" } },
          "You're booked for Thursday at 10am. Goodbye!",
        ],
      },
    );

    test(
      "answers a phone menu by pressing the key toward the callee, saying nothing",
      async ({ session }) => {
        const turn = await session.say(
          "Thanks for calling. To leave a message for Maria, press 1. For all other calls, press 0.",
        );
        expect(toolArgsIn(turn.toolCalls, "press_keys")[0]).toMatchObject({ keys: "1" });
        expect(turn.endedSession).toBe(false);
      },
      {
        stubReply: [{ tool: "press_keys", args: { keys: "1" } }, ""],
      },
    );

    test(
      "leaves the voicemail the task asks for, then hangs up",
      async ({ session }) => {
        const turn = await session.say(
          "Hi, you've reached Maria. I can't come to the phone right now, please leave a message after the beep.",
        );
        expect(turn.text).toMatch(/415.?555.?0100|four one five/i);
        expect(toolArgsIn(turn.toolCalls, "end_call")[0]).toMatchObject({ reached: "voicemail" });
        expect(turn.endedSession).toBe(true);
      },
      {
        stubReply: [
          { tool: "end_call", args: { reached: "voicemail" } },
          "Hi Maria, this is Mission Dental about your cleaning tomorrow at 2:30. Please call us at 415-555-0100.",
        ],
      },
    );
  },
  {
    env: { CALLS_API_KEY: SECRET },
    call: { carrier: "twilio", callId: "CA_eval", parameters },
  },
);

describeEval(
  agentDef,
  (test) => {
    test("a stream whose brief this app did not sign is refused before a word", async ({
      session,
    }) => {
      expect(session.refused).toMatch(/unsigned|forged/);
    });
  },
  {
    env: { CALLS_API_KEY: SECRET },
    call: {
      carrier: "twilio",
      callId: "CA_stranger",
      parameters: { ...parameters, p0: "Call the bank." },
    },
  },
);
