import { isClockTime, spokenDate, spokenTime, workflow } from "@alexkroman1/aai";
import { z } from "zod";
import { remindFlow } from "./workflows/remind.ts";
import { researchWorkflow } from "./workflows/research.ts";

// The workflows' declarations, in a module both agent.ts and the tools import:
// ctx.workflows.start(remind, …) takes the definition, and a tool cannot import agent.ts
// (the bundle is agent.ts plus every tools/ file, so that import closes a cycle).

export const remind = workflow({
  description: "Say a reminder on the speaker when it is due",
  input: z.object({
    clientId: z.string().describe("The speaker to say it on (its ?client= id)"),
    text: z.string().describe("What to remind them of"),
    dueAt: z.number().describe("When, as epoch milliseconds"),
  }),
  run: remindFlow,
});

/** deepResearchWorkflow's definition, declared with its input and failure handling. */
export const research = researchWorkflow;

/** Longest a reminder may wait: the run parks that long, and past a week it is a calendar. */
export const MAX_REMINDER_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The home's time zone: `TIME_ZONE` (an IANA name such as "America/Chicago") when it is
 * set and valid, else this machine's. A self-hosted speaker's machine is in the home, so
 * its clock is the right one; a deployed agent's is not, which is what the variable is for.
 */
export function homeTimeZone(env: Readonly<Record<string, string | undefined>>): string {
  const zone = env.TIME_ZONE?.trim();
  if (zone) {
    try {
      return new Intl.DateTimeFormat("en-US", { timeZone: zone }).resolvedOptions().timeZone;
    } catch {
      // Not a zone Intl knows: the machine's, rather than every reminder refused.
    }
  }
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/**
 * The wall clock in `zone` at `instant`, as a Date whose UTC fields READ that clock, so
 * the arithmetic below is plain UTC arithmetic whatever zone the process runs in.
 */
function wallClock(instant: number, zone: string): Date {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value ?? 0);
  return new Date(
    Date.UTC(
      part("year"),
      part("month") - 1,
      part("day"),
      part("hour"),
      part("minute"),
      part("second"),
    ),
  );
}

/** How far `zone`'s clock is ahead of UTC at `instant`. */
const offsetAt = (instant: number, zone: string) =>
  wallClock(instant, zone).getTime() - Math.floor(instant / 1000) * 1000;

/**
 * When a reminder is due: `inSeconds` from now, or the next `at` ("17:30", 24-hour,
 * zero-padded: the tool's `clockTime` field) on the home's clock. The model does not know
 * the time, so it passes what they SAID and this does the arithmetic. Undefined when
 * neither (or an `at` isClockTime refuses, like "9:30" or "24:00") was given.
 */
export function reminderDueAt(
  now: Date,
  when: { inSeconds?: number | undefined; at?: string | undefined },
  zone: string,
): number | undefined {
  if (when.inSeconds !== undefined) return now.getTime() + when.inSeconds * 1000;
  if (when.at === undefined || !isClockTime(when.at)) return undefined;
  const [h, m] = when.at.split(":").map(Number);
  const wall = wallClock(now.getTime(), zone);
  const due = new Date(wall);
  due.setUTCHours(h ?? 0, m ?? 0, 0, 0);
  if (due.getTime() <= wall.getTime()) due.setUTCDate(due.getUTCDate() + 1);
  // Back to an instant at the offset in force THEN, so "9 AM" across a daylight-saving
  // change is still nine on the clock: first at today's offset, then corrected by the
  // offset at that guess.
  const guess = due.getTime() - offsetAt(now.getTime(), zone);
  return due.getTime() - offsetAt(guess, zone);
}

const pad = (n: number) => String(n).padStart(2, "0");
/** A wall clock's "HH:MM" and "YYYY-MM-DD", as the SDK's spoken formatters take them. */
const clockOf = (d: Date) => `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
const dayOf = (d: Date) =>
  `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

/**
 * "5:30 PM", "tomorrow at 7 AM", "Wednesday at 7 AM" — what the agent says back, on the
 * home's clock. The SDK's spokenTime drops ":00" on the hour, which a TTS engine would read
 * as "zero zero". The weekday alone names a day this week; a week out (the MAX_REMINDER_MS
 * edge) is today's weekday again, so that one gets spokenDate's month and day too:
 * "Monday, October 5 at 2 PM".
 */
export function spokenDue(now: Date, dueAt: number, zone: string): string {
  const wallNow = wallClock(now.getTime(), zone);
  const due = wallClock(dueAt, zone);
  const time = spokenTime(clockOf(due));
  const day = dayOf(due);
  if (day === dayOf(wallNow)) return time;
  const tomorrow = new Date(wallNow);
  tomorrow.setUTCDate(wallNow.getUTCDate() + 1);
  if (day === dayOf(tomorrow)) return `tomorrow at ${time}`;
  // spokenDate is "Monday, June 8": its weekday is everything before the comma.
  const date = spokenDate(day);
  const aWeekOut = new Date(wallNow);
  aWeekOut.setUTCDate(wallNow.getUTCDate() + 7);
  // YYYY-MM-DD compares as a string, and by DAY: next Monday at 9 is under seven days from
  // Monday at 2 but is still a Monday.
  return `${day < dayOf(aWeekOut) ? date.split(",")[0] : date} at ${time}`;
}
