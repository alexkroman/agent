// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:agent` epoch 12.
 *
 * **Epoch 13 is COLLATERAL.** The export list did not change. What moved is
 * `SessionEventType`, the KEY SET of `agent({ events })`, which gained one
 * member — `"metrics.collected"`, what one reply cost stage by stage (the
 * `aai:metrics` capability is its own contract). A union that GREW: every key
 * an epoch-12 author wrote is still a key, so the handlers below compile
 * unchanged, and a `"*"` handler simply sees one more frame per reply.
 *
 * ## What this file has to name
 *
 * `v1.ts` through `v11.ts` are retained and between them name every export of
 * epoch 12, which added no name of its own — `turnDetection` is a FIELD of
 * `AgentDef`. So this is the shape an epoch-12 author had where the grown
 * union lands: a push-to-talk agent with a roster, and an `events` map keyed
 * on the names that existed then.
 *
 * **Its specifiers are RELATIVE**, for the reason every frozen example's are.
 *
 * @module
 */

import type { AgentDef, SessionEventHandlers, SessionEventType } from "../../../index.ts";
import { agent, personas } from "../../../index.ts";

/** A roster, as epoch 11 added it: who answers, and who a caller is handed to. */
const desk = personas([
  { name: "reception", description: "Greets and routes", systemPrompt: "Find out what they need." },
  { name: "billing", description: "Invoices and refunds", systemPrompt: "Resolve the invoice." },
]);

/** The keys an epoch-12 recorder counted — every one still a key at 13. */
export const COUNTED: readonly SessionEventType[] = [
  "user-transcript.committed",
  "tool.called",
  "usage.updated",
];

let turns = 0;

/** The handlers, keyed on epoch-12 names. None is exhaustive over the union. */
const events: SessionEventHandlers = {
  "user-transcript.committed": () => {
    turns++;
  },
  "usage.updated": (e) => {
    if (e.totalTokens > 50_000) turns = 0;
  },
};

export const frontDesk: AgentDef = agent({
  name: "Front desk",
  systemPrompt: "Answer in one or two sentences.",
  personas: desk,
  // Epoch 12's own field: the client ends each turn (push-to-talk).
  turnDetection: "manual",
  events,
});

export function turnsSoFar(): number {
  return turns;
}
