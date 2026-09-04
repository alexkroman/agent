import type {
  DialogPosition,
  InferToolOutput,
  ToolContext,
  ToolDef,
  ToolInputSchema,
} from "@alexkroman1/aai";
import { isToolFailure } from "@alexkroman1/aai";
import { createToolContext, expectToolOk } from "@alexkroman1/aai/testing";
import { describe, expect, test } from "vitest";
import { callFlow, dispatchSlot } from "./shared.ts";
import incidentAddNote from "./tools/incident_add_note.ts";
import incidentCreate from "./tools/incident_create.ts";
import incidentEscalate from "./tools/incident_escalate.ts";
import incidentTriage from "./tools/incident_triage.ts";
import incidentUpdateStatus from "./tools/incident_update_status.ts";
import opsRunScenario from "./tools/ops_run_scenario.ts";
import resourcesDispatch from "./tools/resources_dispatch.ts";
import resourcesUpdateStatus from "./tools/resources_update_status.ts";

/** The dispatch board lives in a session slot, and `createToolContext` gives
 *  each call its own slot store — so two contexts are two boards by
 *  construction. */
const makeCtx = (): ToolContext => createToolContext();

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
    const ctx = makeCtx();

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
    const ctx = makeCtx();
    const incidentId = await createIncidentFor(ctx, "cardiac arrest, patient not breathing");

    const result = expectToolOk<Result<typeof resourcesDispatch>>(
      await resourcesDispatch.execute({ incidentId, callsigns: ["auto"] }, ctx),
    );

    expect(result.failed).toBeUndefined();
    expect(result.dispatched.length).toBeGreaterThan(0);
  });

  test("concurrent tool calls are serialized — no lost updates", async () => {
    const ctx = makeCtx();

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

  test("negative casualty counts are rejected by the parameter schemas", () => {
    expect(
      incidentTriage.inputSchema?.safeParse({ incidentId: "INC-0001", casualtyUpdate: -5 }).success,
    ).toBe(false);
    expect(
      incidentCreate.inputSchema?.safeParse({
        location: "1 First St",
        description: "fire",
        estimatedCasualties: -1,
      }).success,
    ).toBe(false);
    expect(
      incidentUpdateStatus.inputSchema?.safeParse({
        incidentId: "INC-0001",
        status: "on_scene",
        casualtyUpdate: { confirmed: -2 },
      }).success,
    ).toBe(false);
  });

  test("mutual-aid units get unique ids and callsigns across escalations", async () => {
    const ctx = makeCtx();
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
    const ctx = makeCtx();
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
    const ctx = makeCtx();
    expect(at(ctx).state).toBe("standby");

    // Each of these used to run and answer `Incident INC-0001 not found` — a
    // data answer to a positional question. The refusal now names where the
    // shift is and quotes what to do about it.
    for (const call of [
      incidentTriage.execute({ incidentId: "INC-0001" }, ctx),
      resourcesDispatch.execute({ incidentId: "INC-0001", callsigns: ["Medic-1"] }, ctx),
      incidentUpdateStatus.execute({ incidentId: "INC-0001", status: "on_scene" }, ctx),
      incidentEscalate.execute({ incidentId: "INC-0001", reason: "spreading" }, ctx),
      incidentAddNote.execute({ incidentId: "INC-0001", note: "caller hung up" }, ctx),
      resourcesUpdateStatus.execute({ callsign: "Medic-1", status: "en_route" }, ctx),
    ]) {
      const refusal = await call;
      expect(isToolFailure(refusal)).toBe(true);
      expect(isToolFailure(refusal) && refusal.error).toMatch(/standby/);
    }

    // And nothing ran: a refusal must not have touched the board.
    expect(dispatchSlot.get(ctx).incidentCounter).toBe(0);
  });

  test("logging, triaging and dispatching walk the call through its three steps", async () => {
    const ctx = makeCtx();

    const created = await incidentCreate.execute(
      { location: "400 Oak Street", description: "structure fire with heavy smoke" },
      ctx,
    );
    // `state`/`instruction`, not `at`/`next`: this ungated tool spreads the
    // `DialogPosition` verbatim now, so it reports its position under the same
    // keys every gated tool's result carries.
    expect(created.state).toBe("working.triaging");
    expect(created.instruction).toMatch(/incident_triage/);

    const triaged = expectToolOk<Result<typeof incidentTriage>>(
      await incidentTriage.execute({ incidentId: created.incidentId, severity: "critical" }, ctx),
    );
    expect(triaged.triageScore).toBeGreaterThan(0);
    expect(at(ctx).state).toBe("working.dispatching");

    expectToolOk(
      await resourcesDispatch.execute({ incidentId: created.incidentId, autoDispatch: true }, ctx),
    );
    expect(at(ctx).state).toBe("working.monitoring");
    expect(at(ctx).instruction).toMatch(/radio in/);
  });

  test("a dispatch that rolled nothing leaves the call where it was", async () => {
    const ctx = makeCtx();
    const incidentId = await createIncidentFor(ctx);
    await incidentTriage.execute({ incidentId }, ctx);
    expect(at(ctx).state).toBe("working.dispatching");

    // Every requested callsign is unknown, so no unit moved — and the call has
    // not moved on either.
    const result = expectToolOk<Result<typeof resourcesDispatch>>(
      await resourcesDispatch.execute({ incidentId, callsigns: ["Ghost-1"] }, ctx),
    );
    expect(result.dispatched).toHaveLength(0);
    expect(at(ctx).state).toBe("working.dispatching");
  });

  test("a new call is legal mid-incident and puts the flow back on triage", async () => {
    const ctx = makeCtx();
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
    const ctx = makeCtx();
    const incidentId = await createIncidentFor(ctx);
    await incidentUpdateStatus.execute({ incidentId, status: "resolved" }, ctx);
    const before = at(ctx).state;

    const refused = await incidentTriage.execute({ incidentId, severity: "critical" }, ctx);
    expect(isToolFailure(refused)).toBe(true);
    expect(at(ctx).state).toBe(before);
  });

  test("a training scenario logs incidents like a real call does", async () => {
    const ctx = makeCtx();
    const result = await opsRunScenario.execute({ scenario: "mass_casualty" }, ctx);
    expect(result.incidentsCreated.length).toBeGreaterThan(1);
    expect(result.state).toBe("working.triaging");
  });
});
