import { tool } from "aai";
import { z } from "zod";
import type { KV } from "../_shared.ts";
import { getState } from "../_shared.ts";

export const resourcesGetAvailable = tool({
  description: "List available resources, optionally filtered by type.",
  parameters: z.object({
    type: z
      .enum([
        "ambulance",
        "fire_engine",
        "police",
        "hazmat_team",
        "helicopter",
        "k9_unit",
        "swat",
        "ems_supervisor",
        "all",
      ])
      .describe("Filter by resource type, or 'all'")
      .optional(),
  }),
  async execute(args, ctx: { kv: KV }) {
    const state = await getState(ctx.kv);
    let resources = state.resources;
    if (args.type && args.type !== "all") {
      resources = resources.filter((r) => r.type === args.type);
    }

    return {
      resources: resources.map((r) => ({
        callsign: r.callsign,
        type: r.type,
        status: r.status,
        assignedIncident: r.assignedIncident,
        eta: r.eta,
        capabilities: r.capabilities,
      })),
      summary: {
        total: resources.length,
        available: resources.filter((r) => r.status === "available").length,
        committed: resources.filter((r) => r.status !== "available").length,
      },
    };
  },
});
