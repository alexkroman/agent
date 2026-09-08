import { z } from "zod";
import { dispatchSlot, RESOURCE_TYPES } from "../shared.ts";

export default dispatchSlot.tool({
  description: "List available resources, optionally filtered by type.",
  inputSchema: z.object({
    type: z
      .enum([...RESOURCE_TYPES, "all"])
      .describe("Filter by resource type, or 'all'")
      .optional(),
  }),
  execute(args, state) {
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
