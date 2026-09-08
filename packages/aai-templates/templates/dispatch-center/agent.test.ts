import dispatchAgent from "virtual:aai/agent";
import type {
  DialogPosition,
  DialogStateSpec,
  InferToolInput,
  InferToolOutput,
  ToolContext,
  ToolDef,
  ToolInputSchema,
} from "@alexkroman1/aai";
import { createSeededRandom, isToolFailure } from "@alexkroman1/aai";
import {
  createToolContext,
  expectDeployable,
  expectDialogOk,
  expectDialogRefused,
  expectPromptBuiltinsDeclared,
  expectToolOk,
  parseSchemaInput,
  schemaInputIssues,
} from "@alexkroman1/aai/testing";
import { describe, expect, test, vi } from "vitest";
import { DISPATCH_EVENTS } from "./events.ts";
import { callFlow, callSpec, dispatchSlot } from "./shared.ts";
import incidentAddNote from "./tools/incident_add_note.ts";
import incidentCreate from "./tools/incident_create.ts";
import incidentEscalate from "./tools/incident_escalate.ts";
import incidentTriage from "./tools/incident_triage.ts";
import incidentUpdateStatus from "./tools/incident_update_status.ts";
import opsRunScenario, { SCENARIO_NAMES } from "./tools/ops_run_scenario.ts";
import resourcesDispatch from "./tools/resources_dispatch.ts";
import resourcesUpdateStatus from "./tools/resources_update_status.ts";

/**
 * What a gated tool's own `execute` returned, read off the tool itself.
 *
 * `callFlow.tool` threads its result type out now, so `InferToolOutput` answers
 * `DialogToolResult<R> | ToolFailure` — this is that minus the envelope and the
 * refusal arm. It replaces the inline `{ dispatched: { callsign: string }[] }`
 * shapes the assertions below used to restate, which were a second copy of each
 * tool's return type that could not go stale loudly.
 *
 * The unwrap itself is `expectToolOk` from `@alexkroman1/aai/testing`; the hand-rolled
 * copy that used to sit here was byte-identical to three other templates'.
 */
type Result<T extends ToolDef<ToolInputSchema>> = Extract<
  InferToolOutput<T>,
  { result: unknown }
>["result"];

/** Where the call is, without going through a tool. */
const at = (ctx: ToolContext): DialogPosition => callFlow.position(ctx);

async function createIncidentFor(
  ctx: ToolContext,
  description = "structure fire with heavy smoke",
): Promise<string> {
  const result = await incidentCreate.execute({ location: "400 Oak Street", description }, ctx);
  return result.incidentId;
}

describe("dispatch-center template", () => {
  test("resolving an incident does not yank a reassigned unit off its new incident", async () => {
    const ctx = createToolContext();

    const inc1 = await createIncidentFor(ctx);
    await resourcesDispatch.execute({ incidentId: inc1, callsigns: ["Medic-1"] }, ctx);

    // Medic-1 radios available, then is dispatched to a second incident.
    await resourcesUpdateStatus.execute({ callsign: "Medic-1", status: "available" }, ctx);
    const inc2 = await createIncidentFor(ctx, "cardiac arrest, not breathing");
    await resourcesDispatch.execute({ incidentId: inc2, callsigns: ["Medic-1"] }, ctx);

    // Resolving the first incident must not touch Medic-1 anymore.
    await incidentUpdateStatus.execute({ incidentId: inc1, status: "resolved" }, ctx);

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

    const result = expectToolOk<Result<typeof resourcesDispatch>>(
      await resourcesDispatch.execute({ incidentId, callsigns: ["auto"] }, ctx),
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
      incidentCreate.execute({ location: "1 First St", description: "gas leak" }, ctx),
      incidentCreate.execute({ location: "2 Second St", description: "vehicle crash" }, ctx),
    ]);

    const state = dispatchSlot.get(ctx);
    expect(a?.incidentId).not.toBe(b?.incidentId);
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
      const rolled = expectToolOk<Result<typeof resourcesDispatch>>(
        await resourcesDispatch.execute({ incidentId, autoDispatch: true, priority }, ctx),
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

    await incidentEscalate.execute(
      { incidentId, reason: "spreading", requestMutualAid: true },
      ctx,
    );
    await incidentEscalate.execute(
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
    await incidentUpdateStatus.execute({ incidentId, status: "resolved" }, ctx);

    // Each is a refusal the BODY answered, so it arrives unwrapped as a
    // `ToolFailure` rather than under the position envelope — which is what the
    // narrowing says, where the old cast to `{ error?: string }` said nothing
    // and would have read `undefined` off a success just as quietly.
    const escalated = await incidentEscalate.execute({ incidentId, reason: "flare-up" }, ctx);
    expect(isToolFailure(escalated) && escalated.error).toMatch(/resolved/);

    const reResolved = await incidentUpdateStatus.execute({ incidentId, status: "resolved" }, ctx);
    expect(isToolFailure(reResolved) && reResolved.error).toMatch(/resolved/);

    const dispatchedTo = await resourcesDispatch.execute(
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
      incidentTriage.execute({ incidentId: "INC-0001" }, ctx),
      resourcesDispatch.execute({ incidentId: "INC-0001", callsigns: ["Medic-1"] }, ctx),
      incidentUpdateStatus.execute({ incidentId: "INC-0001", status: "on_scene" }, ctx),
      incidentEscalate.execute({ incidentId: "INC-0001", reason: "spreading" }, ctx),
      incidentAddNote.execute({ incidentId: "INC-0001", note: "caller hung up" }, ctx),
      resourcesUpdateStatus.execute({ callsign: "Medic-1", status: "en_route" }, ctx),
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

    const created = await incidentCreate.execute(
      { location: "400 Oak Street", description: "structure fire with heavy smoke" },
      ctx,
    );
    // `state`/`instruction`, not `at`/`next`: this ungated tool spreads the
    // `DialogPosition` verbatim now, so it reports its position under the same
    // keys every gated tool's result carries.
    expect(created.state).toBe("working.triaging");
    expect(created.instruction).toMatch(/incident_triage/);

    // `expectDialogOk` rather than `expectToolOk`: what a gated tool answers is
    // the author's value UNDER the position, and the position the MODEL was
    // handed is the stronger claim — reading it back off the slot with `at(ctx)`
    // would still pass if the envelope reported somewhere else entirely.
    const triaged = expectDialogOk<Result<typeof incidentTriage>>(
      await incidentTriage.execute({ incidentId: created.incidentId, severity: "critical" }, ctx),
    );
    expect(triaged.result.triageScore).toBeGreaterThan(0);
    expect(triaged.state).toBe("working.dispatching");

    const rolled = expectDialogOk(
      await resourcesDispatch.execute({ incidentId: created.incidentId, autoDispatch: true }, ctx),
    );
    expect(rolled.state).toBe("working.monitoring");
    expect(rolled.instruction).toMatch(/radio in/);
    expect(at(ctx).state).toBe("working.monitoring");
  });

  test("a dispatch that rolled nothing leaves the call where it was", async () => {
    const ctx = createToolContext();
    const incidentId = await createIncidentFor(ctx);
    await incidentTriage.execute({ incidentId }, ctx);
    expect(at(ctx).state).toBe("working.dispatching");

    // Every requested callsign is unknown, so no unit moved — and the call has
    // not moved on either, which the result itself reports.
    const result = expectDialogOk<Result<typeof resourcesDispatch>>(
      await resourcesDispatch.execute({ incidentId, callsigns: ["Ghost-1"] }, ctx),
    );
    expect(result.result.dispatched).toHaveLength(0);
    expect(result.state).toBe("working.dispatching");
  });

  test("a new call is legal mid-incident and puts the flow back on triage", async () => {
    const ctx = createToolContext();
    const first = await createIncidentFor(ctx);
    await incidentTriage.execute({ incidentId: first }, ctx);
    await resourcesDispatch.execute({ incidentId: first, autoDispatch: true }, ctx);
    expect(at(ctx).state).toBe("working.monitoring");

    await createIncidentFor(ctx, "chemical spill spreading toward a storm drain");
    expect(at(ctx).state).toBe("working.triaging");

    // The first incident is still workable — the position tracks the call in
    // hand, and the tools are addressed by id.
    expectToolOk(await incidentAddNote.execute({ incidentId: first, note: "crews on scene" }, ctx));
  });

  test("a failed tool does not advance the flow", async () => {
    const ctx = createToolContext();
    const incidentId = await createIncidentFor(ctx);
    await incidentUpdateStatus.execute({ incidentId, status: "resolved" }, ctx);
    const before = at(ctx).state;

    const refused = await incidentTriage.execute({ incidentId, severity: "critical" }, ctx);
    expect(isToolFailure(refused)).toBe(true);
    expect(at(ctx).state).toBe(before);
  });

  test("a training scenario logs incidents like a real call does", async () => {
    const ctx = createToolContext();
    const result = await opsRunScenario.execute({ scenario: "mass_casualty" }, ctx);
    expect(result.incidentsCreated.length).toBeGreaterThan(1);
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
    expect(dispatchAgent.events).toBe(DISPATCH_EVENTS);
  });

  test("it deploys, and the builtins the prompt commands are enabled", () => {
    // `agent.ts` claims in a comment that `system-prompt.md` tells the model to
    // use `web_search` and `run_code`, and that they are therefore declared —
    // the default builtin set has neither, so the prompt would be commanding
    // tools the session never registers. `expectPromptBuiltinsDeclared` reads
    // the resolved prompt for builtin NAMES and checks each one against the
    // config, so the claim fails here rather than mid-call.
    expect(expectDeployable(dispatchAgent).name).toBe("Dispatch Command Center");
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
  /**
   * The hang-up, delivered the way the runtime delivers it.
   *
   * The handler is looked up and CHECKED rather than called through `?.()`: a
   * table that lost the key would leave every assertion below passing against a
   * hook that never ran.
   */
  function hangUpOn(ctx: ToolContext): void {
    const onHangUp = DISPATCH_EVENTS["session.timed-out"];
    if (onHangUp === undefined) throw new Error("DISPATCH_EVENTS declares no session.timed-out");
    onHangUp({ type: "session.timed-out", meta: { id: "evt-1", at: Date.now() } }, ctx);
  }

  test("is written on the incident in hand, and moves the shift nowhere", async () => {
    const ctx = createToolContext();
    const incidentId = await createIncidentFor(ctx);
    await incidentTriage.execute({ incidentId }, ctx);
    const before = at(ctx).state;

    hangUpOn(ctx);

    const timeline = dispatchSlot.get(ctx).incidents[incidentId]?.timeline ?? [];
    expect(timeline.at(-1)?.event).toMatch(/CALLER LOST/);
    // The caller is gone; the shift is not. A phone desk carries this event
    // into a terminal state — here the units are still rolling and the
    // dispatcher goes on working the board.
    expect(at(ctx).state).toBe(before);
  });

  test("lands on the incident LAST TOUCHED, not the newest one", async () => {
    // The clock is driven because `updatedAt` is `Date.now()`: three calls in a
    // row land in one millisecond and the tie-break, not the rule, would decide
    // the assertion. A shift's calls are minutes apart.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T08:00:00Z"));
      const ctx = createToolContext();
      const first = await createIncidentFor(ctx);
      vi.setSystemTime(new Date("2026-01-01T08:01:00Z"));
      const second = await createIncidentFor(ctx, "chemical spill near a storm drain");
      // The dispatcher goes BACK to the first call, which is what "in hand"
      // means — `updatedAt` is the only fact that carries it, and taking the
      // newest incident instead would annotate the wrong one.
      vi.setSystemTime(new Date("2026-01-01T08:02:00Z"));
      await incidentAddNote.execute({ incidentId: first, note: "caller is with the patient" }, ctx);

      hangUpOn(ctx);

      const board = dispatchSlot.get(ctx).incidents;
      expect(board[first]?.timeline.at(-1)?.event).toMatch(/CALLER LOST/);
      expect(board[second]?.timeline.at(-1)?.event).not.toMatch(/CALLER LOST/);
    } finally {
      vi.useRealTimers();
    }
  });

  test("writes nothing when the shift has nothing open", () => {
    const ctx = createToolContext();

    // Not a crash and not an invented incident: a call that dropped before
    // `incident_create` left no record to annotate.
    hangUpOn(ctx);

    expect(dispatchSlot.get(ctx).incidentCounter).toBe(0);
    expect(Object.keys(dispatchSlot.get(ctx).incidents)).toEqual([]);
  });
});
