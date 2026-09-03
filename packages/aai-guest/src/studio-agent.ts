// Copyright 2026 the AAI authors. MIT license.
/**
 * The studio coding agent, as an `agent()` definition.
 *
 * The studio builds voice agents with this SDK, and until this module existed
 * it was the one agent in the repo that did not use it: `studio-chat.ts`
 * assembled a `streamText` call by hand — resolving the model, adapting the
 * SDK's web builtins into AI SDK tools, wrapping every tool in its own
 * deadline, carrying its own tool-call repair, and re-deriving the
 * forced-final-answer rule. All of that is what `agent()` plus
 * `createTextAgent` already are, so it is now spelled the way a user's agent
 * is spelled, and the drift that a second copy invites cannot happen.
 *
 * Two properties of the definition are worth stating, because they are the
 * ones a reader would otherwise have to infer:
 *
 * - **`text: true`.** The coding agent has no audio path at all; declaring
 *   the mode is what makes `createTextAgent` accept it, and what makes
 *   `createRuntime` refuse it.
 * - **The web builtins are NAMED, not adapted.** `builtinTools` is the
 *   supported way to reach `visit_webpage` / `get_page_design` /
 *   `web_search`, and it lands them in the same executor as everything else,
 *   with a real `ctx` — the hand-written adapter this replaces had to
 *   fabricate a context whose `db` and `generate` both rejected.
 * - **The tools go on with `withTools`, because they are not files.** A user's
 *   agent declares no tools at all: `tools/` IS the list, enumerated where the
 *   bundle is assembled, and `agent({ tools })` is a compile error naming the
 *   file to create. These families cannot be files — almost every one of them
 *   closes over ONE session's workspace directory and its type-check runner, and
 *   they are built per turn precisely so a re-installed session cannot serve
 *   tools bound to the previous tree. `withTools` is the seam a resolved
 *   registry goes on through, and that is what this is: a registry resolved from
 *   the session rather than from a directory. (`read_logs` closes over nothing —
 *   it asks the HOST, which resolves the project from the sandbox's own pinned
 *   identity — and joins here because the registry is where the tool set is.)
 */

import { type AgentDef, agent, type BuiltinTool } from "@alexkroman1/aai";
import { assemblyAILlm } from "@alexkroman1/aai/llm";
import { withTools } from "@alexkroman1/aai/manifest";
import type { HarnessBundleAccess } from "./harness-types.ts";
import { buildWorkspaceDir } from "./studio-build.ts";
import { createLogsTool } from "./studio-logs-tool.ts";
import { createDesignInspirationTool, createProjectTools } from "./studio-project-tools.ts";
import type { StudioSession } from "./studio-session.ts";
import { createTemplateTools } from "./studio-template-tools.ts";
import { createStudioTools } from "./studio-tools.ts";
import { createPostWriteDiagnostics, type TypecheckFn } from "./studio-write-diagnostics.ts";

/**
 * Per-call deadline for every coding-agent tool — passed to
 * `createTextAgent` rather than wrapped around each tool, so one number
 * covers the workspace tools, the project tools, the template tools and the
 * web builtins alike.
 *
 * Well above the SDK's 30s default, which is a VOICE budget: past it a caller
 * is listening to silence, so a slow tool is already a failed turn. Nobody is
 * on a phone here, and these are the long tools — an npm install, a type
 * check, a shell command.
 */
export const STUDIO_TOOL_TIMEOUT_MS = 120_000;

/**
 * The keyless network builtins the coding agent may use. They run in the
 * guest with open egress like all tenant code; `safeFetch` still screens the
 * model-controlled URLs.
 */
const STUDIO_BUILTIN_TOOLS: readonly BuiltinTool[] = [
  "visit_webpage",
  "get_page_design",
  "web_search",
];

/** What the agent's tools need from the harness, beyond the session itself. */
export type StudioAgentDeps = HarnessBundleAccess & {
  /** The workspace type check backing post-write diagnostics. */
  typecheck: TypecheckFn;
};

/**
 * Build the coding agent for one session's workspace.
 *
 * Built per turn, like the tool set it replaces: the tools close over the
 * session directory and over one type-check runner, and rebuilding is what
 * keeps a re-installed session (a page refresh, a replica taking over) from
 * serving tools bound to the previous tree.
 */
export function createStudioAgent(session: StudioSession, deps: StudioAgentDeps): AgentDef {
  const { dir } = session;
  // ONE checker for both write-shaped tool families. It hangs off a coalescing
  // runner, and the whole point of that runner is that concurrent writes share
  // a single follow-up compiler pass — which two independent runners cannot do,
  // so building it per family silently doubled the `tsc` runs a parallel burst
  // of `write_file` + `use_template` costs.
  const diagnostics = createPostWriteDiagnostics(deps.typecheck);
  const authored = agent({
    name: "AAI Studio",
    text: true,
    systemPrompt: session.system,
    // The model is host configuration delivered by `studio/session-init`; the
    // KEY is the caller's own and rides in as `providerEnv`, never here.
    llm: assemblyAILlm({
      model: session.model,
      ...(session.region === "eu" ? { region: "eu" as const } : {}),
    }),
    maxSteps: session.maxSteps,
    builtinTools: STUDIO_BUILTIN_TOOLS,
  });
  // Studio tools last: a web builtin may never shadow `write_file`. (The
  // SDK's own merge already gives a declared tool priority over a builtin
  // of the same name; this ordering is about the three studio families.)
  return withTools(authored, {
    ...createDesignInspirationTool(),
    // Reads the project's DEPLOYED agent, over the host control channel — the
    // one tool here that looks outside this sandbox, and so the only one that
    // closes over nothing (see studio-logs-tool.ts).
    ...createLogsTool(),
    ...createProjectTools({ dir }),
    ...createTemplateTools({
      dir,
      // The same checker the write tools use — see above.
      diagnostics,
    }),
    ...createStudioTools({
      dir,
      // Post-write diagnostics: the same tsc pass builds run, so a type
      // error reaches the agent inside the write result that caused it.
      diagnostics,
      // Build the live session workspace in place, in THIS sandbox,
      // through the same CLI bundler pass `aai deploy` runs.
      build: () => buildWorkspaceDir(dir, { worker: true, client: false }),
      loadBundle: deps.loadBundle,
      executeTool: deps.executeTool,
    }),
  });
}
