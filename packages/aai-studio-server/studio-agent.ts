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
 * LLM selection lives in `studio-llm.ts` — platform-owned host config. A
 * request can never pick a provider or model or supply a key; every turn
 * runs on the host-configured default.
 */

import { errorMessage } from "@alexkroman1/aai";
import { IsolateConfigSchema } from "aai-server/rpc-schemas";
import type { WorkspaceStore } from "aai-server/workspace-store";
import {
  convertToModelMessages,
  type LanguageModel,
  stepCountIs,
  streamText,
  tool,
  type UIMessage,
} from "ai";
import { z } from "zod";
import { getCachedBuild, putCachedBuild } from "./studio-build-cache.ts";
import type { StudioBuildRunner } from "./studio-build-protocol.ts";
import { resolveStudioBuildRunner } from "./studio-build-runner.ts";
import { applyEdit, StudioEditError } from "./studio-edit.ts";
import { StudioBuildError } from "./studio-errors.ts";
import { grepWorkspace, StudioGrepError } from "./studio-grep.ts";
import { studioModel } from "./studio-llm.ts";
import { studioSystemPrompt } from "./studio-prompt.ts";
import type { StudioSandbox } from "./studio-sandbox.ts";
import { withToolTimeouts } from "./studio-tool-timeout.ts";
import { createWebTools } from "./studio-web.ts";
import { currentFilesHash } from "./studio-workspace.ts";
import { createWorkspaceSession, type WorkspaceSession } from "./studio-workspace-session.ts";

const MAX_CHAT_STEPS = 16;

export type StudioChatDeps = {
  workspaces: WorkspaceStore;
  scope: string;
  project: string;
  /**
   * Lazy handle to this chat session's sandbox — the same warm-pool/Modal
   * infrastructure deployed agents run in. Used by test_agent, and reused by
   * the deploy route for config extraction. Provisioned on first use.
   */
  sandbox: () => Promise<StudioSandbox>;
  /** Tears down the session sandbox if one was provisioned. Idempotent. */
  disposeSandbox?: () => Promise<void>;
  /**
   * Injectable for tests — defaults to the env-selected out-of-process build
   * runner (a local build subprocess in dev, the Modal build worker in
   * production; see `studio-build-runner.ts`).
   */
  build?: StudioBuildRunner;
  /** Test injection seam. Defaults to the host-env selection. */
  model?: LanguageModel;
  /**
   * Client-abort signal (the HTTP request's). Lets streamText stop the LLM
   * call and in-flight tool executions promptly instead of leaving them to
   * race the sandbox teardown.
   */
  abortSignal?: AbortSignal;
  /**
   * Persist the full updated conversation when the UI stream settles (the
   * request's messages plus the assistant's response). The route wires this
   * to the project's `ChatStore` row; a failure is logged, never fatal —
   * losing one snapshot must not cost the user their reply.
   */
  persistMessages?: (messages: UIMessage[]) => Promise<void>;
};

/** Invoke one agent tool in the sandbox, reporting failures as text. */
async function trialToolRun(
  sandbox: StudioSandbox,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  try {
    const output = await sandbox.executeTool(name, args);
    return `${name}(${JSON.stringify(args)}) → ${output}`;
  } catch (err) {
    // A stream abort disposes the sandbox mid round-trip; the pending RPC
    // rejects ("Connection disposed"). Answer as tool-result text rather
    // than letting the rejection rattle through the AI SDK tool machinery.
    return `Tool run failed: ${errorMessage(err)}`;
  }
}

/**
 * Build (or reuse) the trial's worker bundle. Content-hash keyed: a Publish
 * right after this trial reuses the worker instead of re-materializing and
 * re-running Vite (see studio-build-cache). A compile error comes back as a
 * message the coding agent can act on, not an exception.
 */
async function trialWorker(
  deps: StudioChatDeps,
  files: Record<string, string>,
  hash: string,
): Promise<{ worker: string } | { buildError: string }> {
  const cached = getCachedBuild(hash)?.worker;
  if (cached !== undefined) return { worker: cached };
  const build = deps.build ?? resolveStudioBuildRunner();
  let worker: string | undefined;
  try {
    ({ worker } = await build({ files, worker: true, client: false }));
  } catch (err) {
    if (err instanceof StudioBuildError) return { buildError: err.message };
    throw err;
  }
  if (worker === undefined) throw new Error("Build runner returned no worker bundle");
  putCachedBuild(hash, { worker });
  return { worker };
}

/** Build the workspace, load it in the session sandbox, and report back. */
async function runTrial(
  deps: StudioChatDeps,
  workspaces: WorkspaceSession,
  trialTool: string | undefined,
  args: Record<string, unknown> | undefined,
): Promise<string> {
  const workspace = await workspaces.current();
  if (!workspace) return `Error: project ${deps.project} not found`;
  const built = await trialWorker(deps, workspace.files, currentFilesHash(workspace));
  if ("buildError" in built) return built.buildError;
  const { worker } = built;
  let sandbox: StudioSandbox;
  try {
    sandbox = await deps.sandbox();
  } catch (err) {
    // Provisioning refused (spawn failure, or the turn was aborted and its
    // sandbox lifecycle already torn down) — answer as tool-result text.
    // Also log host-side: this text goes to the model, so without a log a
    // host that can't spawn sandboxes leaves nothing to debug from.
    console.warn("Studio trial: sandbox provisioning failed", {
      project: deps.project,
      error: errorMessage(err),
    });
    return `Sandbox unavailable: ${errorMessage(err)}`;
  }
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
  return `${summary}\n${await trialToolRun(sandbox, trialTool, args ?? {})}`;
}

/**
 * Build the coding agent's tool set. File tools share one per-turn
 * `WorkspaceSession`: reads come from an in-memory snapshot (one storage GET
 * per turn instead of one per tool step) while every mutation still writes
 * through — the browser sees edits immediately and a Publish always builds
 * the latest files.
 */
export function createStudioTools(
  deps: StudioChatDeps,
  workspaces: WorkspaceSession = createWorkspaceSession(deps.workspaces, deps.scope, deps.project),
) {
  const { project } = deps;
  const withFiles = workspaces.update;

  return {
    list_files: tool({
      description: "List the files in the project workspace",
      inputSchema: z.object({}),
      execute: async () => {
        const workspace = await workspaces.current();
        if (!workspace) return `Error: project ${project} not found`;
        const paths = Object.keys(workspace.files).sort();
        return paths.length > 0 ? paths.join("\n") : "(empty workspace)";
      },
    }),
    read_file: tool({
      description: "Read a file from the project workspace",
      inputSchema: z.object({ path: z.string().describe("Workspace-relative path") }),
      execute: async ({ path }) => {
        const workspace = await workspaces.current();
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
        const workspace = await workspaces.current();
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
        "production runtime (Modal sandbox + Deno, no network/filesystem). Reports " +
        "build errors, load errors, and the extracted agent config. Pass " +
        "`tool` and `args` to also invoke one of the agent's tools with " +
        "sample arguments and see its result. Secrets are NOT available in " +
        "test runs (ctx.env is empty); ctx.db is unavailable (storage disabled).",
      inputSchema: z.object({
        tool: z.string().optional().describe("Name of an agent tool to invoke after loading"),
        args: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Arguments for the invoked tool"),
      }),
      execute: ({ tool: trialTool, args }) => runTrial(deps, workspaces, trialTool, args),
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
    const modelMessages = await convertToModelMessages(messages, {
      ignoreIncompleteToolCalls: true,
    });
    const result = streamText({
      model: deps.model ?? studioModel(),
      system: studioSystemPrompt(),
      messages: modelMessages,
      // Studio tools last: a web builtin may never shadow write_file. Every
      // tool gets a per-call deadline — a hung sandbox RPC or stalled web
      // fetch must cost one tool result, not the whole turn (the UI would
      // shimmer forever).
      tools: withToolTimeouts({ ...createWebTools(), ...createStudioTools(deps) }),
      ...(deps.abortSignal && { abortSignal: deps.abortSignal }),
      stopWhen: stepCountIs(MAX_CHAT_STEPS),
      onFinish: disposeSandbox,
      onAbort: disposeSandbox,
      onError: disposeSandbox,
    });
    return result.toUIMessageStreamResponse({
      // `originalMessages` switches the stream to persistence mode: its
      // onFinish reports the full updated conversation (request messages +
      // the assistant response). It fires on normal finish AND on client
      // abort (`isAborted`), so an aborted turn still persists the user
      // message plus whatever assistant output settled; a turn that dies
      // before the stream starts persists nothing — the client resends the
      // full history next turn anyway.
      originalMessages: messages,
      onFinish: ({ messages: updated }) => {
        void deps.persistMessages?.(updated).catch((err: unknown) => {
          console.warn("Studio chat: failed to persist conversation", {
            project: deps.project,
            error: errorMessage(err),
          });
        });
      },
      onError: (error) => {
        disposeSandbox();
        return errorMessage(error);
      },
    });
  } catch (err) {
    disposeSandbox();
    throw err;
  }
}
