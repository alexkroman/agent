import type { KV } from "../_shared.ts";
import { getState, saveState } from "../_shared.ts";

export default async function onDisconnect(ctx: { kv: KV }) {
  const state = await getState(ctx.kv);
  await saveState(ctx.kv, state);
}
