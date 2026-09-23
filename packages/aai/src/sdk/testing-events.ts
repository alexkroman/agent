// Copyright 2026 the AAI authors. MIT license.
/**
 * Picking session events out of a recording BY NAME, so a spec never restates
 * the vocabulary.
 *
 * Specs used to narrow with `Extract<SessionEvent, { type: "tool.called" }>` and
 * a hand-written type guard beside every filter — the event union spelled out
 * again at each site, and silently `never` when a name was misspelled. These
 * two take the name and derive the member from whatever union the recording is
 * typed as: a stamped `SessionEvent`, an emitter's `SessionEventBody`, or a
 * runtime's narrower `TransportEventBody`, all with the same call.
 *
 * The name is checked against THAT union (`K extends E["type"]`), so a
 * misspelled or retired event is a compile error at the call site.
 *
 * @module
 */

/**
 * Whether `event` is the one named `type` — a type guard, so the branch it
 * guards reads that member's fields without a cast.
 *
 * ```ts
 * import type { SessionEvent } from "@alexkroman1/aai";
 * import { isEvent } from "@alexkroman1/aai/testing";
 *
 * declare const recorded: SessionEvent[];
 * const last = recorded.at(-1);
 * if (last && isEvent(last, "tool.called")) console.log(last.toolName);
 * ```
 *
 * @public
 */
export function isEvent<E extends { type: string }, K extends E["type"]>(
  event: E,
  type: K,
): event is Extract<E, { type: K }> {
  return event.type === type;
}

/**
 * Every event in `events` named `type`, in order, typed as that member.
 *
 * ```ts
 * import type { SessionEvent } from "@alexkroman1/aai";
 * import { eventsOf } from "@alexkroman1/aai/testing";
 *
 * declare const recorded: SessionEvent[];
 * const calls = eventsOf(recorded, "tool.called");
 * console.log(calls.map((e) => e.toolName));
 * ```
 *
 * @public
 */
export function eventsOf<E extends { type: string }, K extends E["type"]>(
  events: Iterable<E>,
  type: K,
): Extract<E, { type: K }>[] {
  const out: Extract<E, { type: K }>[] = [];
  for (const event of events) if (isEvent(event, type)) out.push(event);
  return out;
}
