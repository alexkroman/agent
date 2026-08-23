// Copyright 2026 the AAI authors. MIT license.
/**
 * Epoch-1 template: `aai-runtime:tools`. A self-hosted process that finds its
 * agent's tools on disk, as a starter written at epoch 1 — copy this file into
 * your host, point {@link TOOLS_DIR} at your own directory, and keep the shape.
 *
 * FROZEN. It must keep compiling for as long as epoch 1 is supported, so
 * `pnpm typecheck` is the backward-compatibility gate and an error here IS the
 * finding. Do not edit it to make an error go away: an API that has to change
 * gets a NEW epoch carrying a new template, never a change to this one. The
 * imports are relative source paths because nothing ships this file.
 *
 * What this capability is for: a tool is registered by EXISTING — `tools/
 * roll_die.ts` IS the tool `roll_die`, and `agent()` refuses a `tools` argument
 * so that no second place can disagree with the filesystem. Turning a directory
 * into modules needs somebody who can read one, and on the two paths that ship
 * an agent that somebody is a bundler: the CLI's generated worker entry
 * enumerates `tools/*.ts` at build time, and a spec reaches the same shape
 * through `import.meta.glob`. A plain Node process has neither, which is what
 * {@link withToolsDir} is.
 *
 * What to change:
 *
 * - {@link TOOLS_DIR} — your directory. Relative to THIS module, which is what
 *   keeps it correct after the process is started from somewhere else.
 * - {@link assistant} — your agent. It declares no tools, on this path or any
 *   other.
 * - {@link resolveEnv} — where your credentials come from. Nothing falls back
 *   to the host's `process.env` on its own.
 *
 * What not to change: the call sits BEFORE the server is built, because the
 * definition a runtime is handed is the definition it runs — attaching tools
 * afterwards attaches them to nothing.
 */

import { agent } from "@alexkroman1/aai";
import { createAgentServer, withToolsDir } from "../../../runtime-barrel.ts";
import type { AgentServer } from "../../../server.ts";

/**
 * The directory every tool file lives in. ← point this at yours
 *
 * A URL against `import.meta.url` rather than a bare `"./tools"`: a relative
 * path is resolved against the process's working directory, so a server
 * started from anywhere but its own folder would find nothing — and finding no
 * tools is exactly the silence discovery exists to replace.
 */
export const TOOLS_DIR = new URL("./tools/", import.meta.url);

/**
 * The definition. ← your agent
 *
 * Note what is NOT here: any mention of a tool. `agent()` types a `tools`
 * argument as the message naming the file to create instead, because a map of
 * `name: import` restates what the directory already says and forgetting an
 * entry is silent — the file compiles, the lint passes, and the tool never
 * reaches the model.
 */
export const assistant = agent({
  name: "Support",
  system: "Help the caller. Use a tool rather than guessing.",
});

/**
 * The agent's own env — what tool code reads as `ctx.env`. ← your secret store
 *
 * A vault, a mounted file, a `.env` you parsed: assembling it is deliberate,
 * which is the property that makes a self-hosted agent's credentials auditable
 * at one call site.
 */
export function resolveEnv(): Record<string, string> {
  return { ASSEMBLYAI_API_KEY: process.env.ASSEMBLYAI_API_KEY ?? "" };
}

/**
 * Discover the tools and serve the agent that has them.
 *
 * The two failure modes this rules out are both silent ones. A missing
 * directory THROWS rather than resolving to an agent with no tools, and a file
 * that cannot be a tool — a name no provider would accept, a missing default
 * export, one hiding a directory deeper — is an error here at startup rather
 * than a capability the model was never offered.
 */
export async function serveWithTools(port: number): Promise<AgentServer> {
  const served = await withToolsDir(assistant, TOOLS_DIR);
  const server = createAgentServer({ agent: served, env: resolveEnv() });
  await server.listen(port);
  return server;
}

/**
 * The same discovery without the server, for a host wiring
 * `runtime.startSession(ws)` into an HTTP stack it already owns.
 *
 * `withToolsDir` hands back a NEW definition of the type it was given rather
 * than mutating the one the module default-exported — a loader quietly
 * rewriting that object would make the order of two imports decide what an
 * agent can do.
 */
export async function toolsFor<D extends { readonly tools: typeof assistant.tools }>(
  def: D,
): Promise<D> {
  return withToolsDir(def, TOOLS_DIR);
}
