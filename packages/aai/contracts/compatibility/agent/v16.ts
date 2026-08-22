// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:agent` epoch 16.
 *
 * Two things moved, and only one of them is new surface.
 *
 * **`SessionEventType` is the ADDITION** — `SessionEvent["type"]`, the key set of
 * `SessionEventHandlers`, finally given a name. The keys were always the API:
 * `agent({ events: { "tool.called": … } })` is authoring code and the string
 * literal is what an author types. But the union was computed inline from the
 * wire schema, and `SessionEvent` is an opaque `z.infer` alias in the rollup — so
 * REMOVING an event name left this capability's hash byte-identical, shipped as a
 * `patch`, and broke the build of everyone who had written a handler for it.
 * Naming the union puts the names in the report, which makes that a
 * classification instead of a surprise. An author gets the second half of the
 * bargain: an autocompletable union they can write down in their own code.
 *
 * **The rest moved TRANSITIVELY.** `AgentDef.tools` is
 * `Readonly<Record<string, ToolDef<ToolInputSchema>>>`, and `ToolDef` grew a
 * result type parameter at `aai:tool` epoch 10 — `../tool/v10.ts` is where that
 * story is told and is not retold here. Nothing an `agent()` call writes changed:
 * `R` defaults to `unknown`, so the one-argument spelling still means "any
 * result" and a table annotated before it accepts a tool whose body returns
 * something concrete. Epoch 15 is RETAINED and `./v15.ts` compiles unchanged
 * beside this file.
 *
 * See `./v3.ts` for what "frozen" obliges and why the imports are relative.
 */

import { z } from "zod";

import {
  type AgentDef,
  agent,
  type SessionEventHandlers,
  type SessionEventType,
  tool,
} from "../../../index.ts";

/**
 * The names an audit hook cares about, written down as a value.
 *
 * This is the line epoch 16 makes writable. Before it the only way to name the
 * key set was `SessionEvent["type"]`, which means importing the WIRE union from
 * `/protocol` into an `agent.ts` — a non-authoring subpath, pulled in for a
 * string list.
 */
export const AUDITED: readonly SessionEventType[] = [
  "tool.called",
  "tool.completed",
  "error.reported",
];

/** A lookup keyed by the union, so a new event name is a missing key and not a typo. */
export const LABELS: Partial<Record<SessionEventType, string>> = {
  "tool.called": "call",
  "tool.completed": "result",
  "error.reported": "error",
};

export function isAudited(type: SessionEventType): boolean {
  return AUDITED.includes(type);
}

/**
 * A handler map an author assembles OUTSIDE the `agent()` call — the reason the
 * map's own type is public — and hands over as one field.
 *
 * The typed arm still narrows: `event` in `"tool.called"` is the `tool.called`
 * member alone, so `event.toolName` resolves and `event.result` does not.
 */
const trail: string[] = [];

const events: SessionEventHandlers = {
  // A handler's return type is `unknown`, so `push`'s `number` is fine here —
  // the value is ignored, and `void | Promise<void>` would reject this line.
  "tool.called": (event, ctx) => trail.push(`${ctx.sessionId} called ${event.toolName}`),
  // The wildcard runs for every event and is handed the whole union, which is
  // exactly where a `SessionEventType`-keyed lookup earns its place.
  "*": (event) => isAudited(event.type) && trail.push(LABELS[event.type] ?? event.type),
};

export function auditTrail(): readonly string[] {
  return trail;
}

/** The declaration. `events` is observe-only — there is no `send` on its context. */
export const audited = agent({
  name: "Audited",
  greeting: "Everything here is logged.",
  events,
});

/**
 * The transitive half, as a compile-checked fact rather than a claim.
 *
 * `agent()` REFUSES a `tools` key — a tool is a FILE, and the table is filled by
 * the build (or by `withDiscoveredTools` in a spec) — so what an author names is
 * the resolved def's field. That annotation predates the `R` parameter and still
 * accepts a tool whose body returns `{ currency: string; total: number }`, which
 * is the whole evidence that adding the parameter broke nobody here.
 */
const priceCart = tool({
  description: "Total the cart.",
  inputSchema: z.object({ currency: z.string() }),
  execute: async ({ currency }) => ({ currency, total: 0 }),
});

export const declaredTools: AgentDef["tools"] = { price_cart: priceCart };
