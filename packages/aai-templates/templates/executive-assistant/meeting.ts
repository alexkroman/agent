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
 * brief where a model may or may not still be reading.
 */

import { type DelegateFn, subagent, tool } from "@alexkroman1/aai";
import { z } from "zod";
import { CALENDAR, EXECUTIVE, TODAY } from "./inbox.ts";
import { MEETING_EXPECTED_OUTPUT, meetingSystem } from "./prompts.ts";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** `YYYY-MM-DD` to its weekday name — the one thing a model gets wrong about dates. */
export function weekdayOf(date: string): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", {
    weekday: "long",
    timeZone: "UTC",
  });
}

/**
 * Their `get_events_for_days` over the frozen calendar. A subagent's tool, not
 * one of the agent's: it lives here rather than in `tools/`, so the executive's
 * own model never sees it — asking the meeting assistant is the only way in.
 */
export const calendarTool = tool({
  description:
    "The executive's calendar for the given days. Returns each day's booked events with " +
    "start and end times; anything not listed between 9am and 5pm is free.",
  inputSchema: z.object({
    days: z
      .array(z.string().regex(ISO_DATE, "YYYY-MM-DD"))
      .min(1)
      .max(10)
      .describe("Dates to look up, YYYY-MM-DD"),
  }),
  execute({ days }) {
    return {
      timezone: EXECUTIVE.timezone,
      days: days.map((date) => ({
        date,
        weekday: weekdayOf(date),
        events: CALENDAR.filter((event) => event.date === date).map(
          (event) => `${event.start}-${event.end} ${event.title}`,
        ),
      })),
    };
  },
});

/** Steps the assistant may take: two weeks of lookups and an answer. */
export const MAX_MEETING_STEPS = 4;

export const meetingAssistant = subagent({
  name: "meeting-assistant",
  systemPrompt: meetingSystem(EXECUTIVE, `${weekdayOf(TODAY)} ${TODAY}`),
  expectedOutput: MEETING_EXPECTED_OUTPUT,
  tools: { get_events_for_days: calendarTool },
  maxSteps: MAX_MEETING_STEPS,
});

/**
 * Their `find_meeting_time`: hand the thread to the specialist and return what
 * it concluded, plus what the wait cost — the sentence the caller was owed
 * while the line was quiet.
 */
export async function findMeetingTime(
  delegate: DelegateFn,
  thread: string,
  request: string,
): Promise<{ availability: string; lookups: number }> {
  const run = await delegate(meetingAssistant, {
    task: `${request}\n\nHere is the email thread:\n\n${thread}`,
  });
  return { availability: run.text, lookups: run.toolCalls.length };
}
