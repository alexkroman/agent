// Copyright 2025 the AAI authors. MIT license.
/**
 * The studio's coding agent — a TypeScript agent loop (Vercel AI SDK
 * `streamText`, the same stack pipeline mode uses) with workspace file tools
 * and a deploy tool, streamed to the browser as NDJSON events.
 *
 * The LLM key is platform-owned host configuration (`ANTHROPIC_API_KEY`),
 * like the platform's default Pinecone key — it is never exposed to agent
 * bundles or stored in any tenant env.
 */

import { createAnthropic } from "@ai-sdk/anthropic";
import { type LanguageModel, type ModelMessage, stepCountIs, streamText, tool } from "ai";
import type { Storage } from "unstorage";
import { z } from "zod";
import type { StudioDeployResult } from "./studio-deploy.ts";
import type { StudioChatMessage } from "./studio-schemas.ts";
import { getWorkspace, putWorkspace } from "./studio-workspace.ts";

const DEFAULT_STUDIO_MODEL = "claude-sonnet-4-5";
const MAX_CHAT_STEPS = 16;

export const STUDIO_SYSTEM_PROMPT = `You are the AAI Studio coding agent. You help the user build and deploy \
voice agents for the AAI platform, working on a small server-side workspace \
of files you can read and write with your tools.

## How AAI agents work

The workspace entry point is agent.ts. It default-exports \`agent({...})\`:

\`\`\`ts
import { agent, tool } from "@alexkroman1/aai";
import { z } from "zod";

const lookup = tool({
  description: "Look up an order by id",
  parameters: z.object({ orderId: z.string() }),
  execute: async ({ orderId }, ctx) => {
    // ctx.kv (key-value store), ctx.state (per-session), ctx.env (secrets)
    return \`Order \${orderId} is on its way\`;
  },
});

export default agent({
  name: "Support Agent",
  systemPrompt: "You are a concise, friendly voice support agent.",
  greeting: "Hi, how can I help?",
  tools: { lookup_order: lookup },
});
\`\`\`

Rules:
- Imports are restricted to workspace files, "@alexkroman1/aai" (any
  subpath), and "zod". No other npm packages, no Node builtins.
- Replies are spoken aloud: keep systemPrompt guidance conversational and
  instruct the agent to answer briefly.
- Built-in tools (think, remember, recall, calculate) are on by default.
  Opt-in builtins: web_search, visit_webpage, fetch_json, run_code — enable
  via \`builtinTools: [...]\`.
- Tool \`execute\` runs in a locked-down sandbox: no filesystem, no
  subprocesses; network only through the built-in fetch tools.

## Your workflow

1. Understand what the user wants; look at the current files first.
2. Edit agent.ts (and helper files) with write_file. Keep code simple.
3. When the user wants it live, call deploy_agent. If the deploy reports a
   build or config error, fix the code and deploy again.
4. After a successful deploy, give the user the agent's URL path and remind
   them the agent needs an ASSEMBLYAI_API_KEY secret (set via the Secrets
   panel or the deploy env) before voice sessions will connect.

Be concise. Make the change, verify by re-reading only when unsure, and
summarize what you did in a sentence or two.`;

/** True when the platform host is configured to run the studio LLM. */
export function isStudioLlmConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.ANTHROPIC_API_KEY);
}

/** Resolve the studio chat model from host env. Throws when unconfigured. */
export function studioModel(env: NodeJS.ProcessEnv = process.env): LanguageModel {
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("Studio LLM not configured: set ANTHROPIC_API_KEY");
  // Explicit baseURL so the SDK never reads process.env at request time
  // (same reasoning as host/providers/resolve.ts).
  return createAnthropic({ apiKey, baseURL: "https://api.anthropic.com/v1" })(
    env.STUDIO_LLM_MODEL ?? DEFAULT_STUDIO_MODEL,
  );
}

export type StudioChatDeps = {
  storage: Storage;
  scope: string;
  project: string;
  /** Deploys the current workspace; injected so routes wire the full deps once. */
  deploy: (env?: Record<string, string>) => Promise<StudioDeployResult>;
  /** Injectable for tests — defaults to the host-env Anthropic model. */
  model?: LanguageModel;
};

type WorkspaceEdit = (files: Record<string, string>) => string | Promise<string>;

/**
 * Build the coding agent's tool set. Every file tool re-reads the workspace
 * so edits are write-through — the browser sees them immediately and the
 * deploy tool always builds the latest files.
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
    deploy_agent: tool({
      description:
        "Build the workspace and deploy it to the platform. Returns the live " +
        "URL path on success, or a build/config error to fix. Optionally set " +
        "env secrets (e.g. ASSEMBLYAI_API_KEY) to store with the agent.",
      inputSchema: z.object({
        env: z.record(z.string(), z.string()).optional().describe("Secrets to store, KEY→value"),
      }),
      execute: async ({ env }) => {
        const result = await deps.deploy(env);
        return result.ok
          ? `Deployed. The agent is live at ${result.url}`
          : `Deploy failed: ${result.error}`;
      },
    }),
  };
}

/** One NDJSON event streamed to the browser. */
export type StudioChatEvent =
  | { type: "text"; text: string }
  | { type: "tool_call"; name: string; input: unknown }
  | { type: "tool_result"; name: string; output: unknown }
  | { type: "error"; message: string }
  | { type: "done" };

/**
 * Run one coding-agent turn and stream it as NDJSON (one JSON event per
 * line). The client resends the full message history each turn, so the
 * server stays stateless between requests.
 */
export function runStudioChat(
  deps: StudioChatDeps,
  messages: StudioChatMessage[],
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const write = (event: StudioChatEvent) =>
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      try {
        const result = streamText({
          model: deps.model ?? studioModel(),
          system: STUDIO_SYSTEM_PROMPT,
          messages: messages.map((m): ModelMessage => ({ role: m.role, content: m.content })),
          tools: createStudioTools(deps),
          stopWhen: stepCountIs(MAX_CHAT_STEPS),
        });
        for await (const part of result.fullStream) {
          switch (part.type) {
            case "text-delta":
              write({ type: "text", text: part.text });
              break;
            case "tool-call":
              write({ type: "tool_call", name: part.toolName, input: part.input });
              break;
            case "tool-result":
              write({ type: "tool_result", name: part.toolName, output: part.output });
              break;
            case "error":
              write({
                type: "error",
                message: part.error instanceof Error ? part.error.message : String(part.error),
              });
              break;
            default:
              break;
          }
        }
        write({ type: "done" });
      } catch (err) {
        write({ type: "error", message: err instanceof Error ? err.message : String(err) });
      }
      controller.close();
    },
  });
}
