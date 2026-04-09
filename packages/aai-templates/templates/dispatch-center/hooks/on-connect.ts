import type { KV } from "../_shared.ts";
import { getState, saveState } from "../_shared.ts";

export default async function onConnect(ctx: { kv: KV }) {
  // Restore operational state from persistent storage on reconnect.
  // getState returns the default state if nothing is persisted yet,
  // and we save it immediately so tools always find valid state in KV.
  const state = await getState(ctx.kv);
  await saveState(ctx.kv, state);
}
