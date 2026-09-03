/**
 * The def a DEPLOYED agent runs: authored, plus what `tools/` declares, plus
 * what `system-prompt.md` says.
 *
 * BOTH wrappers are load-bearing and neither is applied by `agent()` — they are
 * applied by the BUILD (`aai build` enumerates `tools/` and resolves the prompt
 * file), so an eval driving the raw default export would measure a twelve-tool
 * desk with no tools and the FRAMEWORK DEFAULT prompt. For this template that
 * is the whole subject: "location is always the first priority", the radio
 * style and "never leave a critical incident without a resource" are all in
 * that file.
 *
 * The glob is written here rather than reached for from a shared helper because
 * this file SHIPS — it is what a scaffolded project runs.
 */
import dispatchAgent from "virtual:aai/agent";
import type { SessionEvent } from "@alexkroman1/aai/protocol";
// An EVAL: does the desk actually behave? Run it with `aai eval`.
//
// `agent.test.ts` drives each tool directly. What it cannot ask is whether the
// AGENT — a model, reading this system prompt, holding these twelve tools —
// works the call in the right ORDER, which for a dispatch desk is the whole
// product. Four claims, each one a MECHANISM this template is built out of:
//
//   1. nothing can be dispatched before a call has been logged,
//   2. a 911 call is logged, scored, and the flow moves to triaging,
//   3. units really roll, and the position follows them to monitoring,
//   4. a unit already on a call is not sent to a second one.
//
// So every assertion reads the mechanism's own output — the dialog gate's
// refusal, the tool result, and the dashboard the browser is sent — rather
// than judging the sentence the model chose to say.
//
// What no eval here can see: anything below the audio boundary. Whether a
// dispatcher reading a callsign in bursts lands as one turn is a property of
// endpointing, and these fake speech stages remove it.
import {
  type EvalSession,
  lastStateIn,
  toolNames,
  turnCalling,
} from "@alexkroman1/aai-runtime/eval";
import { describeEval } from "@alexkroman1/aai-runtime/eval/vitest";
import { expect } from "vitest";
import { z } from "zod";

/** The six tools gated on `working` — the ones that refuse until something has
 *  been logged. Listed here so ADDING an ungated mutating tool is a deliberate
 *  edit to this file rather than a silent gap. */
const GATED_TOOLS = new Set([
  "incident_triage",
  "incident_add_note",
  "incident_escalate",
  "incident_update_status",
  "resources_dispatch",
  "resources_update_status",
]);

/** The first incident of a session. `createIncident` counts from 1 per slot,
 *  and a slot is per session, so this id is deterministic. */
const FIRST_INCIDENT = "INC-0001";
/** The second, for the case that logs two. */
const SECOND_INCIDENT = "INC-0002";

/**
 * What the BROWSER is sent, as this eval reads it.
 *
 * Parsed rather than cast: `state.updated` carries `unknown`, and a schema that
 * stops matching is a loud failure naming the field where a cast would hand the
 * assertions `undefined` and fail three lines later. It names only the fields
 * asserted below, so `dashboardView` may grow without touching this.
 */
const ProjectedDashboard = z.object({
  systemAlertLevel: z.string(),
  incidents: z.array(
    z.object({
      id: z.string(),
      severity: z.string(),
      status: z.string(),
      location: z.string(),
    }),
  ),
});

/**
 * The latest dashboard the session pushed, or undefined if it pushed none.
 *
 * `lastStateIn` is the SDK's reader, and the schema is what it is worth passing:
 * a frame that stopped matching FAILS naming the field, where the cast this
 * replaced would have handed the assertions `undefined`.
 */
const dashboard = (events: readonly SessionEvent[]) => lastStateIn(events, ProjectedDashboard);

/** One incident as the browser sees it. */
const boardEntry = (events: readonly SessionEvent[], id: string) =>
  dashboard(events)?.incidents.find((i) => i.id === id);

/**
 * The dialog gate's own refusal sentence, for the state it names.
 *
 * The character class absorbs the JSON escaping: a tool result reaches the
 * event stream as a serialized string, so the state name arrives inside
 * `\\"standby\\"` rather than plain quotes.
 */
const refusalAt = (state: string) =>
  new RegExp(`Not available yet: this conversation is at [\\\\"]*${state}`);

/** Every call to `tool` across the whole shift. */
const callsTo = (session: EvalSession, tool: string) =>
  session.toolCalls().filter((c) => c.name === tool);

/** The 911 call all four cases open with — "cardiac arrest" is what
 *  `recommendSeverity` reads as critical and `recommendType` as medical. */
const THE_CALL =
  "Take this call: 400 Oak Street, cardiac arrest, CPR in progress. " +
  "Caller is Jane Doe, callback five five five, zero one zero one.";

/** The scripted turn that logs it. */
const LOG_TURN = [
  {
    tool: "incident_create",
    args: {
      location: "400 Oak Street",
      description: "Cardiac arrest, CPR in progress",
      callerName: "Jane Doe",
      callerPhone: "555-0101",
    },
  },
  "Copy — logged as a priority one. Confirming severity and getting units rolling.",
] as const;

describeEval(dispatchAgent, (test) => {
  test(
    "refuses a unit's radio call while nothing is logged on the shift",
    async ({ session }) => {
      // A unit radioing in is not an emergency, so it gives the desk nothing to
      // log — which is what makes the gate the only thing that can answer.
      // Measured live: a DISPATCH order does not, because a competent model logs
      // the call first and then legitimately reaches the gated tools from
      // `working`, and a case that read that as a gate failure would be wrong.
      const turn = await session.say("Medic-1 just radioed in — mark them available.");

      // Every gated call the model made while the shift was still in standby
      // has to have been refused, and the refusal has to say where the shift
      // actually is. The `incident_create` guard is the lesson above, kept:
      // anything issued AFTER a call was logged is in `working` and legal.
      const logged = turn.toolCalls.findIndex((c) => c.name === "incident_create");
      for (const [index, call] of turn.toolCalls.entries()) {
        if (!GATED_TOOLS.has(call.name)) continue;
        if (logged !== -1 && index > logged) continue;
        expect(call.result).toMatch(refusalAt("standby"));
      }
      // Nothing was logged, so the board the browser holds is still empty.
      expect(dashboard(session.events())?.incidents ?? []).toEqual([]);
      // And it said so rather than pretending the unit had been updated.
      expect(turn.text).toMatch(/nothing|no incident|not logged|standby|call|log/i);
    },
    {
      stubReply: [
        { tool: "resources_update_status", args: { callsign: "Medic-1", status: "available" } },
        "Nothing is logged on this shift yet — give me a call and I'll open it.",
      ],
    },
  );

  test(
    "logs a 911 call, scores it, and moves the shift to triaging",
    async ({ session }) => {
      const turn = await session.say(THE_CALL);

      const logged = turn.toolCalls.find((c) => c.name === "incident_create");
      expect(logged?.args.location).toMatch(/oak/i);
      // The recommendation is the desk's own scoring, not the model's opinion:
      // `recommendSeverity` reads "cardiac arrest" and `recommendType` reads
      // "cardiac". A model that paraphrased the emergency away would show up
      // here rather than in a sentence nobody checks.
      expect(logged?.result).toMatch(/"recommendedSeverity":"critical"/);
      expect(logged?.result).toMatch(/"recommendedType":"medical"/);
      // `incident_create` is ungated and SPREADS the position it landed in, so
      // the model reads "confirm the severity and type" as part of this result.
      expect(logged?.result).toMatch(/"state":"working\.triaging"/);
      // And the board the browser holds has it, at the severity the desk chose.
      expect(boardEntry(session.events(), FIRST_INCIDENT)).toMatchObject({
        severity: "critical",
        location: "400 Oak Street",
      });
    },
    { stubReply: [...LOG_TURN] },
  );

  test(
    "rolls units on a logged incident and follows them to monitoring",
    async ({ session }) => {
      const turns = await session.sayAll([THE_CALL, "Dispatch the recommended units now."]);

      // The turn the dispatch fired in, whichever one that turned out to be:
      // how many turns a desk spends getting there is the model's business, so
      // a case pinned to turn two is a flake with a misleading name. A shift
      // that never dispatched at all fails HERE, with every turn's tool list in
      // the message, rather than as an `undefined` three assertions later.
      const dispatching = turnCalling(turns, "resources_dispatch");
      const rolled = dispatching.toolCalls.find((c) => c.name === "resources_dispatch");
      // Units really assigned — `dispatched` is empty when every requested
      // callsign was busy, which is the case the fourth test owns.
      expect(rolled?.result).toMatch(/"dispatched":\[\{/);
      // `sendFrom` only fires when something rolled, so this is the position
      // moving BECAUSE of the dispatch rather than alongside it.
      expect(rolled?.result).toMatch(/"state":"working\.monitoring"/);
      // The board agrees: the incident is dispatched, not merely triaged.
      expect(boardEntry(session.events(), FIRST_INCIDENT)?.status).toBe("dispatched");
      // And the order is the one the desk's flow requires: log, then dispatch.
      const names = toolNames(session.toolCalls());
      expect(names.indexOf("resources_dispatch")).toBeGreaterThan(names.indexOf("incident_create"));
    },
    {
      stubReply: [
        ...LOG_TURN,
        { tool: "resources_dispatch", args: { incidentId: FIRST_INCIDENT, autoDispatch: true } },
        "Medic-1 is rolling priority one, ETA under five.",
      ],
    },
  );

  test(
    "closing an incident releases the units that were on it",
    async ({ session }) => {
      await session.sayAll([
        THE_CALL,
        "Dispatch the recommended units, emergency priority.",
        "Units report the patient is transported and they're clear. Close it out.",
      ]);

      const closed = callsTo(session, "incident_update_status").filter(
        (c) => c.args.status === "resolved",
      );
      expect(closed).toHaveLength(1);
      // The release is the DESK's, not the model's: `resolved` is the one status
      // that detaches every unit still assigned to this incident and says so on
      // the incident's own timeline. A model cannot route around it, which is
      // what makes this the claim worth asserting live. (The BUSY-unit refusal
      // an earlier draft tried to assert here is the case below: a competent
      // dispatcher checks availability first and never triggers it, so it is
      // `{ scripted: true }` rather than weakened into this one.)
      expect(closed[0]?.result).toMatch(/"newStatus":"resolved"/);
      expect(closed[0]?.result).toMatch(/All resources released/);
      // The board agrees, which is the half a browser would show.
      expect(boardEntry(session.events(), FIRST_INCIDENT)?.status).toBe("resolved");
      // And the shift ran in the order the flow requires.
      const names = toolNames(session.toolCalls());
      expect(names.indexOf("incident_create")).toBeGreaterThanOrEqual(0);
      expect(names.indexOf("resources_dispatch")).toBeGreaterThan(names.indexOf("incident_create"));
      expect(names.lastIndexOf("incident_update_status")).toBeGreaterThan(
        names.indexOf("resources_dispatch"),
      );
    },
    {
      stubReply: [
        ...LOG_TURN,
        {
          tool: "resources_dispatch",
          args: { incidentId: FIRST_INCIDENT, autoDispatch: true, priority: "emergency" },
        },
        "Medic-1 rolling priority one to 400 Oak Street.",
        {
          tool: "incident_update_status",
          args: { incidentId: FIRST_INCIDENT, status: "resolved", notes: "Patient transported" },
        },
        "Copy — Oak Street is closed and the units are clear.",
      ],
    },
  );

  test(
    "a unit already rolling is not sent to a second call",
    async ({ session }) => {
      await session.sayAll([
        THE_CALL,
        "Send Medic-1 to Oak Street.",
        "New call: 12 Pine Lane, chest pains. Log it.",
        "Send Medic-1 to Pine Lane as well.",
      ]);

      const dispatches = callsTo(session, "resources_dispatch");
      // The second request is the subject, so both have to have gone out.
      expect(dispatches).toHaveLength(2);
      const [first, second] = dispatches;
      // Medic-1 really rolled the first time — otherwise the refusal below is
      // about a unit that was never busy.
      expect(first?.result).toMatch(/"callsign":"Medic-1"/);
      expect(first?.result).toMatch(/"state":"working\.monitoring"/);
      // And the second time the desk REFUSED rather than double-booking it:
      // `failed` carries the reason and `dispatched` is empty. The unit is
      // committed to ONE incident, which is the property a dispatch desk is
      // useless without and which no prompt can carry.
      expect(second?.result).toMatch(/"dispatched":\[\]/);
      expect(second?.result).toMatch(/"callsign":"Medic-1","reason":"Currently dispatched"/);
      // `sendFrom` only fires when something rolled, so the call did NOT
      // advance: logging Pine Lane put it back at `triaging`, and a dispatch
      // that dispatched nothing leaves it there.
      expect(second?.result).toMatch(/"state":"working\.triaging"/);
      // The board agrees on both halves — the second incident never reached
      // `dispatched`, and the first one still holds the unit.
      expect(boardEntry(session.events(), SECOND_INCIDENT)?.status).not.toBe("dispatched");
      expect(boardEntry(session.events(), FIRST_INCIDENT)?.status).toBe("dispatched");
    },
    // Scripted only. `resources_get_available` is in this desk's tool list and
    // the prompt tells it to check capacity, so a live model looks first and
    // never asks for a busy unit — which is the right behaviour and leaves the
    // refusal unobserved. Forcing the call is the only way to see the guard
    // itself, and a case that "accepts either" would assert nothing live.
    {
      scripted: true,
      stubReply: [
        ...LOG_TURN,
        {
          tool: "resources_dispatch",
          args: { incidentId: FIRST_INCIDENT, callsigns: ["Medic-1"], priority: "emergency" },
        },
        "Medic-1 is rolling to 400 Oak Street.",
        {
          tool: "incident_create",
          args: { location: "12 Pine Lane", description: "Chest pains" },
        },
        "Logged as a second incident.",
        {
          tool: "resources_dispatch",
          args: { incidentId: SECOND_INCIDENT, callsigns: ["Medic-1"], priority: "priority" },
        },
        "Medic-1 is already committed to Oak Street — I'll find you another unit.",
      ],
    },
  );
});
