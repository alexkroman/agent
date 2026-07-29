import type { Kv, ToolContext } from "@alexkroman1/aai";
import { describe, expect, test } from "vitest";
import { getState } from "./shared.ts";
import { incidentCreate } from "./tools/incident_create.ts";
import { incidentEscalate } from "./tools/incident_escalate.ts";
import { incidentTriage } from "./tools/incident_triage.ts";
import { incidentUpdateStatus } from "./tools/incident_update_status.ts";
import { resourcesDispatch } from "./tools/resources_dispatch.ts";
import { resourcesUpdateStatus } from "./tools/resources_update_status.ts";

/**
 * Map-backed Kv stub. Values are structuredClone'd on both set and get so
 * each read returns an independent snapshot, like a real (serializing) KV
 * store — without this, shared object references would mask lost updates
 * and the concurrency test below would pass even without serialization.
 */
function makeKv(): Kv {
  const store = new Map<string, unknown>();
  return {
    get: async <T>(key: string): Promise<T | null> =>
      store.has(key) ? (structuredClone(store.get(key)) as T) : null,
    set: async (key: string, value: unknown): Promise<void> => {
      store.set(key, structuredClone(value));
    },
    delete: async (keys: string | string[]): Promise<void> => {
      for (const k of Array.isArray(keys) ? keys : [keys]) store.delete(k);
    },
  };
}

let sessionCounter = 0;

function makeCtx(): { ctx: ToolContext; kv: Kv; sessionId: string } {
  const kv = makeKv();
  const sessionId = `test-session-${++sessionCounter}`;
  const ctx = {
    kv,
    sessionId,
    send: () => {},
    env: {},
    state: {},
    messages: [],
  } as unknown as ToolContext;
  return { ctx, kv, sessionId };
}

async function createIncidentFor(
  ctx: ToolContext,
  description = "structure fire with heavy smoke",
): Promise<string> {
  const result = (await incidentCreate.execute(
    { location: "400 Oak Street", description },
    ctx,
  )) as { incidentId: string };
  return result.incidentId;
}

describe("dispatch-center template", () => {
  test("resolving an incident does not yank a reassigned unit off its new incident", async () => {
    const { ctx, kv, sessionId } = makeCtx();

    const inc1 = await createIncidentFor(ctx);
    await resourcesDispatch.execute({ incidentId: inc1, callsigns: ["Medic-1"] }, ctx);

    // Medic-1 radios available, then is dispatched to a second incident.
    await resourcesUpdateStatus.execute({ callsign: "Medic-1", status: "available" }, ctx);
    const inc2 = await createIncidentFor(ctx, "cardiac arrest, not breathing");
    await resourcesDispatch.execute({ incidentId: inc2, callsigns: ["Medic-1"] }, ctx);

    // Resolving the first incident must not touch Medic-1 anymore.
    await incidentUpdateStatus.execute({ incidentId: inc1, status: "resolved" }, ctx);

    const state = await getState(kv, sessionId);
    const medic1 = state.resources.find((r) => r.callsign === "Medic-1");
    expect(medic1?.status).toBe("dispatched");
    expect(medic1?.assignedIncident).toBe(inc2);
    expect(state.incidents[inc2]?.assignedResources).toContain("R1");
    expect(state.incidents[inc1]?.assignedResources).not.toContain("R1");
  });

  test("callsigns: ['auto'] triggers auto-dispatch as the description promises", async () => {
    const { ctx } = makeCtx();
    const incidentId = await createIncidentFor(ctx, "cardiac arrest, patient not breathing");

    const result = (await resourcesDispatch.execute({ incidentId, callsigns: ["auto"] }, ctx)) as {
      dispatched: { callsign: string }[];
      failed?: { callsign: string; reason: string }[];
    };

    expect(result.failed).toBeUndefined();
    expect(result.dispatched.length).toBeGreaterThan(0);
  });

  test("concurrent tool calls are serialized — no lost updates", async () => {
    const { ctx, kv, sessionId } = makeCtx();

    // Parallel tool calls in one LLM turn run concurrently. Without the
    // per-session mutex both would read the same snapshot and one incident
    // would silently vanish on save.
    const [a, b] = (await Promise.all([
      incidentCreate.execute({ location: "1 First St", description: "gas leak" }, ctx),
      incidentCreate.execute({ location: "2 Second St", description: "vehicle crash" }, ctx),
    ])) as { incidentId: string }[];

    const state = await getState(kv, sessionId);
    expect(a?.incidentId).not.toBe(b?.incidentId);
    expect(state.incidentCounter).toBe(2);
    expect(Object.keys(state.incidents)).toHaveLength(2);
  });

  test("negative casualty counts are rejected by the parameter schemas", () => {
    expect(
      incidentTriage.parameters?.safeParse({ incidentId: "INC-0001", casualtyUpdate: -5 }).success,
    ).toBe(false);
    expect(
      incidentCreate.parameters?.safeParse({
        location: "1 First St",
        description: "fire",
        estimatedCasualties: -1,
      }).success,
    ).toBe(false);
    expect(
      incidentUpdateStatus.parameters?.safeParse({
        incidentId: "INC-0001",
        status: "on_scene",
        casualtyUpdate: { confirmed: -2 },
      }).success,
    ).toBe(false);
  });

  test("mutual-aid units get unique ids and callsigns across escalations", async () => {
    const { ctx, kv, sessionId } = makeCtx();
    const incidentId = await createIncidentFor(ctx);

    await incidentEscalate.execute(
      { incidentId, reason: "spreading", requestMutualAid: true },
      ctx,
    );
    await incidentEscalate.execute(
      { incidentId, reason: "still spreading", requestMutualAid: true },
      ctx,
    );

    const state = await getState(kv, sessionId);
    const mutualAid = state.resources.filter((r) => r.id.startsWith("MA-"));
    expect(mutualAid).toHaveLength(4);
    expect(new Set(mutualAid.map((r) => r.id)).size).toBe(4);
    expect(new Set(mutualAid.map((r) => r.callsign)).size).toBe(4);
  });

  test("resolved is terminal: no escalation, re-resolution, or dispatch", async () => {
    const { ctx } = makeCtx();
    const incidentId = await createIncidentFor(ctx);
    await incidentUpdateStatus.execute({ incidentId, status: "resolved" }, ctx);

    const escalated = (await incidentEscalate.execute({ incidentId, reason: "flare-up" }, ctx)) as {
      error?: string;
    };
    expect(escalated.error).toMatch(/resolved/);

    const reResolved = (await incidentUpdateStatus.execute(
      { incidentId, status: "resolved" },
      ctx,
    )) as { error?: string };
    expect(reResolved.error).toMatch(/resolved/);

    const dispatchedTo = (await resourcesDispatch.execute(
      { incidentId, callsigns: ["Medic-1"] },
      ctx,
    )) as { error?: string };
    expect(dispatchedTo.error).toMatch(/resolved/);
  });
});
