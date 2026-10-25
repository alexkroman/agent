// Copyright 2026 the AAI authors. MIT license.
/**
 * A tool's display hint (`ToolDef.ui`) on its way to a page: the wire shape,
 * the normalizer `agentToolsToSchemas` runs, and the per-agent map the
 * pre-connection client config carries.
 *
 * Its own module, and a ZOD-FREE one, because of who builds the map: every
 * server that answers `GET /client-config` does — `aai dev`, `createAgentServer`
 * and the guest harness, which is bundled with `@alexkroman1/aai/internal` and
 * `/utils` and may not drag a validator into the sandbox artifact. The zod
 * mirror (`ToolUiSchema`) stays beside `ToolSchemaSchema` in `tool-schema.ts`.
 *
 * @module
 */

import { omitUndefined } from "./omit-undefined.ts";
import type { ToolUi } from "./tool-def.ts";
import { agentToolsets, composeToolsets, type ToolBearingDef, type Toolset } from "./toolset.ts";

/**
 * What {@link toolUiMap} reads off an agent: each tool's `ui`, and the
 * toolsets `agent()` attached. Structural and no wider than that, so the guest
 * harness's MIRROR of `AgentDef` (`aai-guest-core/types.ts`, which carries
 * no `inputSchema` and its own `ToolContext`) satisfies it without a cast at
 * the call site — every `AgentDef` does by construction.
 *
 * @internal
 */
export type ToolUiSource = {
  readonly tools: Readonly<Record<string, { readonly ui?: ToolUi | undefined }>>;
  readonly toolsets?: readonly Toolset[] | undefined;
};

/**
 * The display hint a `ToolDef.ui` becomes on the wire — the two fields, with
 * an undeclared one OMITTED, or `undefined` when neither is declared so the
 * key stays off an ordinary tool's declaration (`ToolSchemaSchema` is what a
 * stored config round-trips through, and `undefined` is not JSON).
 *
 * @internal
 */
export function normalizeToolUi(ui: ToolUi | undefined): ToolUi | undefined {
  if (ui === undefined) return undefined;
  const wire = omitUndefined({ icon: ui.icon, label: ui.label });
  return Object.keys(wire).length === 0 ? undefined : wire;
}

/**
 * Every tool's display hint, keyed by the name the model calls — what
 * `GET /client-config` carries as `tools`, so a page learns each tool's icon
 * and label before the first call. Takes the agent definition and reads its
 * composed toolsets exactly as `agentToolsToSchemas` does (first wins),
 * converting no schema on the way — which is what lets the guest harness
 * build it across the bundle seam with its own copy of the SDK, the toolsets
 * being plain data. `undefined` when no tool declares one, which keeps the
 * body of an agent without hints byte-identical to what it was before the
 * field existed.
 *
 * @internal
 */
export function toolUiMap(agent: ToolUiSource): Record<string, ToolUi> | undefined {
  const map: Record<string, ToolUi> = {};
  // Narrowed to what `agentToolsets` wants: the composition reads each entry's
  // `def` back out, and `ui` is the only field of it read here.
  const toolsets = agentToolsets(agent as ToolBearingDef);
  for (const { name, entry } of composeToolsets(toolsets).tools) {
    const ui = normalizeToolUi(entry.def.ui);
    if (ui !== undefined) map[name] = ui;
  }
  return Object.keys(map).length === 0 ? undefined : map;
}
