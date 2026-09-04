// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai-runtime:tools` epoch 1.
 *
 * At epoch 1 this capability was one name. `withToolsDir` is how a plain Node
 * process — a self-hosted `server.mjs`, with no bundler anywhere in its path —
 * finds the tools an agent serves: the directory IS the registry, a file is a
 * tool, and this is the call that reads it. This is the shape a self-hoster
 * copies. Written the way it was authored at epoch 1, and it must keep
 * compiling for as long as that epoch is advertised as supported.
 *
 * ## What moved, and why epoch 1 survives it
 *
 * Epoch 2 adds MCP: `withMcpTools` and the twelve types around it, a SECOND
 * source of tools for a host that has no bundler either. Every one of them is a
 * new name — `withToolsDir`'s signature is untouched, and so is the shape of
 * what it returns. A host that discovers tools from a directory and declares no
 * `mcpServers` reaches none of the new surface and none of the new behaviour:
 * `withMcpTools` is a call an author makes, not a step the runtime takes on
 * their behalf. That is what makes this a retain rather than a drop.
 *
 * ## What this example is NOT
 *
 * It does not serve the agent — `createAgentServer` is the `server` capability,
 * and its own frozen examples cover the door. What is asserted here is that the
 * DEFINITION a host assembles still assembles, which is the whole of what this
 * capability promises.
 *
 * Editing this file to make a future error go away defeats the mechanism: the
 * error IS the finding, and it means epoch 1 has to be dropped with a reason.
 */

import { type AgentDef, agent } from "@alexkroman1/aai";
import { withToolsDir } from "../../../runtime-barrel.ts";

/** ── EDIT: the agent to serve. Its tools are FILES, never a field here. ── */
const support: AgentDef = agent({
  name: "Support",
  greeting: "Support desk — how can I help?",
  // The variables the agent's own tool code reads, checked at deploy time.
  requiredEnv: ["SUPPORT_API_KEY"],
});

/**
 * ── EDIT: where the tool files live. ─────────────────────────────────────
 *
 * A URL relative to THIS module rather than a path relative to the process's
 * working directory: a server started from anywhere still finds its own tools.
 * `tools/roll_die.ts` default-exporting `tool({ … })` is the tool `roll_die`;
 * adding one is adding a file, and this line does not change.
 */
const toolsDir = new URL("./tools/", import.meta.url);

/**
 * The definition a host serves: the agent above, plus every tool in the
 * directory.
 *
 * Async because a directory read is. A MISSING directory throws rather than
 * resolving to no tools — an agent whose tools never reached the model, with no
 * error anywhere, is the exact failure discovery replaced.
 */
export async function servedAgent(): Promise<AgentDef> {
  return await withToolsDir(support, toolsDir);
}
