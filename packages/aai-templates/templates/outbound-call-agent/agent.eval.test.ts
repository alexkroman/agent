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

import agentDef from "virtual:aai/agent";
import { signCallBrief } from "@alexkroman1/aai";
import {
  describeEval,
  toolArgsIn,
  toolNames,
  walkPhoneTree,
} from "@alexkroman1/aai-runtime/testing/vitest";
import { expect } from "vitest";
import { NO_FIT_CALL, PHARMACY_CALL } from "./phone-trees.ts";
import endCall from "./tools/end_call.ts";
import pressKeys from "./tools/press_keys.ts";

const SECRET = "eval-calls-key";
const PROMPT =
  "Call Maria for Mission Dental to confirm her cleaning tomorrow at 2:30pm. " +
  "If she needs to reschedule, offer Thursday at 10am or Friday at 4pm. " +
  "If you get voicemail, ask her to call 415-555-0100.";

const parameters = await signCallBrief({ id: "call_eval", prompt: PROMPT }, SECRET);

const DIGIT_WORDS = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
];

/** The digits in `text`, number words included ("oh" as zero) — a number as it is spoken. */
function spokenDigits(text: string): string {
  return text
    .toLowerCase()
    .replace(/\b(zero|oh|one|two|three|four|five|six|seven|eight|nine)\b/g, (word) =>
      String(word === "oh" ? 0 : DIGIT_WORDS.indexOf(word)),
    )
    .replace(/\D/g, "");
}

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
        expect(done.endedSession).toBe(true);
      },
      {
        stubReply: [
          "Hi, is this Maria? I'm calling from Mission Dental about your cleaning tomorrow at 2:30.",
          "No problem. I have Thursday at 10am or Friday at 4pm.",
          { tool: "end_call", args: {} },
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
        expect(toolArgsIn(turn.toolCalls, pressKeys)[0]).toMatchObject({ keys: "1" });
        // What the line heard, and what the tool told the model back.
        expect(turn.dtmf).toEqual(["1"]);
        expect(turn.toolCalls[0]?.result).toContain('"pressed":"1"');
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
        // However it is read out: "415-555-0100", "4-1-5…", "four-one-five…".
        expect(spokenDigits(turn.text), turn.text).toContain("4155550100");
        // And it SAID it was voicemail, which is what the run's outcome reads.
        expect(toolArgsIn(turn.toolCalls, endCall)[0]).toMatchObject({ voicemail: true });
        expect(turn.endedSession).toBe(true);
      },
      {
        stubReply: [
          { tool: "end_call", args: { voicemail: true } },
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

// Phone trees, walked by the keys the agent actually pressed (`turn.dtmf`): a
// wrong key replays the menu rather than advancing a script written for the
// right one. `phone-trees.ts` holds the trees, which a real call can play too.
describeEval(
  agentDef,
  (test) => {
    test(
      "walks three menus to the pharmacist without a word to any of them, then says why it called",
      async ({ session }) => {
        const walk = await walkPhoneTree(session, PHARMACY_CALL.tree);

        expect(walk.reached, JSON.stringify(walk.path)).toBe(PHARMACY_CALL.goal);
        // A menu is not listening for words.
        const menus = walk.turns.slice(0, -1);
        for (const turn of menus) expect(turn.text).toBe("");
        const greeting = walk.turns.at(-1);
        expect(greeting?.dtmf).toEqual([]);
        expect(greeting?.text).toMatch(/jordan/i);
        expect(greeting?.text).toMatch(/prescription/i);
      },
      {
        stubReply: [
          { tool: "press_keys", args: { keys: "1" } },
          "",
          { tool: "press_keys", args: { keys: "3" } },
          "",
          { tool: "press_keys", args: { keys: "2" } },
          "",
          "Hi Dana, I'm an AI assistant calling for Jordan Lee to check whether a prescription is ready for pickup.",
        ],
      },
    );

    test(
      "takes the catch-all option when no option fits the task, then asks to be put through",
      async ({ session }) => {
        const walk = await walkPhoneTree(session, NO_FIT_CALL.tree);

        expect(walk.reached, JSON.stringify(walk.path)).toBe(NO_FIT_CALL.goal);
        expect(walk.turns.at(-1)?.text).toMatch(/pharmacy|prescription/i);
      },
      {
        stubReply: [
          { tool: "press_keys", args: { keys: "0" } },
          "",
          "Hi, I'm an AI assistant calling about a prescription for Jordan Lee. Could you put me through to the pharmacy?",
        ],
      },
    );
  },
  {
    env: { CALLS_API_KEY: SECRET },
    call: {
      carrier: "twilio",
      callId: "CA_tree",
      parameters: await signCallBrief({ id: "call_tree", prompt: PHARMACY_CALL.task }, SECRET),
    },
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
