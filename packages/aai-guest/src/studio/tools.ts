// Copyright 2026 the AAI authors. MIT license.
/**
 * The studio coding agent's workspace tool set — executed INSIDE the guest
 * sandbox.
 *
 * The nine workspace tools are the SDK's (`@alexkroman1/aai/coding-tools`):
 * read, search, write, edit, delete, run. They used to be spelled out here,
 * and nothing about a file tool was ever studio-shaped — what IS studio-shaped
 * is the three seams this module fills in, and `test_agent`, which is the one
 * tool that knows the workspace is an aai agent:
 *
 * - **`validate`** refuses a write that does not PARSE (studio/syntax.ts). A
 *   file that does not parse cannot be edited back into shape by text
 *   matching, so writing it strands the turn.
 * - **`afterWrite`** appends the workspace's type errors to the write that
 *   caused them (studio/write-diagnostics.ts), which is where a repair round
 *   is actually saved.
 * - **`env`** is `workspaceChildEnv()`, the 24-name allow-list — the SDK's
 *   default is this process's own environment, which is right for a CLI on a
 *   developer's machine and wrong for a guest holding a control-channel
 *   bearer.
 *
 * Every tool still operates on a real filesystem workspace (materialized by
 * `studio/session-init`) in the tenant's own container: a hostile regex, a
 * pathological diff, or a runaway `bash` command costs this sandbox's CPU and
 * nothing else — the Modal container is the isolation boundary, exactly as it
 * is for deployed agents' tools.
 *
 * `test_agent` builds IN THE GUEST through the aai CLI's own bundlers
 * (studio/build.ts — the toolchain's node_modules are baked next to the
 * harness) and then loads and trials the bundle locally via the harness's own
 * loader. One build path with `aai deploy`, exercised on every call.
 */

import { errorMessage, type ToolDef, tool } from "@alexkroman1/aai";
import { createCodingTools } from "@alexkroman1/aai/coding-tools";
import { z } from "zod";
import type { HarnessBundleAccess } from "../harness/types.ts";
import { workspaceChildEnv } from "./spawn.ts";
import { formatRejection, syntaxError } from "./syntax.ts";
import { formatTestRun, runWorkspaceTests } from "./test.ts";
import { STUDIO_CODING_TOOL_DESCRIPTIONS, STUDIO_TOOL_DESCRIPTIONS } from "./tool-descriptions.ts";
import type { PostWriteDiagnostics } from "./write-diagnostics.ts";

/**
 * User-friendly labels for every studio tool, web builtins included —
 * served to the browser via the chat surface's `GET /studio/tools` so the
 * UI never shows a raw snake_case tool name. One map, guest-side, because
 * the guest is where the tool set is assembled.
 */
export const STUDIO_TOOL_LABELS: Readonly<Record<string, string>> = {
  list_files: "List files",
  read_file: "Read file",
  write_file: "Write file",
  edit_file: "Edit file",
  delete_file: "Delete file",
  grep: "Search code",
  glob: "Find files",
  bash: "Run command",
  npm_info: "Look up package",
  add_dependency: "Add dependency",
  remove_dependency: "Remove dependency",
  update_dependencies: "Update dependencies",
  download_to_workspace: "Download file",
  list_templates: "List templates",
  use_template: "Use template",
  generate_design_inspiration: "Design inspiration",
  todo_write: "Update plan",
  read_logs: "Read agent logs",
  test_agent: "Test agent",
  web_search: "Search the web",
  visit_webpage: "Read webpage",
  get_page_design: "Study page design",
};

export type StudioToolDeps = HarnessBundleAccess & {
  /** Absolute workspace root the session materialized. */
  dir: string;
  /** The shared post-write checker — same instance the template tools use. */
  diagnostics: PostWriteDiagnostics;
  /** Build the session workspace into a worker bundle, in this sandbox. */
  build: () => Promise<{ worker?: string; buildError?: string }>;
};

/**
 * Shown when a built agent turns out to be S2S.
 *
 * The preamble states the cascaded-pipeline default about as plainly as prose
 * can, and agents still shipped S2S in roughly one run in seven — a rule read
 * once at the top of a long turn loses to whatever the model reached for.
 * Since the pipeline-by-default flip, S2S can no longer happen by omission
 * (a provider-less agent gets the pipeline injected) — reaching S2S now means
 * the agent *wrote* `s2s: assemblyAIS2s()`, so the notice checks that the
 * request actually asked for it. It fires at the only moment the mistake is
 * visible and cheap: the agent has just seen its own config and has not yet
 * told the user it is done.
 *
 * It asks the agent to re-read the request rather than to switch, because S2S
 * is correct when it was asked for, and a nudge that overrode that would trade
 * one wrong mode for another.
 */
const S2S_NOTICE =
  "\nNote: this agent is S2S because it sets the s2s field. That is " +
  "right ONLY if the request asked for the voice agent API (or " +
  "speech-to-speech) by name. Re-read the request: if it did not, this is " +
  "the wrong mode — remove the s2s field (the default is the all-AssemblyAI " +
  "pipeline) and build again. If it did, S2S is correct and there is " +
  "nothing to change.";

/** Summarize a loaded bundle's self-described config without server schemas. */
function describeConfig(config: unknown): { summary: string; toolNames: string[] } {
  const cfg = (config ?? {}) as {
    name?: unknown;
    mode?: unknown;
    toolSchemas?: { name?: unknown }[];
  };
  const toolNames = Array.isArray(cfg.toolSchemas)
    ? cfg.toolSchemas.map((schema) => String(schema?.name ?? "")).filter(Boolean)
    : [];
  const name = typeof cfg.name === "string" ? cfg.name : "(unnamed)";
  const isPipeline = cfg.mode === "pipeline";
  const summary =
    `Bundle loaded in the sandbox. Agent "${name}" (${isPipeline ? "pipeline" : "s2s"} mode), ` +
    `tools: ${toolNames.length > 0 ? toolNames.join(", ") : "(none)"}.` +
    (isPipeline ? "" : S2S_NOTICE);
  return { summary, toolNames };
}

/** Build the coding agent's workspace tool set over the session dir. */
export function createStudioTools(deps: StudioToolDeps): Record<string, ToolDef> {
  const { dir, diagnostics: postWriteDiagnostics } = deps;
  return {
    ...createCodingTools({
      dir,
      descriptions: STUDIO_CODING_TOOL_DESCRIPTIONS,
      // Parse BEFORE persisting — see studio/syntax.ts. The message is the
      // whole tool result, so it names the fix rather than only the fault.
      validate: async (rel, content) => {
        const bad = await syntaxError(dir, rel, content);
        return bad === undefined ? undefined : formatRejection(rel, bad);
      },
      // Post-write diagnostics: the same tsc pass builds run, so a type error
      // reaches the agent inside the write result that caused it.
      afterWrite: postWriteDiagnostics,
      // Never `process.env`: the control-channel bearer and every future boot
      // key are out by construction rather than by remembering to subtract.
      env: workspaceChildEnv(),
    }),
    test_agent: tool({
      description: STUDIO_TOOL_DESCRIPTIONS.test_agent,
      inputSchema: z.object({
        tool: z.string().optional().describe("Name of an agent tool to invoke after loading"),
        args: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Arguments for the invoked tool"),
      }),
      execute: async ({ tool: trialTool, args }) => {
        const built = await deps.build();
        if (built.buildError) return built.buildError;
        if (!built.worker) return "Error: build returned no worker bundle";
        let loaded: { config?: unknown };
        try {
          loaded = await deps.loadBundle(built.worker);
        } catch (err) {
          return `Bundle failed to load: ${errorMessage(err)}`;
        }
        const { summary, toolNames } = describeConfig(loaded.config);
        // Reported after the config rather than gating on it: a failing test
        // usually means the test and the agent drifted, which the agent can
        // only judge with the config in front of it.
        const tests = formatTestRun(await runWorkspaceTests(dir));
        const base = `${summary}\n${tests}`;
        if (!trialTool) return base;
        if (!toolNames.includes(trialTool)) {
          return `${base}\nCannot invoke "${trialTool}": not one of the agent's tools.`;
        }
        const output = await deps.executeTool(trialTool, args ?? {});
        return `${base}\n${trialTool}(${JSON.stringify(args ?? {})}) → ${output}`;
      },
    }),
  };
}
