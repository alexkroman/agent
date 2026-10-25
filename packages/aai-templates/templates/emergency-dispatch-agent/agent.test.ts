import dispatchAgent from "virtual:aai/agent";
import type {
  DialogPosition,
  DialogStateSpec,
  InferToolInput,
  ToolContext,
} from "@alexkroman1/aai";
import { createSeededRandom, isToolFailure } from "@alexkroman1/aai";
import {
  createToolContext,
  expectDialogRefused,
  expectPromptBuiltinsDeclared,
  expectSlotContract,
  expectToolOk,
  fireEvent,
  parseSchemaInput,
  schemaInputIssues,
  sessionEvent,
} from "@alexkroman1/aai-runtime/testing";
import { describeAgent } from "@alexkroman1/aai-runtime/testing/vitest";
import { describe, expect, test } from "vitest";
import { claimsUnitsMoving } from "./guardrails.ts";
import { callFlow, callSpec, dispatchSlot } from "./shared.ts";
import incidentAddNote from "./tools/incident_add_note.ts";
import incidentCreate from "./tools/incident_create.ts";
import incidentEscalate from "./tools/incident_escalate.ts";
import incidentTriage from "./tools/incident_triage.ts";
import incidentUpdateStatus from "./tools/incident_update_status.ts";
import opsRunScenario, { SCENARIO_NAMES } from "./tools/ops_run_scenario.ts";
import resourcesDispatch from "./tools/resources_dispatch.ts";
import resourcesUpdateStatus from "./tools/resources_update_status.ts";

/** Where the call is, without going through a tool. */
const at = (ctx: ToolContext): DialogPosition => callFlow.position(ctx);

describeAgent(dispatchAgent, (run) => {
  async function createIncidentFor(
    ctx: ToolContext,
    description = "structure fire with heavy smoke",
  ): Promise<string> {
    const created = expectToolOk(
      await run(incidentCreate, { location: "400 Oak Street", description }, ctx),
    );
    return created.incidentId;
  }

  test("the board keeps its contract", () => {
    expectSlotContract(dispatchSlot, {
      write: (state) => {
        state.incidentCounter = 1;
      },
    });
  });

  describe("emergency-dispatch-agent template", () => {
    test("resolving an incident does not yank a reassigned unit off its new incident", async () => {
      const ctx = createToolContext();

      const inc1 = await createIncidentFor(ctx);
      await run(resourcesDispatch, { incidentId: inc1, callsigns: ["Medic-1"] }, ctx);

      // Medic-1 radios available, then is dispatched to a second incident.
      await run(resourcesUpdateStatus, { callsign: "Medic-1", status: "available" }, ctx);
      const inc2 = await createIncidentFor(ctx, "cardiac arrest, not breathing");
      await run(resourcesDispatch, { incidentId: inc2, callsigns: ["Medic-1"] }, ctx);

      // Resolving the first incident must not touch Medic-1 anymore.
      await run(incidentUpdateStatus, { incidentId: inc1, status: "resolved" }, ctx);

      const state = dispatchSlot.get(ctx);
      const medic1 = state.resources.find((r) => r.callsign === "Medic-1");
      expect(medic1?.status).toBe("dispatched");
      expect(medic1?.assignedIncident).toBe(inc2);
      expect(state.incidents[inc2]?.assignedResources).toContain("R1");
      expect(state.incidents[inc1]?.assignedResources).not.toContain("R1");
    });

    test("callsigns: ['auto'] triggers auto-dispatch as the description promises", async () => {
      const ctx = createToolContext();
      const incidentId = await createIncidentFor(ctx, "cardiac arrest, patient not breathing");

      const result = expectToolOk(
        await run(resourcesDispatch, { incidentId, callsigns: ["auto"] }, ctx),
      );

      expect(result.failed).toBeUndefined();
      expect(result.dispatched.length).toBeGreaterThan(0);
    });

    test("concurrent tool calls are serialized — no lost updates", async () => {
      const ctx = createToolContext();

      // Parallel tool calls in one LLM turn run concurrently. The per-session
      // mutex in updateState makes each one run against the previous one's
      // finished state, so neither incident's changes are half-applied when
      // the other's mutator runs.
      const [a, b] = await Promise.all([
        run(incidentCreate, { location: "1 First St", description: "gas leak" }, ctx),
        run(incidentCreate, { location: "2 Second St", description: "vehicle crash" }, ctx),
      ]);

      const state = dispatchSlot.get(ctx);
      expect(expectToolOk(a).incidentId).not.toBe(expectToolOk(b).incidentId);
      expect(state.incidentCounter).toBe(2);
      expect(Object.keys(state.incidents)).toHaveLength(2);
    });

    test("negative casualty counts are rejected by the parameter schemas", async () => {
      // `schemaInputIssues` rather than `inputSchema?.safeParse(...).success`:
      // the optional chain made "there is no schema at all" pass this test as
      // `undefined !== true`, and the helper throws naming the tool instead.
      expect(
        await schemaInputIssues(
          incidentTriage.inputSchema,
          { incidentId: "INC-0001", casualtyUpdate: -5 },
          "incident_triage",
        ),
      ).toBeDefined();
      expect(
        await schemaInputIssues(
          incidentCreate.inputSchema,
          { location: "1 First St", description: "fire", estimatedCasualties: -1 },
          "incident_create",
        ),
      ).toBeDefined();
      expect(
        await schemaInputIssues(
          incidentUpdateStatus.inputSchema,
          { incidentId: "INC-0001", status: "on_scene", casualtyUpdate: { confirmed: -2 } },
          "incident_update_status",
        ),
      ).toBeDefined();
    });

    test("every scenario the drill table declares is one the tool will accept", async () => {
      // `ops_run_scenario` derives its enum from `scenarios`' own keys so that
      // adding a drill is one edit. That derivation is the claim: a scenario
      // reachable in the table and refused by the schema would be a drill nobody
      // could run, and `Object.keys` is exactly the cast that hides it.
      for (const scenario of SCENARIO_NAMES) {
        const parsed = await parseSchemaInput<InferToolInput<typeof opsRunScenario>>(
          opsRunScenario.inputSchema,
          { scenario },
          "ops_run_scenario",
        );
        expect(parsed.scenario).toBe(scenario);
      }
      expect(
        await schemaInputIssues(
          opsRunScenario.inputSchema,
          { scenario: "meteor_strike" },
          "ops_run_scenario",
        ),
      ).toBeDefined();
    });

    test("dispatch priority sets the ETA band, and the jitter comes from ctx.random", async () => {
      // `resources_dispatch` draws its ETA jitter through `ctx.random` rather
      // than `Math.random`, which is what makes a shift reproducible at all.
      // Seeding two contexts identically is that claim: the same units are
      // offered the same draws, so the ONLY difference between the two runs is
      // the priority's base — 10 minutes routine against 3 emergency.
      const etasFor = async (priority: "routine" | "emergency"): Promise<number[]> => {
        const ctx = createToolContext({ random: createSeededRandom(1607) });
        const incidentId = await createIncidentFor(ctx);
        const rolled = expectToolOk(
          await run(resourcesDispatch, { incidentId, autoDispatch: true, priority }, ctx),
        );
        return rolled.dispatched.map((r) => r.eta);
      };

      const routine = await etasFor("routine");
      const emergency = await etasFor("emergency");
      expect(emergency.length).toBeGreaterThan(0);
      expect(routine).toEqual(emergency.map((eta) => eta + 7));
      // `randomInt(5, …)` is 0-4, so an emergency roll is always a 3-7 minute ETA.
      for (const eta of emergency) {
        expect(eta).toBeGreaterThanOrEqual(3);
        expect(eta).toBeLessThanOrEqual(7);
      }
    });

    test("mutual-aid units get unique ids and callsigns across escalations", async () => {
      const ctx = createToolContext();
      const incidentId = await createIncidentFor(ctx);

      await run(incidentEscalate, { incidentId, reason: "spreading", requestMutualAid: true }, ctx);
      await run(
        incidentEscalate,
        { incidentId, reason: "still spreading", requestMutualAid: true },
        ctx,
      );

      const state = dispatchSlot.get(ctx);
      const mutualAid = state.resources.filter((r) => r.id.startsWith("MA-"));
      expect(mutualAid).toHaveLength(4);
      expect(new Set(mutualAid.map((r) => r.id)).size).toBe(4);
      expect(new Set(mutualAid.map((r) => r.callsign)).size).toBe(4);
    });

    test("resolved is terminal: no escalation, re-resolution, or dispatch", async () => {
      const ctx = createToolContext();
      const incidentId = await createIncidentFor(ctx);
      await run(incidentUpdateStatus, { incidentId, status: "resolved" }, ctx);

      // Each is a refusal the BODY answered, so it arrives unwrapped as a
      // `ToolFailure` rather than under the position envelope — which is what the
      // narrowing says, where the old cast to `{ error?: string }` said nothing
      // and would have read `undefined` off a success just as quietly.
      const escalated = await run(incidentEscalate, { incidentId, reason: "flare-up" }, ctx);
      expect(isToolFailure(escalated) && escalated.error).toMatch(/resolved/);

      const reResolved = await run(incidentUpdateStatus, { incidentId, status: "resolved" }, ctx);
      expect(isToolFailure(reResolved) && reResolved.error).toMatch(/resolved/);

      const dispatchedTo = await run(
        resourcesDispatch,
        { incidentId, callsigns: ["Medic-1"] },
        ctx,
      );
      expect(isToolFailure(dispatchedTo) && dispatchedTo.error).toMatch(/resolved/);
    });
  });

  describe("the call flow", () => {
    test("a fresh shift is in standby, and every incident tool refuses there", async () => {
      const ctx = createToolContext();
      expect(at(ctx).state).toBe("standby");

      // Each of these used to run and answer `Incident INC-0001 not found` — a
      // data answer to a positional question. The refusal now names where the
      // shift is and quotes what to do about it.
      //
      // `expectDialogRefused(…, "standby")` is both halves of that in one call,
      // and it is the assertion the hand-rolled shape could not make: an
      // `isToolFailure` guard plus a `toMatch(/standby/)` on the same line let a
      // SUCCESS through as `false && …`, and the pattern comes from the SDK, so
      // rewording the sentence the model reads cannot silently break this.
      for (const call of [
        run(incidentTriage, { incidentId: "INC-0001" }, ctx),
        run(resourcesDispatch, { incidentId: "INC-0001", callsigns: ["Medic-1"] }, ctx),
        run(incidentUpdateStatus, { incidentId: "INC-0001", status: "on_scene" }, ctx),
        run(incidentEscalate, { incidentId: "INC-0001", reason: "spreading" }, ctx),
        run(incidentAddNote, { incidentId: "INC-0001", note: "caller hung up" }, ctx),
        run(resourcesUpdateStatus, { callsign: "Medic-1", status: "en_route" }, ctx),
      ]) {
        const refusal = expectDialogRefused(await call, "standby");
        // And it quotes the state's own instruction, which is what the model
        // recovers from — a refusal naming only the state gives it nothing to do.
        expect(refusal.error).toMatch(/incident_create/);
      }

      // And nothing ran: a refusal must not have touched the board.
      expect(dispatchSlot.get(ctx).incidentCounter).toBe(0);
    });

    test("logging, triaging and dispatching walk the call through its three steps", async () => {
      const ctx = createToolContext();

      const created = await run(
        incidentCreate,
        { location: "400 Oak Street", description: "structure fire with heavy smoke" },
        ctx,
      );
      // Ungated, and still answering the position it landed in — the model reads
      // "confirm the severity and type" as part of this result.
      if (isToolFailure(created)) throw new Error(created.error);
      expect(created.state).toBe("working.triaging");
      expect(created.instruction).toMatch(/incident_triage/);
      const { incidentId } = created.result;

      const triaged = expectToolOk(
        await run(incidentTriage, { incidentId, severity: "critical" }, ctx),
      );
      expect(triaged.triageScore).toBeGreaterThan(0);
      expect(at(ctx).state).toBe("working.dispatching");

      // The position the MODEL was handed, not only the slot's: an envelope
      // reporting somewhere else entirely would pass `at(ctx)` alone.
      const rolled = await run(resourcesDispatch, { incidentId, autoDispatch: true }, ctx);
      if (isToolFailure(rolled)) throw new Error(rolled.error);
      expect(rolled.state).toBe("working.monitoring");
      expect(rolled.instruction).toMatch(/radio in/);
      expect(at(ctx).state).toBe("working.monitoring");
    });

    test("a dispatch that rolled nothing leaves the call where it was", async () => {
      const ctx = createToolContext();
      const incidentId = await createIncidentFor(ctx);
      await run(incidentTriage, { incidentId }, ctx);
      expect(at(ctx).state).toBe("working.dispatching");

      // Every requested callsign is unknown, so no unit moved — and the call has
      // not moved on either, which the result itself reports.
      const result = await run(resourcesDispatch, { incidentId, callsigns: ["Ghost-1"] }, ctx);
      if (isToolFailure(result)) throw new Error(result.error);
      expect(result.result.dispatched).toHaveLength(0);
      expect(result.state).toBe("working.dispatching");
    });

    test("a new call is legal mid-incident and puts the flow back on triage", async () => {
      const ctx = createToolContext();
      const first = await createIncidentFor(ctx);
      await run(incidentTriage, { incidentId: first }, ctx);
      await run(resourcesDispatch, { incidentId: first, autoDispatch: true }, ctx);
      expect(at(ctx).state).toBe("working.monitoring");

      await createIncidentFor(ctx, "chemical spill spreading toward a storm drain");
      expect(at(ctx).state).toBe("working.triaging");

      // The first incident is still workable — the position tracks the call in
      // hand, and the tools are addressed by id.
      expectToolOk(await run(incidentAddNote, { incidentId: first, note: "crews on scene" }, ctx));
    });

    test("a failed tool does not advance the flow", async () => {
      const ctx = createToolContext();
      const incidentId = await createIncidentFor(ctx);
      await run(incidentUpdateStatus, { incidentId, status: "resolved" }, ctx);
      const before = at(ctx).state;

      const refused = await run(incidentTriage, { incidentId, severity: "critical" }, ctx);
      expect(isToolFailure(refused)).toBe(true);
      expect(at(ctx).state).toBe(before);
    });

    test("a training scenario logs incidents like a real call does", async () => {
      const ctx = createToolContext();
      const result = await run(opsRunScenario, { scenario: "mass_casualty" }, ctx);
      if (isToolFailure(result)) throw new Error(result.error);
      expect(result.result.incidentsCreated.length).toBeGreaterThan(1);
      expect(result.state).toBe("working.triaging");
    });
  });

  describe("the agent declaration", () => {
    test("the flow is DECLARED, which is what puts its instruction on every turn", () => {
      // The gate holds without this line and every test above would go on
      // passing — what it buys is the half no tool call can reach: the active
      // state's `instruction` appended to the system prompt on turns that call
      // nothing, which is most of a dispatcher's turns. Nothing else here can
      // see the day it comes off the def.
      expect(dispatchAgent.dialogs).toContain(callFlow);
    });

    test("the builtins the prompt commands are enabled", () => {
      // `system-prompt.md` tells the model to use `web_search` and `run_code`,
      // and the default builtin set has neither, so the claim fails here rather
      // than mid-call.
      expect(expectPromptBuiltinsDeclared(dispatchAgent)).toEqual(
        expect.arrayContaining(["web_search", "run_code"]),
      );
    });

    test("every state a dispatcher can be IN carries an instruction", () => {
      // A state's `instruction` is what a refusal quotes and what rides every
      // turn, so a state without one refuses with no recovery text and says
      // nothing on the turns in between — the failure the typed field replaced an
      // untyped `meta` bag to prevent, and one that is invisible until a live
      // call reaches that state. Parents are exempt BY the same rule: nobody is
      // ever at `working`, only at one of its children.
      //
      // The walk is typed with `DialogStateSpec` rather than read off the `as
      // const` literal: the annotation is what makes the recursion legal, and it
      // is what says `instruction` is a field the SDK really accepts — a spec
      // reading a key the type dropped would fail here instead of auditing
      // nothing.
      const walk = (
        map: Readonly<Record<string, DialogStateSpec>>,
        prefix = "",
      ): [string, DialogStateSpec][] =>
        Object.entries(map).flatMap(([name, spec]) => {
          const path = prefix === "" ? name : `${prefix}.${name}`;
          return [[path, spec] as [string, DialogStateSpec], ...walk(spec.states ?? {}, path)];
        });

      const leaves = walk(callSpec.states).filter(([, spec]) => spec.states === undefined);
      // Named rather than counted, so a walk that found nothing cannot pass the
      // claim below by having audited nothing.
      expect(leaves.map(([path]) => path)).toEqual([
        "standby",
        "working.triaging",
        "working.dispatching",
        "working.monitoring",
      ]);
      expect(
        leaves.filter(([, spec]) => spec.instruction === undefined).map(([path]) => path),
      ).toEqual([]);
    });
  });

  describe("a dropped 911 call", () => {
    /** The hang-up, delivered the way the runtime delivers it. */
    const hangUpOn = (ctx: ToolContext, at = 0) =>
      fireEvent(dispatchAgent, sessionEvent("session.timedOut", {}, { at }), ctx);

    test("is written on the incident in hand, and moves the shift nowhere", async () => {
      const ctx = createToolContext();
      const incidentId = await createIncidentFor(ctx);
      await run(incidentTriage, { incidentId }, ctx);
      const before = at(ctx).state;

      await hangUpOn(ctx);

      const timeline = dispatchSlot.get(ctx).incidents[incidentId]?.timeline ?? [];
      expect(timeline.at(-1)?.event).toMatch(/CALLER LOST/);
      // The caller is gone; the shift is not. A phone desk carries this event
      // into a terminal state — here the units are still rolling and the
      // dispatcher goes on working the board.
      expect(at(ctx).state).toBe(before);
    });

    test("lands on the incident LAST TOUCHED, not the newest one", async () => {
      // The clock is pinned through `ctx.now()` because three calls in a row
      // would land in one millisecond and the tie-break, not the rule, would
      // decide the assertion. A shift's calls are minutes apart.
      let clock = Date.UTC(2026, 0, 1, 8, 0);
      const ctx = createToolContext({ now: () => clock });
      const first = await createIncidentFor(ctx);
      clock += 60_000;
      const second = await createIncidentFor(ctx, "chemical spill near a storm drain");
      // The dispatcher goes BACK to the first call, which is what "in hand"
      // means — `updatedAt` is the only fact that carries it.
      clock += 60_000;
      await run(incidentAddNote, { incidentId: first, note: "caller is with the patient" }, ctx);

      await hangUpOn(ctx, clock + 60_000);

      const board = dispatchSlot.get(ctx).incidents;
      expect(board[first]?.timeline.at(-1)?.event).toMatch(/CALLER LOST/);
      expect(board[second]?.timeline.at(-1)?.event).not.toMatch(/CALLER LOST/);
    });

    test("writes nothing when the shift has nothing open", async () => {
      const ctx = createToolContext();

      // Not a crash and not an invented incident: a call that dropped before
      // `incident_create` left no record to annotate.
      await hangUpOn(ctx);

      expect(dispatchSlot.get(ctx).incidentCounter).toBe(0);
      expect(Object.keys(dispatchSlot.get(ctx).incidents)).toEqual([]);
    });
  });

  describe("the desk's own output guardrail", () => {
    /**
     * The guardrail as the runtime runs it: the list off the DEF, not off the
     * resolved config.
     *
     * `outputGuardrails` is host-only — `toAgentConfig` strips it with `tools`,
     * `events` and `dialogs`, because a function cannot cross the wire — so
     * `expectDeployable` has nothing to say about it and the check that it is
     * wired at all has to be this one. Looked up and CHECKED rather than reached
     * through `?.[0]`, for the reason `hangUpOn` is: a def that lost the field
     * would leave every assertion below passing against nothing.
     */
    function say(ctx: ToolContext, text: string): true | string {
      const [guardrail, ...rest] = dispatchAgent.outputGuardrails ?? [];
      if (guardrail === undefined) throw new Error("the def declares no outputGuardrails");
      // One rule, deliberately: a second one would be judged here and asserted
      // nowhere. Adding one is a real edit and should say so by failing.
      if (rest.length > 0) throw new Error(`the def declares ${rest.length + 1} outputGuardrails`);
      const verdict = guardrail(text, ctx);
      // Synchronous by construction here — it reads the board and a regex. An
      // awaited promise would make the assertions below pass on `{}`.
      if (typeof verdict === "object") throw new Error("this guardrail must not be async");
      return verdict;
    }

    test("blocks 'units are on the way' while nothing is assigned, naming the tool", async () => {
      const ctx = createToolContext();
      await createIncidentFor(ctx);

      const verdict = say(ctx, "Copy that. Medic-1 is en route, ETA four minutes.");

      expect(verdict).not.toBe(true);
      // The verdict is SPOKEN in place of the reply, so it has to be usable to
      // the dispatcher hearing it — which means naming what to do, not what went
      // wrong.
      expect(verdict).toMatch(/resources_dispatch/);
    });

    test("passes the same sentence once a unit really is assigned", async () => {
      const ctx = createToolContext();
      const incidentId = await createIncidentFor(ctx);
      expectToolOk(await run(resourcesDispatch, { incidentId, callsigns: ["Medic-1"] }, ctx));

      // The STATE half is the whole point: the same words are a lie on one board
      // and a report on the other, and only the board can tell them apart.
      expect(say(ctx, "Copy that. Medic-1 is en route, ETA four minutes.")).toBe(true);
    });

    test("lets the desk SAY that nothing is rolling", async () => {
      const ctx = createToolContext();
      await createIncidentFor(ctx);

      // The false positive that would matter most: on a shift with nothing
      // assigned, "no units are en route yet" is the truthful sentence and is
      // exactly the one a keyword filter blocks.
      expect(say(ctx, "Negative — no units are en route yet.")).toBe(true);
      expect(say(ctx, "I'll get Engine-7 rolling once you confirm the address.")).toBe(true);
    });

    test("claimsUnitsMoving is biased toward missing a claim, never toward a false block", () => {
      // The detector alone, away from the board — the half worth pinning, since
      // the guardrail around it is two branches.
      expect(claimsUnitsMoving("Engine-7 is on the way.")).toBe(true);
      expect(claimsUnitsMoving("Units are responding now.")).toBe(true);

      expect(claimsUnitsMoving("Nothing is rolling yet.")).toBe(false);
      expect(claimsUnitsMoving("Once Medic-2 is en route I'll update you.")).toBe(false);
      expect(
        claimsUnitsMoving("Confirmed, 400 Oak Street. What's the nature of the emergency?"),
      ).toBe(false);

      // Per SENTENCE, so a hedge in one clause does not excuse the next.
      expect(claimsUnitsMoving("No one is assigned yet. Ladder-2 is inbound.")).toBe(true);
    });

    test("a NEGATED claim is not a claim — the contraction is the whole hedge", () => {
      // `\bn't\b` cannot match: there is no word boundary between the `n` and the
      // `'` of "isn't", so that alternative was dead and every one of these read
      // as a claim — the guardrail speaking a correction over a dispatcher who
      // said the true thing, which inverts this file's stated bias. Each sentence
      // here carries the contraction and NO other hedge, so a `NOT_A_CLAIM` that
      // cannot see one fails on it.
      expect(claimsUnitsMoving("Medic-1 isn't en route.")).toBe(false);
      expect(claimsUnitsMoving("Engine-7 wasn't rolling.")).toBe(false);
      expect(claimsUnitsMoving("I can't confirm anyone is responding.")).toBe(false);
      expect(claimsUnitsMoving("We don't have anyone inbound.")).toBe(false);
      // The typographic apostrophe a model writes as readily as the straight one.
      expect(claimsUnitsMoving("Medic-1 isn\u2019t en route.")).toBe(false);
    });

    test("the desk can say a negated one out loud, on a board with nothing assigned", async () => {
      const ctx = createToolContext();
      await createIncidentFor(ctx);

      // The end-to-end shape of the same bug: a true sentence, spoken over. No
      // other hedge in either — take the contraction out and the desk is
      // corrected for reporting the board accurately.
      expect(say(ctx, "Negative — Medic-1 isn't en route.")).toBe(true);
      expect(say(ctx, "We don't have anyone inbound.")).toBe(true);
    });
  });
});
