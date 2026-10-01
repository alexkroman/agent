// Copyright 2026 the AAI authors. MIT license.
/**
 * `Toolset` — the ONE shape every source of tools hands the runtime.
 *
 * Six things put a tool in front of the model: a `tools/` file, a builtin, an
 * MCP server, a roster (a speaking entry's own tools, the minted `handoff` and
 * `delegate`), a subagent's private map, and — as an EXECUTOR rather than a
 * source — the browser, for a `clientTool`. Each used to arrive as a bare
 * `ToolDef` with its gate baked into a wrapped `execute` and its executor
 * inferred from a brand at dispatch. Now each is a {@link Toolset}: what it
 * advertises ({@link Toolset.list}), whether a call may run NOW
 * ({@link Toolset.gate}), and how it runs ({@link Toolset.execute}).
 * `agentToolsToSchemas` and `executeToolCall` read nothing else.
 *
 * - **The executor is a property of the ENTRY** ({@link ToolsetEntry.executor}),
 *   decided once when a set is built. {@link toolEntry} is the only code that
 *   inspects a def's identity (the `clientTool` brand), so swapping that brand
 *   for a wire contract is a one-function change.
 * - **A refusal is a {@link ToolRefusal}** — one shape, one `reason`
 *   discriminant, whoever declined: a roster entry that is not speaking
 *   (`"persona"`, its set's gate), a dialog tool outside its `when` states
 *   (`"dialog"`, the minted def's own `execute`).
 * - **Composition is first-wins** ({@link composeToolsets}), and the order is
 *   the precedence: an agent's own files, then what `agent()` minted, then MCP,
 *   then builtins — so a file shadows a builtin and a remote tool never shadows
 *   anything an author wrote.
 *
 * @module toolset
 */

import { clientToolBrand } from "./client-tool.ts";
import type { ToolContext } from "./tool-context.ts";
import type { ToolDef, ToolMap } from "./tool-def.ts";
import type { ToolRefusal } from "./utils.ts";

/**
 * Where a {@link Toolset}'s tools come from — for a log line, a collision
 * message, and a spec. It decides nothing about execution; the entry does.
 *
 * @public
 */
export type ToolSource = "files" | "builtin" | "mcp" | "roster" | "subagent";

/**
 * Who runs a tool's body: this process (`"host"`), or the connected browser page
 * (`"client"`, a `clientTool` — the call waits for the page's `tool_result`).
 *
 * @public
 */
export type ToolExecutor = "host" | "client";

/** One advertised tool: the def the model reads, and who executes it. @public */
export interface ToolsetEntry {
  /** Description, schema, `messages` and `onError` — what the model and the executor read. */
  readonly def: ToolDef;
  readonly executor: ToolExecutor;
  /** A per-call deadline the entry carries (a `clientTool`'s `timeoutMs`). */
  readonly timeoutMs?: number | undefined;
}

/**
 * A source of tools, as the runtime consumes it.
 *
 * The advertised list is fixed per session on every transport (an S2S service
 * holds its tool list for the whole session), so a rule about WHEN a tool may
 * run is a {@link Toolset.gate} at the call — which is also where the model is
 * told why, and how to recover.
 *
 * @public
 */
export interface Toolset {
  readonly source: ToolSource;
  /** Every tool this set advertises, by the name the model calls. */
  list(): Readonly<Record<string, ToolsetEntry>>;
  /** `undefined` when `name` may run now; otherwise the refusal the model reads. */
  gate(name: string, ctx: ToolContext): ToolRefusal | undefined;
  /** Run `name`'s body with already-validated arguments. Gating is the caller's. */
  execute(name: string, args: unknown, ctx: ToolContext): unknown;
}

/** A gate over one def — what {@link toolset} composes into {@link Toolset.gate}. @public */
export type ToolGate = (name: string, def: ToolDef, ctx: ToolContext) => ToolRefusal | undefined;

/**
 * Classify one def into an entry: the ONE place a def's identity is inspected.
 * A `clientTool` (its brand) is executed by the page; everything else here.
 *
 * @public
 */
export function toolEntry(def: ToolDef): ToolsetEntry {
  const brand = clientToolBrand(def);
  return brand === undefined
    ? { def, executor: "host" }
    : { def, executor: "client", timeoutMs: brand.timeoutMs };
}

/**
 * Build a {@link Toolset} over a map of defs, optionally gated.
 *
 * @public
 */
export function toolset(source: ToolSource, tools: ToolMap, gate?: ToolGate): Toolset {
  const entries: Record<string, ToolsetEntry> = {};
  for (const [name, def] of Object.entries(tools)) entries[name] = toolEntry(def);
  const entryOf = (name: string): ToolsetEntry => {
    const entry = entries[name];
    if (entry === undefined) throw new Error(`This ${source} toolset has no tool "${name}".`);
    return entry;
  };
  return {
    source,
    list: () => entries,
    gate: (name, ctx) => (gate === undefined ? undefined : gate(name, entryOf(name).def, ctx)),
    // `args` was validated against this def's own schema by the caller.
    execute: (name, args, ctx) => entryOf(name).def.execute(args as Record<string, unknown>, ctx),
  };
}

/**
 * Layer extra gates over a set — every gate must pass, the set's own first.
 *
 * @public
 */
export function gateToolset(set: Toolset, gates: readonly ToolGate[]): Toolset {
  if (gates.length === 0) return set;
  return {
    source: set.source,
    list: () => set.list(),
    gate(name, ctx) {
      const own = set.gate(name, ctx);
      if (own !== undefined) return own;
      const def = set.list()[name]?.def;
      if (def === undefined) return;
      for (const gate of gates) {
        const refusal = gate(name, def, ctx);
        if (refusal !== undefined) return refusal;
      }
    },
    execute: (name, args, ctx) => set.execute(name, args, ctx),
  };
}

/** One resolved name in a {@link ToolTable}. @public */
export interface ResolvedTool {
  readonly name: string;
  readonly toolset: Toolset;
  readonly entry: ToolsetEntry;
}

/** Several toolsets composed into one name → tool lookup. @public */
export interface ToolTable {
  /** Every advertised tool, in precedence order. */
  readonly tools: readonly ResolvedTool[];
  resolve(name: string): ResolvedTool | undefined;
}

/**
 * Compose toolsets, FIRST WINS: a later set's tool of an already-taken name is
 * dropped, and `onShadowed` hears about it — the precedence is the order.
 *
 * @public
 */
export function composeToolsets(
  sets: readonly Toolset[],
  onShadowed?: (name: string, kept: ToolSource, dropped: ToolSource) => void,
): ToolTable {
  const byName = new Map<string, ResolvedTool>();
  for (const set of sets) {
    for (const [name, entry] of Object.entries(set.list())) {
      const kept = byName.get(name);
      if (kept !== undefined) {
        onShadowed?.(name, kept.toolset.source, set.source);
        continue;
      }
      byName.set(name, { name, toolset: set, entry });
    }
  }
  return { tools: [...byName.values()], resolve: (name) => byName.get(name) };
}

/** What {@link agentToolsets} reads off a definition. @public */
export interface ToolBearingDef {
  readonly tools: ToolMap;
  readonly toolsets?: readonly Toolset[] | undefined;
}

/**
 * Every toolset an agent definition carries, in precedence order: its `tools/`
 * files, then what `agent()` and a host step attached (`toolsets` — the roster,
 * MCP). A `dialog.tool` needs no layer here: its own `execute` refuses out of
 * state, and that check travels with the def wherever it is declared — a spec,
 * a subagent, a direct call. Builtins are the runtime's to append, since they
 * resolve against host options.
 *
 * @public
 */
export function agentToolsets(def: ToolBearingDef): Toolset[] {
  return [toolset("files", def.tools), ...(def.toolsets ?? [])];
}
