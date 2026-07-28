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
 * LLM selection lives in `studio-llm.ts` — platform-owned host config, with
 * an optional per-request override the browser picks from `studioLlmOptions`.
 */

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
import { StudioBuildError } from "./studio-errors.ts";
import { studioModel } from "./studio-llm.ts";
import { studioSystemPrompt } from "./studio-prompt.ts";
import type { StudioSandbox } from "./studio-sandbox.ts";
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
  /**
   * Browser-picked provider/model for this turn. Already validated against
   * `studioLlmOptions` by the route; omitted means the host-env default.
   */
  llm?: { provider?: string | undefined; model?: string | undefined };
  /** Injectable for tests — defaults to the host-env selected provider. */
  model?: LanguageModel;
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
    return `Bundle failed to load in the sandbox: ${err instanceof Error ? err.message : String(err)}`;
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
    write_file: tool({
      description: "Create or overwrite a file in the project workspace",
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
 * The session sandbox (if any tool provisioned one) is disposed when the
 * stream settles — finish, error, and client abort all funnel through
 * `onFinish`/`onError` of the UI stream response.
 */
export async function runStudioChat(
  deps: StudioChatDeps,
  messages: UIMessage[],
): Promise<Response> {
  let disposeCalled = false;
  const disposeSandbox = () => {
    if (disposeCalled) return;
    disposeCalled = true;
    void deps.disposeSandbox?.();
  };
  try {
    const result = streamText({
      model: deps.model ?? studioModel(deps.llm ?? {}),
      system: studioSystemPrompt(),
      messages: await convertToModelMessages(messages, { ignoreIncompleteToolCalls: true }),
      tools: createStudioTools(deps),
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
