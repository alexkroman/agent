// Copyright 2026 the AAI authors. MIT license.
/**
 * Building a session event and driving an agent's `events` handlers with it —
 * the two things a spec of a hook could not do without restating the wire.
 *
 * `agent({ events })` is observe-only and runs inside a live session, so the
 * only way to test a handler used to be an eval. A unit spec wants to hand the
 * handler ONE event and read what it wrote to a slot, and the two obstacles were
 * both bookkeeping: every event carries a `meta: { id, at }` envelope the
 * session stamps (so a hand-built one needs an `evt_` id and a clock), and the
 * handler map is keyed by event type with a `"*"` that runs after the typed
 * one (so a spec calling `agent.events["tool.called"]?.(…)` tests the handler
 * and not the dispatch). {@link sessionEvent} is the first, {@link fireEvent}
 * the second.
 *
 * Both are framework-agnostic, like everything on `@alexkroman1/aai/testing`:
 * nothing here installs, and the context `fireEvent` defaults to is the same
 * `createToolContext()` a tool spec uses, so a slot a handler wrote is read back
 * through the same `ctx`.
 *
 * @module testing-session-events
 */

import { createToolContext } from "./_testing-context.ts";
import type { AnyDialog } from "./dialog-handle.ts";
import type { SessionEventMeta } from "./protocol-event-meta.ts";
import type { SessionEvent, SessionEventMap, SessionEventType } from "./session-event-map.ts";
import type {
  SessionEventContext,
  SessionEventHandler,
  SessionEventHandlers,
} from "./session-events.ts";

/**
 * The fields of one event beyond its envelope — what {@link sessionEvent} takes
 * after the type: the member of `SessionEventMap` minus `type` and `meta`.
 * Distributes over `K`, so each member keeps its own fields.
 *
 * @public
 */
export type SessionEventFields<K extends SessionEventType> = {
  [T in K]: Omit<SessionEventMap[T], "type" | "meta">;
}[K];

/**
 * The positions after the type: the fields when the event has any, and the
 * `meta` overrides. An event that is only its envelope (`reply.completed`)
 * takes no fields argument at all, so `sessionEvent("reply.completed")` is
 * the whole call rather than `sessionEvent("reply.completed", {})`.
 */
/**
 * The trailing parameters of {@link sessionEvent}: `[meta?]` for an envelope-only
 * event, `[fields, meta?]` for one with a payload.
 *
 * @public
 */
export type SessionEventRest<K extends SessionEventType> = keyof SessionEventFields<K> extends never
  ? [fields?: SessionEventFields<K>, meta?: Partial<SessionEventMeta>]
  : [fields: SessionEventFields<K>, meta?: Partial<SessionEventMeta>];

/** A fixed instant, so a fixture that is compared or snapshotted replays. */
const DEFAULT_AT = Date.UTC(2026, 0, 1);

/** Minted ids count up from here, one per {@link sessionEvent} call. */
let minted = 0;

/**
 * Build a well-formed session event of `type`, envelope included.
 *
 * `meta.id` is minted as `evt_test_<n>` (the `evt_` prefix is what the wire
 * schema requires; the counter is per process and only has to be distinct) and
 * `meta.at` is a FIXED instant, for the reason `createRunSnapshot` fixes its
 * `createdAt`: a fixture that read the clock would not replay. Pass `meta` to
 * pin either.
 *
 * The fields are TYPED by the name: `sessionEvent("tool.called", { … })` needs
 * `toolName`, `toolCallId` and `args`, and a misspelled field is a compile
 * error here rather than a handler reading `undefined`. An event that is only
 * its envelope takes no fields.
 *
 * @example
 * ```ts
 * import { sessionEvent } from "@alexkroman1/aai/testing";
 *
 * const committed = sessionEvent("userTranscript.committed", { text: "two pizzas" });
 * committed.type; // "userTranscript.committed"
 * committed.meta.id.startsWith("evt_"); // true
 * // `sessionEvent("reply.completed").text` is a compile error: the event has no `text`.
 * ```
 *
 * @public
 */
export function sessionEvent<K extends SessionEventType>(
  type: K,
  ...rest: SessionEventRest<K>
): SessionEvent<K> {
  const [fields, meta] = rest;
  minted += 1;
  const envelope: SessionEventMeta = {
    id: meta?.id ?? `evt_test_${minted}`,
    at: meta?.at ?? DEFAULT_AT,
  };
  // Rebuilt rather than cast from a spread: `SessionEvent<K>` is a mapped
  // member the checker cannot see through an object literal over a generic
  // `K`, and the three parts — type, fields, meta — are exactly what the wire
  // carries. `type` LAST, so a `fields` object carrying one cannot override it.
  return { ...(fields ?? {}), meta: envelope, type } as SessionEvent<K>;
}

/**
 * What {@link fireEvent} reports: how many handlers the event reached.
 *
 * @sealed
 * @public
 */
export type FiredEvent = {
  /** The per-type handler ran. */
  readonly typed: boolean;
  /** The `"*"` handler ran, after the typed one. */
  readonly wildcard: boolean;
  /**
   * The keys of the declared dialogs the event MOVED — one whose `on` map
   * names it (`"@session.timedOut": "abandoned"`) and whose active state
   * handles it. Every declared dialog is offered the event, before the
   * handlers, as the session offers it.
   */
  readonly dialogs: readonly string[];
};

/**
 * Drive the agent's dialogs and `events` handlers with one event, the way the
 * session dispatches it: every declared dialog is offered the event FIRST
 * (`dialog.receive`, so a `"@session.timedOut"` transition fires), then the
 * handler declared for `event.type`, then `"*"`, each handed the same context.
 * Dialogs first because a dialog is part of the session's state and moves
 * before any observer sees the effect — the order `aai-runtime`'s session
 * keeps (`session-controls.ts`).
 *
 * Two deliberate differences from the runtime's dispatch, both because a SPEC
 * is reading the outcome rather than a live call surviving it:
 *
 * - **A throw PROPAGATES.** The session catches a handler's throw per handler
 *   and logs it, so a broken audit hook does not end a phone call; a spec
 *   wants the throw, because a handler that threw is the finding.
 * - **A promise is AWAITED.** The session does not wait on an async handler
 *   (the caller is mid-turn); a spec asserting on what the handler wrote has to.
 *
 * `ctx` is a {@link SessionEventContext} — the four fields a handler reads
 * (`sessionId`, `env`, `slots`, `speech`) — and a `createToolContext()`
 * satisfies it, which is the point: a slot the handler wrote is read back with
 * `slot.get(ctx)` through the same context, and what it said is on
 * `ctx.said`. Defaults to a fresh one, i.e. a DISTINCT session; pass one
 * explicitly wherever a second event is meant to see the first's writes.
 *
 * @throws When the agent declares neither `events` nor `dialogs` — there is
 *   nothing to drive, and a spec that fired into nothing would pass against
 *   nothing.
 *
 * @example
 * ```ts
 * import { agent, sessionSlot } from "@alexkroman1/aai";
 * import { createToolContext, fireEvent, sessionEvent } from "@alexkroman1/aai/testing";
 *
 * const heard = sessionSlot("heard", () => ({ lines: [] as string[] }));
 * const def = agent({
 *   name: "Listener",
 *   events: {
 *     "userTranscript.committed": (event, ctx) => {
 *       heard.update(ctx, (draft) => {
 *         draft.lines.push(event.text);
 *       });
 *     },
 *   },
 * });
 *
 * const ctx = createToolContext();
 * await fireEvent(def, sessionEvent("userTranscript.committed", { text: "hello" }), ctx);
 * heard.get(ctx).lines; // ["hello"]
 * ```
 *
 * @public
 */
export async function fireEvent(
  agent: {
    readonly name?: string | undefined;
    readonly events?: SessionEventHandlers | undefined;
    readonly dialogs?: readonly AnyDialog[] | undefined;
  },
  event: SessionEvent,
  ctx: SessionEventContext = createToolContext(),
): Promise<FiredEvent> {
  const handlers = agent.events;
  const declared = agent.dialogs ?? [];
  if (handlers === undefined && declared.length === 0) {
    throw new Error(
      `fireEvent: the agent${agent.name ? ` "${agent.name}"` : ""} declares no \`events\` and no ` +
        `\`dialogs\`, so there is nothing to drive with "${event.type}". Declare a handler with ` +
        "agent({ events }) or a dialog with agent({ dialogs }), or test the function directly.",
    );
  }
  // The dialogs FIRST, each offered the event through `receive` — which sends
  // it only where the active state handles it, so a moved dialog is one whose
  // position changed.
  const dialogs: string[] = [];
  for (const dialog of declared) {
    const before = dialog.position(ctx).state;
    if (dialog.receive(ctx, event).state !== before) dialogs.push(dialog.key);
  }
  // Widened at the LOOKUP, once, as the session's own dispatch does: the
  // handler under `event.type` was declared for exactly this event.
  const typed = handlers?.[event.type] as SessionEventHandler | undefined;
  const wildcard = handlers?.["*"];
  // Sequential, awaited: the typed handler settles before `"*"` runs, so a
  // wildcard that reads what the typed one wrote sees it.
  if (typed) await typed(event, ctx);
  if (wildcard) await wildcard(event, ctx);
  return { typed: typed !== undefined, wildcard: wildcard !== undefined, dialogs };
}
