// Copyright 2026 the AAI authors. MIT license.
/**
 * The two declarations that WATCH a session without being able to change it.
 *
 * `syncState` publishes the agent's own state to the browser; `events` hands
 * the session's typed event stream to the author's own handlers. Neither can
 * touch a turn — a projection is read after the fact, and a handler's return
 * value is discarded on purpose.
 *
 * They are the complement of `agent-guardrails.ts`, and it is worth reading the
 * two together: that module holds the ONLY declarations that may stop a turn,
 * and this one holds the ones that deliberately may not. Keeping the boundary
 * visible is the point — the observe-only rule survives only as long as it is
 * somewhere a reader trips over.
 *
 * Split out of `types.ts` at the source-length cap, on the same seam
 * `agent-tuning.ts` and `agent-model-tuning.ts` use: a group of
 * `AgentDef` fields that share one rule, declared once. Re-exported from
 * `types.ts`, so no import moved.
 */

import type { SessionEventHandlers } from "./session-events.ts";
import type { StateProjection } from "./session-state.ts";

/**
 * What `agent({ syncState })` accepts: one slot projection, or a list of them.
 *
 * @public
 */
export type SyncStateDeclaration = StateProjection | readonly StateProjection[];

/**
 * The observe-only half of an agent declaration — see this module's header.
 *
 * @public
 */
export interface AgentObservation {
  /**
   * Project per-session state to the browser client, so a custom UI can
   * render it without the agent hand-rolling a sync channel.
   *
   * **A slot's projection, or a list of them**: `syncState: cartSlot.projected`,
   * or `syncState: [cartSlot.projected, prefsSlot.projected]`. Each projection
   * names its own slot, so the `agent_state` frame is `{ [slot]: view }` and the
   * browser selects by the same name (`useAgentState(cartSlot.projected)` reads
   * `state.cart`). Two projections of one slot are refused by name.
   *
   * A slot the agent does not project never leaves the server: session state
   * routinely holds things a browser should not have, so the author decides
   * what leaves, and whatever a projection returns is exactly what the page
   * receives under that key. Pushed after every tool call, and only when a
   * projection changed (this shares a socket with 384 kbps of PCM).
   *
   * **Declare the view on the slot** (`sessionSlot(key, create, { view })`) and
   * pass {@link SessionSlot.projected} at both ends, so the frame rendered
   * before the first push cannot describe a different view from the ones after
   * it. A page that needs a second shape of a slot derives it from the first.
   *
   * ```ts
   * import { agent, sessionSlot } from "@alexkroman1/aai";
   * type Item = { sku: string; qty: number };
   * // `staffPin` is not in the view, so it stays server-side.
   * const cartSlot = sessionSlot("cart", () => ({ items: [] as Item[], staffPin: "" }), {
   *   view: (s) => ({ items: s.items }),
   * });
   * const prefsSlot = sessionSlot("prefs", () => ({ units: "metric" }));
   * agent({ name: "Cart", syncState: cartSlot.projected });
   * // Two slots, one frame: { cart: { items }, prefs: { units } }.
   * agent({ name: "Cart", syncState: [cartSlot.projected, prefsSlot.projected] });
   * ```
   *
   * `agent()` returns the record keyed by slot name (see
   * {@link AgentDef.syncState}).
   */
  syncState?: SyncStateDeclaration;
  /**
   * Observe the session's own event stream — an audit log, per-turn metrics, or
   * "write every call to my own database".
   *
   * Keyed by event type, with `"*"` matching every event. Typed handlers run
   * first, then `"*"`, and both run AFTER the event has been recorded in the
   * session's retained stream and sent to the client:
   *
   * ```ts
   * import { agent } from "@alexkroman1/aai";
   *
   * agent({
   *   name: "Audited",
   *   events: {
   *     "tool.called": (e, ctx) => {
   *       // A hook gets `ctx.env` and `ctx.slots`, never a database — persist
   *       // through a client of your own if you need to.
   *       void fetch(`${ctx.env.AUDIT_URL}`, {
   *         method: "POST",
   *         body: JSON.stringify({ id: e.meta.id, tool: e.toolName }),
   *       });
   *     },
   *     "*": (e) => console.log(e.meta.at, e.type),
   *   },
   * });
   * ```
   *
   * Three properties are load-bearing, and each is a rule rather than a detail:
   *
   * - **Observe-only.** A handler cannot inject model context, change a reply, or
   *   cancel anything. That is what keeps the stream a LOG rather than a second
   *   control path, and it is why a handler receives no way to reply.
   * - **A throw is NON-FATAL.** It is logged against the event and the session
   *   continues — a failing audit hook must not end a phone call. An async
   *   handler is not awaited either, for the same reason: the caller is mid-turn.
   * - **Delivery is at-least-once, and `meta.id` is the key.** The id is stable
   *   across replays, so a handler storing content keys on it; a handler doing a
   *   non-idempotent side effect keys on the work's own coordinates instead,
   *   because retried work re-emits under fresh ids.
   *
   * Before this there was no way for an agent author to observe their own agent
   * at all: the framework carried 51 internal `on*` callback options and not one
   * of them was reachable from `agent.ts`.
   */
  events?: SessionEventHandlers;
}
