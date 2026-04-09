import type { KV } from "../_shared.ts";
import { getState, now, saveState } from "../_shared.ts";

export default async function execute(
  args: { incidentId: string; note: string; source?: string },
  ctx: { kv: KV },
) {
  const state = await getState(ctx.kv);
  const inc = state.incidents[args.incidentId];
  if (!inc) return { error: `Incident ${args.incidentId} not found` };

  const entry = args.source ? `[${args.source}] ${args.note}` : args.note;
  inc.notes.push(entry);
  inc.timeline.push({ time: now(), event: entry });
  inc.updatedAt = now();
  await saveState(ctx.kv, state);

  return {
    incidentId: args.incidentId,
    noteAdded: entry,
    totalNotes: inc.notes.length,
  };
}
