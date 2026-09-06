// Copyright 2026 the AAI authors. MIT license.
/**
 * One word for where the CALL has got to, for each {@link AgentState} there is.
 *
 * The sibling of `WORKFLOW_STATUS_LABELS` next door, for the same reason and
 * with the same shape. Three custom chromes carried three renderings of this
 * one seven-member union, all written as a chain of ternaries over the raw
 * member: one mapped `speaking` to "Narrating" and fell through to "Idle" for
 * everything it had not listed, one shouted (`thinking` → "PROCESSING"), and
 * the third rendered the enum member itself — so a caller of that agent read a
 * lowercase `disconnected` in the header of a page nobody had decided to say
 * that on.
 *
 * The exhaustiveness argument is the one that makes this worth exporting rather
 * than documenting. A `Record` over {@link AgentState} means a state ADDED to
 * the union is a compile error HERE, in one place every page inherits, instead
 * of falling through each page's own `: "Idle"` tail into whichever word that
 * page happened to end on — which is a silent wrong label, not a missing one. A
 * page overriding one member keeps that: spreading a complete record cannot
 * drop a key.
 *
 * `SessionStateDot` (`components/session-state-dot.tsx`) is the dot beside it,
 * and this paragraph used to argue against one: the dot's palette is what each
 * chrome exists to look like — a CRT's glow, a dispatch board's alert colours —
 * and a component would take the one part that is genuinely shared (the words)
 * hostage to the part that is not. It takes the palette as a PROP, so it does
 * not: what it shares is the exhaustive colour lookup, this record as the label
 * fallback, and the pulse rule, and the three chromes that had each written
 * those fourteen lines around their own `satisfies Record<AgentState, string>`
 * keep the record and lose the lines.
 */

import type { AgentState } from "./types.ts";

/**
 * The default label per {@link AgentState}.
 *
 * Override the ones your page has a better word for and keep the rest:
 *
 * ```ts
 * import type { AgentState } from "@alexkroman1/aai-ui";
 * import { AGENT_STATE_LABELS } from "@alexkroman1/aai-ui";
 *
 * // A dispatch board that shouts, and renames one state.
 * const STATE_LABEL = { ...AGENT_STATE_LABELS, thinking: "Processing" };
 * const shout = (s: AgentState) => STATE_LABEL[s].toUpperCase();
 * ```
 *
 * **Sentence case, deliberately.** A template that wants caps applies its own
 * `.toUpperCase()`, and a template that wants Title Case is already there;
 * shipping the shouted form instead would leave the two chromes that do not
 * shout with a string they have to un-shout, which no case transform does
 * correctly.
 *
 * Two wordings are decisions rather than transliterations of the member name:
 *
 * - `disconnected` is **"Idle"**. It is the state a session is in BEFORE it has
 *   ever started as well as after it ends, so it is the first word most callers
 *   see; "Disconnected" reads as a fault on a page where nothing has gone
 *   wrong yet. Both chromes that mapped this state by hand chose "Idle" too.
 * - `connecting` and `thinking` carry an ellipsis, `listening` and `speaking`
 *   do not. The first two are waits with nothing for the caller to do; the
 *   other two describe someone actually talking. Same distinction
 *   `WORKFLOW_STATUS_LABELS` draws with its one "Working…".
 *
 * @public
 */
export const AGENT_STATE_LABELS: Readonly<Record<AgentState, string>> = {
  disconnected: "Idle",
  connecting: "Connecting…",
  ready: "Ready",
  listening: "Listening",
  thinking: "Thinking…",
  speaking: "Speaking",
  error: "Error",
};
