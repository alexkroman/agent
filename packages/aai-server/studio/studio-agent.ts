// Copyright 2025 the AAI authors. MIT license.
/**
 * The studio's coding agent — a TypeScript agent loop (Vercel AI SDK
 * `streamText`, the same stack pipeline mode uses) with workspace file tools
 * and a sandboxed test tool, streamed to the browser as the AI SDK UI message
 * stream.
 *
 * Publishing is deliberately *not* a tool: the agent edits and tests, the user
 * decides when it goes live via the Publish button (`POST /studio/projects/
 * :project/deploy`).
 *
 * LLM selection lives in `studio-llm.ts` — platform-owned host config. There
 * is no per-request override: the studio runs on the host's configured model.
 */

import { errorMessage } from "@alexkroman1/aai";
import {
  convertToModelMessages,
  type LanguageModel,
  stepCountIs,
  streamText,
  tool,
  type UIMessage,
} from "ai";
import type { Storage } from "unstorage";
import { z } from "zod";
import { IsolateConfigSchema } from "../rpc-schemas.ts";
import { bundleWorkspaceWorker } from "./studio-bundle.ts";
import { applyEdit, StudioEditError } from "./studio-edit.ts";
import { StudioBuildError } from "./studio-errors.ts";
import { grepWorkspace, StudioGrepError } from "./studio-grep.ts";
import { studioModel } from "./studio-llm.ts";
import { type McpSession, openMcpTools } from "./studio-mcp.ts";
import { studioSystemPrompt } from "./studio-prompt.ts";
import type { StudioSandbox } from "./studio-sandbox.ts";
import { createWebTools } from "./studio-web.ts";
import { getWorkspace, putWorkspace } from "./studio-workspace.ts";
import { withWorkspaceDir } from "./studio-workspace-dir.ts";

const MAX_CHAT_STEPS = 16;

export type StudioChatDeps = {
  storage: Storage;
  scope: string;
  project: string;
  /**
   * Lazy handle to this chat session's sandbox — the same warm-pool/gVisor
   * infrastructure deployed agents run in. Used by test_agent, and reused by
   * the deploy route for config extraction. Provisioned on first use.
   */
  sandbox: () => Promise<StudioSandbox>;
  /** Tears down the session sandbox if one was provisioned. Idempotent. */
  disposeSandbox?: () => Promise<void>;
  /** Injectable for tests — defaults to the host-env selected provider. */
  model?: LanguageModel;
  /** Injectable for tests — defaults to the configured MCP servers. */
  mcp?: McpSession;
};

type WorkspaceEdit = (files: Record<string, string>) => string | Promise<string>;

/** Build the workspace, load it in the session sandbox, and report back. */
async function runTrial(
  deps: StudioChatDeps,
  trialTool: string | undefined,
  args: Record<string, unknown> | undefined,
): Promise<string> {
  const workspace = await getWorkspace(deps.storage, deps.scope, deps.project);
  if (!workspace) return `Error: project ${deps.project} not found`;
  let worker: string;
  try {
    worker = await withWorkspaceDir(workspace.files, bundleWorkspaceWorker);
  } catch (err) {
    if (err instanceof StudioBuildError) return err.message;
    throw err;
  }
  const sandbox = await deps.sandbox();
  let loaded: { config?: unknown };
  try {
    loaded = await sandbox.loadBundle(worker);
  } catch (err) {
    // Also log host-side. This value is returned to the model as a tool
    // result, so without a log a failing sandbox leaves nothing in the
    // server's logs to debug from.
    console.warn("Studio trial: bundle/load failed", {
      project: deps.project,
      error: errorMessage(err),
    });
    return `Bundle failed to load in the sandbox: ${errorMessage(err)}`;
  }
  const parsed = IsolateConfigSchema.safeParse(loaded.config);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => i.message).join("; ");
    return `Bundle loaded but the agent config is invalid: ${issues}`;
  }
  const config = parsed.data;
  const toolNames = config.toolSchemas.map((schema) => schema.name);
  const summary =
    `Bundle loaded in the sandbox. Agent "${config.name}" (${config.mode ?? "s2s"} mode), ` +
    `tools: ${toolNames.length > 0 ? toolNames.join(", ") : "(none)"}.`;
  if (!trialTool) return summary;
  if (!toolNames.includes(trialTool)) {
    return `${summary}\nCannot invoke "${trialTool}": not one of the agent's tools.`;
  }
  const output = await sandbox.executeTool(trialTool, args ?? {});
  return `${summary}\n${trialTool}(${JSON.stringify(args ?? {})}) → ${output}`;
}

/**
 * Build the coding agent's tool set. Every file tool re-reads the workspace
 * so edits are write-through — the browser sees them immediately and a
 * Publish always builds the latest files.
 */
export function createStudioTools(deps: StudioChatDeps) {
  const { storage, scope, project } = deps;

  async function withFiles(edit: WorkspaceEdit): Promise<string> {
    const workspace = await getWorkspace(storage, scope, project);
    if (!workspace) return `Error: project ${project} not found`;
    const files = { ...workspace.files };
    try {
      const message = await edit(files);
      await putWorkspace(storage, scope, project, { ...workspace, files });
      return message;
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  return {
    list_files: tool({
      description: "List the files in the project workspace",
      inputSchema: z.object({}),
      execute: async () => {
        const workspace = await getWorkspace(storage, scope, project);
        if (!workspace) return `Error: project ${project} not found`;
        const paths = Object.keys(workspace.files).sort();
        return paths.length > 0 ? paths.join("\n") : "(empty workspace)";
      },
    }),
    read_file: tool({
      description: "Read a file from the project workspace",
      inputSchema: z.object({ path: z.string().describe("Workspace-relative path") }),
      execute: async ({ path }) => {
        const workspace = await getWorkspace(storage, scope, project);
        const content = workspace?.files[path];
        return content === undefined ? `Error: no such file: ${path}` : content;
      },
    }),
    grep: tool({
      description:
        "Search file contents across the workspace. Returns `path:line: text` " +
        "for each match. Cheaper than reading whole files to find where " +
        "something is defined.",
      inputSchema: z.object({
        pattern: z.string().describe("Regex, or plain text when literal is true"),
        glob: z.string().optional().describe("Only search paths matching this glob, e.g. *.ts"),
        literal: z.boolean().optional().describe("Match the pattern as plain text"),
        ignoreCase: z.boolean().optional(),
        context: z.number().optional().describe("Lines of context around each match"),
        limit: z.number().optional().describe("Max matches (default 100)"),
      }),
      execute: async ({ pattern, ...opts }) => {
        const workspace = await getWorkspace(storage, scope, project);
        if (!workspace) return `Error: project ${project} not found`;
        try {
          return grepWorkspace(workspace.files, pattern, opts);
        } catch (err) {
          // A bad pattern is the agent's to fix, so hand back the reason.
          if (err instanceof StudioGrepError) return `Error: ${err.message}`;
          throw err;
        }
      },
    }),
    edit_file: tool({
      description:
        "Replace an exact snippet in a workspace file. Prefer this over " +
        "write_file for changes to an existing file — write_file rewrites the " +
        "whole thing, which is slow and risks dropping code you meant to keep. " +
        "oldText must appear exactly once; include surrounding lines if it " +
        "would otherwise be ambiguous. Returns a diff of what changed.",
      inputSchema: z.object({
        path: z.string().describe("Workspace-relative path"),
        oldText: z.string().describe("Exact text to replace; must be unique in the file"),
        newText: z.string().describe("Replacement text"),
      }),
      execute: ({ path, oldText, newText }) =>
        withFiles((files) => {
          const current = files[path];
          if (current === undefined) return `Error: no such file: ${path}`;
          try {
            const { content, diff } = applyEdit(path, current, oldText, newText);
            files[path] = content;
            return `Edited ${path}\n\n${diff}`;
          } catch (err) {
            // A failed match is the agent's cue to re-read and retry with more
            // context, so surface the reason rather than throwing.
            if (err instanceof StudioEditError) return `Error: ${err.message}`;
            throw err;
          }
        }),
    }),
    write_file: tool({
      description:
        "Create a new file, or fully replace one. For edits to an existing " +
        "file prefer edit_file.",
      inputSchema: z.object({
        path: z.string().describe("Workspace-relative path"),
        content: z.string().describe("Full new file contents"),
      }),
      execute: ({ path, content }) =>
        withFiles((files) => {
          files[path] = content;
          return `Wrote ${path} (${content.length} bytes)`;
        }),
    }),
    delete_file: tool({
      description: "Delete a file from the project workspace",
      inputSchema: z.object({ path: z.string() }),
      execute: ({ path }) =>
        withFiles((files) => {
          if (!(path in files)) return `Error: no such file: ${path}`;
          delete files[path];
          return `Deleted ${path}`;
        }),
    }),
    test_agent: tool({
      description:
        "Build the workspace and load it into a sandbox running the exact " +
        "production runtime (gVisor + Deno, no network/filesystem). Reports " +
        "build errors, load errors, and the extracted agent config. Pass " +
        "`tool` and `args` to also invoke one of the agent's tools with " +
        "sample arguments and see its result. Secrets are NOT available in " +
        "test runs (ctx.env is empty); KV is a scratch store.",
      inputSchema: z.object({
        tool: z.string().optional().describe("Name of an agent tool to invoke after loading"),
        args: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Arguments for the invoked tool"),
      }),
      execute: ({ tool: trialTool, args }) => runTrial(deps, trialTool, args),
    }),
  };
}

/**
 * Run one coding-agent turn and return a `useChat`-compatible Response (the
 * AI SDK UI message stream over SSE). The client resends the full UIMessage
 * history each turn, so the server stays stateless between requests.
 *
 * The session sandbox (if any tool provisioned one) and the MCP clients are
 * disposed when the stream settles — finish, error, and client abort all
 * funnel through `onFinish`/`onError` of the UI stream response.
 */
export async function runStudioChat(
  deps: StudioChatDeps,
  messages: UIMessage[],
): Promise<Response> {
  // Never fails: an unreachable server yields no tools rather than an error.
  const mcp = deps.mcp ?? (await openMcpTools());
  let disposeCalled = false;
  const disposeSandbox = () => {
    if (disposeCalled) return;
    disposeCalled = true;
    void deps.disposeSandbox?.();
    void mcp.close();
  };
  try {
    const result = streamText({
      model: deps.model ?? studioModel(),
      system: studioSystemPrompt(),
      messages: await convertToModelMessages(messages, { ignoreIncompleteToolCalls: true }),
      // Studio tools last: neither an MCP server nor a web builtin may
      // shadow write_file.
      tools: { ...mcp.tools, ...createWebTools(), ...createStudioTools(deps) },
      stopWhen: stepCountIs(MAX_CHAT_STEPS),
      onFinish: disposeSandbox,
      onAbort: disposeSandbox,
      onError: disposeSandbox,
    });
    return result.toUIMessageStreamResponse({
      onError: (error) => {
        disposeSandbox();
        return error instanceof Error ? error.message : String(error);
      },
    });
  } catch (err) {
    disposeSandbox();
    throw err;
  }
}
