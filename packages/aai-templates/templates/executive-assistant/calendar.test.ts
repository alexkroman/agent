/** The def a DEPLOYED agent runs: authored, plus what `tools/` declares. */
import agentDef from "virtual:aai/agent";
import { isClockTime, isIsoDate, isToolFailure, spokenDate } from "@alexkroman1/aai";
import {
  createToolContext,
  expectDialogOk,
  expectToolOk,
  parseToolInput,
  runGuardrail,
  scriptedToolContext,
  toolRunner,
} from "@alexkroman1/aai/testing";
import { describe, expect, test } from "vitest";
import { CALENDAR, TODAY } from "./inbox.ts";
import { calendarTool, clashOn, meetingAssistant, statesAvailability } from "./meeting.ts";
import { CHOOSE_MEMORY_SYSTEM, TRIAGE_SYSTEM } from "./prompts.ts";

/**
 * The calendar half: the days the meeting assistant reads, the slot an invite
 * books, and the two rules that hold them together — a civil date and a
 * zero-padded clock time, on both sides of the comparison.
 *
 * It sits beside `agent.test.ts` rather than in it because that file is at the
 * package's 700-line spec cap; the split is by SUBJECT, so everything here is
 * about time and everything there is about the gate.
 */

const run = toolRunner(agentDef);

/**
 * The scripted seams this file's tools reach: a triage on the way in, and a
 * reflection that decides nothing (`edit` runs one, and what it learned is
 * `agent.test.ts`'s subject rather than this one's).
 */
const desk = () =>
  scriptedToolContext({
    generate: {
      [TRIAGE_SYSTEM]: { object: { logic: "scripted", response: "email" } },
      [CHOOSE_MEMORY_SYSTEM]: { object: { memoryTypesToUpdate: [] } },
    },
    delegate: { "meeting-assistant": "Maya is free Wednesday 1pm-3pm." },
  });

const openM4 = async () => {
  const { ctx } = desk();
  await run("open_email", { which: "m4" }, ctx);
  return ctx;
};

const INVITE = {
  emails: ["sam.reyes@acme-partners.com"],
  title: "Lumen x Acme",
  date: "2026-03-18",
  startTime: "13:00",
  endTime: "13:30",
};

// ─── The fixture is the world, so it is held to the shape ────────────────────

describe("the calendar fixture", () => {
  test("every event is a real date and two padded clock times", () => {
    // `clashOn` compares `HH:MM` as STRINGS, which is sound only zero-padded —
    // a `9:00` here would sort before every event rather than after eight of
    // them, and the clash it hid would be a double-booked executive. The doc
    // comment on `CalendarEvent` said this; nothing checked it.
    for (const event of CALENDAR) {
      expect(isIsoDate(event.date), event.title).toBe(true);
      expect(isClockTime(event.start) && isClockTime(event.end), event.title).toBe(true);
      expect(event.start < event.end).toBe(true);
    }
    expect(isIsoDate(TODAY)).toBe(true);
  });
});

// ─── What the meeting assistant reads ────────────────────────────────────────

describe("the meeting assistant's calendar tool", () => {
  test("answers each day's events, and names the day in words", async () => {
    const days = await calendarTool.execute(
      { days: ["2026-03-17", "2026-03-21"] },
      createToolContext(),
    );
    expect(days).toMatchObject({
      timezone: "PST",
      days: [
        {
          date: "2026-03-17",
          day: "Tuesday, March 17",
          events: ["13:00-14:00 Customer call — Fable Health", "15:00-17:00 Board meeting"],
        },
        { date: "2026-03-21", day: "Saturday, March 21", events: [] },
      ],
    });
    // Fixed ASCII, not `Intl`: the `toLocaleDateString` this replaced answers
    // to the host's ICU build, so the guest could name a different weekday
    // than the author's laptop with no spec able to tell.
    expect(spokenDate(TODAY)).toBe("Monday, March 9");
  });

  test("the guardrail accepts an answer that can be offered, and refuses one that cannot", () => {
    expect(runGuardrail(meetingAssistant, "Maya is free Wednesday 1pm-3pm.")).toBe(true);
    expect(runGuardrail(meetingAssistant, "Maya is not free Tuesday afternoon.")).toBe(true);
    const complaint = runGuardrail(meetingAssistant, "I checked her calendar for next week.");
    expect(complaint).toMatch(/clock times/);
    // The same judgement, called directly — a promise is not a verdict, which
    // is the shape `runGuardrail` refuses.
    expect(statesAvailability("Wednesday works.")).not.toBe(true);
  });

  test("a report the guardrail never accepted comes back marked unusable", async () => {
    const { ctx } = scriptedToolContext({
      generate: { [TRIAGE_SYSTEM]: { object: { logic: "scripted", response: "email" } } },
      delegate: {
        "meeting-assistant": {
          text: "I looked at her calendar.",
          complaint: "Name the open slots as clock times.",
        },
      },
    });
    await run("open_email", { which: "m4" }, ctx);
    const found = expectDialogOk<{ availability: string; usable: boolean }>(
      await run("meeting_assistant", { request: "Tuesday or Wednesday" }, ctx),
    );
    // Not a `ToolFailure`: there IS an answer and the executive is on the line.
    expect(found.result.usable).toBe(false);
    expect(found.result.availability).toContain("looked at her calendar");
  });
});

// ─── What an invite may say ──────────────────────────────────────────────────

describe("send_calendar_invite", () => {
  test("the schema refuses a date that is not one and a time that is not padded", async () => {
    // Declared on the schema, so the model reads the rule as JSON Schema and a
    // bad value never reaches `execute` — where the pair of regexes this
    // replaced accepted `2026-02-30T99:99`.
    await expect(
      parseToolInput(agentDef, "send_calendar_invite", { ...INVITE, date: "2026-02-30" }),
    ).rejects.toThrow();
    await expect(
      parseToolInput(agentDef, "send_calendar_invite", { ...INVITE, startTime: "9:00" }),
    ).rejects.toThrow();
    await expect(parseToolInput(agentDef, "send_calendar_invite", INVITE)).resolves.toMatchObject({
      date: "2026-03-18",
    });
  });

  test("stages a free slot, and reads it back in words rather than in ISO", async () => {
    const ctx = await openM4();
    const staged = expectToolOk<{ proposal: { body: string } }>(
      await run("send_calendar_invite", INVITE, ctx),
    );
    // The body is what the assistant says out loud, and a TTS engine handed
    // `2026-03-18T13:00:00` spells the digits.
    expect(staged.proposal.body).toBe(
      "Wednesday, March 18, 1 PM to 1:30 PM, with sam.reyes@acme-partners.com",
    );
  });

  test("refuses a slot the calendar already holds, naming what is in it", async () => {
    const ctx = await openM4();
    // 10:00-11:30 on the 18th is the design review. "Only once meeting_assistant
    // has said the slot is free" is in the description, and a rule the model
    // can skip is not a rule.
    const refused = await run(
      "send_calendar_invite",
      { ...INVITE, startTime: "11:00", endTime: "11:30" },
      ctx,
    );
    expect(isToolFailure(refused) && refused.error).toContain("Design review");
    expect(isToolFailure(refused) && refused.error).toContain("10 AM to 11:30 AM");
    // Nothing staged, so nothing to accept: `inbox_status` is a plain read
    // whose value needs no unwrapping, and the thread is still open.
    expect(await run("inbox_status", ctx)).toMatchObject({ open: "m4", sent: [] });
  });

  test("edit changes one end of the slot, and is refused when that inverts it", async () => {
    const ctx = await openM4();
    await run("send_calendar_invite", INVITE, ctx);
    // The executive's own words, so the calendar clash is NOT re-checked —
    // they may double-book themselves. The ordering still is.
    expect(await run("edit", { startTime: "14:00" }, ctx)).toMatchObject({
      error: expect.stringContaining("ends before it starts"),
    });
    const sent = expectToolOk<{ sent: string }>(
      await run("edit", { date: "2026-03-19", startTime: "09:00", endTime: "09:30" }, ctx),
    );
    expect(sent.sent).toContain("Thursday, March 19 at 9 AM");
  });

  test("clashOn takes the ends as touching, not overlapping", () => {
    // The design review ends at 11:30; a meeting starting then is free.
    expect(clashOn("2026-03-18", "11:30", "12:00")).toBeUndefined();
    expect(clashOn("2026-03-18", "11:29", "12:00")?.title).toBe("Design review");
    // A different day is a different question.
    expect(clashOn("2026-03-21", "10:00", "11:00")).toBeUndefined();
  });
});
