/**
 * The meeting assistant — their `find_meeting_time`, which is a ReAct agent
 * over one calendar tool, and is therefore a SUBAGENT here rather than a
 * `ctx.generate`.
 *
 * Theirs builds `create_react_agent(llm, [get_events_for_days])` inside the
 * node and hands it the thread; the agent looks days up until it can state the
 * free slots, and its final message goes back to `draft_response` as a tool
 * result. That is exactly what `ctx.delegate` is: a tool loop with its own
 * context window, whose FINAL message is all the caller sees. The calendar
 * lookups stay inside the run, so a week of events never lands in the phone
 * call's own context.
 *
 * `expectedOutput` carries the "extremely high density" rule their prompt ends
 * on, so it lands in the same place every time rather than at the bottom of the
 * brief where a model may or may not still be reading. What `expectedOutput`
 * cannot do is REFUSE an answer that ignored it, which is what
 * {@link statesAvailability} is for.
 */

import {
  DEFAULT_GUARDRAIL_MAX_RETRIES,
  type DelegateFn,
  type GuardrailVerdict,
  isoDate,
  spokenDate,
  subagent,
  tool,
} from "@alexkroman1/aai";
import { z } from "zod";
import { CALENDAR, type CalendarEvent, EXECUTIVE, TODAY } from "./inbox.ts";
import { MEETING_EXPECTED_OUTPUT, meetingSystem } from "./prompts.ts";

/**
 * Their `get_events_for_days` over the frozen calendar. A subagent's tool, not
 * one of the agent's: it lives here rather than in `tools/`, so the executive's
 * own model never sees it — asking the meeting assistant is the only way in.
 *
 * The day is named twice, as the date and as `spokenDate` renders it, because
 * the weekday is the half a model reasons about ("next Tuesday") and the half
 * it gets wrong. That rendering is fixed ASCII: the `toLocaleDateString` this
 * replaced answered to the host's ICU build, so the same lookup could name a
 * different weekday inside the guest sandbox than on the author's laptop, with
 * no spec able to see it.
 */
export const calendarTool = tool({
  description:
    "The executive's calendar for the given days. Returns each day's booked events with " +
    "start and end times; anything not listed between 9am and 5pm is free.",
  inputSchema: z.object({
    days: z.array(isoDate("a day to look up")).min(1).max(10).describe("Dates to look up"),
  }),
  execute({ days }) {
    return {
      timezone: EXECUTIVE.timezone,
      days: days.map((date) => ({
        date,
        day: spokenDate(date),
        events: CALENDAR.filter((event) => event.date === date).map(
          (event) => `${event.start}-${event.end} ${event.title}`,
        ),
      })),
    };
  },
});

/**
 * What the calendar already holds in that window, if anything.
 *
 * A zero-padded `HH:MM` compares as a string, which is why an invite takes a
 * `clockTime()` for each end rather than one ISO datetime — and why
 * `calendar.test.ts` holds {@link CALENDAR}'s own times to the same shape: a
 * `9:00` in the fixture would sort before every event rather than after eight
 * of them, and the clash it hid would be a double-booked executive.
 */
export function clashOn(date: string, start: string, end: string): CalendarEvent | undefined {
  return CALENDAR.find((event) => event.date === date && start < event.end && event.start < end);
}

/** A time the desk could actually offer back — "1pm-3pm", "10:30am". */
const NAMES_A_TIME = /\b\d{1,2}(:\d{2})?\s?[ap]m\b/i;

/** Nothing open, said plainly — the other answer `draft_reply` can act on. */
const NAMES_NO_TIME = /\bnot\s+(free|available)\b|\bno\s+(free|open|available)\b/i;

/**
 * Their prompt asks for slots; what `draft_reply` needs is a slot it can OFFER.
 *
 * A report that says the calendar was checked and stops reads as availability
 * to the desk and offers the sender nothing — and `expectedOutput` can ask for
 * a dense sentence but cannot refuse one that is not. So the run is JUDGED, as
 * `topic-briefing-agent`'s fact checker is, and the complaint names the fix rather
 * than restating the rule. A verdict the run never satisfies is not an error:
 * there IS an answer, and {@link findMeetingTime} passes it on marked unusable.
 */
export function statesAvailability(text: string): GuardrailVerdict {
  if (NAMES_A_TIME.test(text) || NAMES_NO_TIME.test(text)) return true;
  return (
    "State the answer as clock times — 'free Wednesday 1pm-3pm' — or say plainly that there " +
    "is nothing open. A report with no time in it cannot be offered to the sender."
  );
}

/** Steps the assistant may take: two weeks of lookups and an answer. */
export const MAX_MEETING_STEPS = 4;

export const meetingAssistant = subagent({
  name: "meeting-assistant",
  systemPrompt: meetingSystem(EXECUTIVE, `${spokenDate(TODAY)} (${TODAY})`),
  expectedOutput: MEETING_EXPECTED_OUTPUT,
  tools: { get_events_for_days: calendarTool },
  maxSteps: MAX_MEETING_STEPS,
  guardrail: (answer) => statesAvailability(answer.text),
  // Stated rather than left to the default, because the guardrail is what makes
  // a retry possible and a retry is another whole run: the executive is on the
  // phone, and what they wait through is `MAX_MEETING_STEPS` lookups twice over.
  maxRetries: DEFAULT_GUARDRAIL_MAX_RETRIES,
});

/**
 * Their `find_meeting_time`: hand the thread to the specialist and return what
 * it concluded, plus what the wait cost — the sentence the caller was owed
 * while the line was quiet.
 *
 * `usable` is the guardrail's verdict, not an error. The desk is mid-call with
 * a sender waiting on an answer, so an unaccepted report is still read — with
 * the tool telling the model that it may not turn it into an offer.
 */
export async function findMeetingTime(
  delegate: DelegateFn,
  thread: string,
  request: string,
): Promise<{ availability: string; lookups: number; usable: boolean }> {
  const run = await delegate(meetingAssistant, {
    task: `${request}\n\nHere is the email thread:\n\n${thread}`,
  });
  return { availability: run.text, lookups: run.toolCalls.length, usable: run.accepted };
}
