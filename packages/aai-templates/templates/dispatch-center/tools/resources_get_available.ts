import type { KV } from "../_shared.ts";
import { getState } from "../_shared.ts";

export default async function execute(args: { type?: string }, ctx: { kv: KV }) {
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
}
