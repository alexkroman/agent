// Copyright 2025 the AAI authors. MIT license.
/**
 * The studio's coding agent — a TypeScript agent loop (Vercel AI SDK
 * `streamText`, the same stack pipeline mode uses) with workspace file tools
 * and a deploy tool, streamed to the browser as NDJSON events.
 *
 * The LLM is selected from platform-owned host configuration (never tenant
 * env) via the SDK's own provider descriptors + `resolveLlm`, so the studio
 * can run on any pipeline-mode LLM provider — by default the AssemblyAI LLM
 * Gateway (`ASSEMBLYAI_API_KEY`), falling back to Anthropic direct
 * (`ANTHROPIC_API_KEY`). Override with `STUDIO_LLM_PROVIDER` /
 * `STUDIO_LLM_MODEL` (and `STUDIO_LLM_REGION=eu` for the gateway's EU
 * endpoint).
 */

import type { LlmProvider } from "@alexkroman1/aai/llm";
import {
  ANTHROPIC_API_KEY_ENV,
  ASSEMBLYAI_LLM_API_KEY_ENV,
  anthropic,
  assemblyAI,
  GATEWAY_API_KEY_ENV,
  GOOGLE_API_KEY_ENV,
  GROQ_API_KEY_ENV,
  gateway,
  google,
  groq,
  MISTRAL_API_KEY_ENV,
  mistral,
  OPENAI_API_KEY_ENV,
  openai,
  XAI_API_KEY_ENV,
  xai,
} from "@alexkroman1/aai/llm";
import { resolveLlm } from "@alexkroman1/aai/runtime";
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
import { bundleWorkspace, StudioBuildError } from "./studio-bundle.ts";
import type { StudioDeployResult } from "./studio-deploy.ts";
import { studioSystemPrompt } from "./studio-prompt.ts";
import type { StudioSandbox } from "./studio-sandbox.ts";
import { getWorkspace, putWorkspace } from "./studio-workspace.ts";

const MAX_CHAT_STEPS = 16;

type StudioLlmEntry = {
  envVar: string;
  /** Model used when STUDIO_LLM_MODEL is unset; absent = model required. */
  defaultModel?: string;
  make: (model: string, env: NodeJS.ProcessEnv) => LlmProvider;
};

/**
 * Providers the studio chat can run on. All pipeline-mode LLM providers are
 * wired; only the two the platform is expected to hold keys for get default
 * models — the rest require an explicit `STUDIO_LLM_MODEL`.
 */
const STUDIO_LLM_PROVIDERS: Record<string, StudioLlmEntry> = {
  assemblyai: {
    envVar: ASSEMBLYAI_LLM_API_KEY_ENV,
    defaultModel: "claude-sonnet-4-6",
    make: (model, env) =>
      assemblyAI({ model, ...(env.STUDIO_LLM_REGION === "eu" ? { region: "eu" as const } : {}) }),
  },
  anthropic: {
    envVar: ANTHROPIC_API_KEY_ENV,
    defaultModel: "claude-sonnet-4-5",
    make: (model) => anthropic({ model }),
  },
  openai: { envVar: OPENAI_API_KEY_ENV, make: (model) => openai({ model }) },
  google: { envVar: GOOGLE_API_KEY_ENV, make: (model) => google({ model }) },
  mistral: { envVar: MISTRAL_API_KEY_ENV, make: (model) => mistral({ model }) },
  xai: { envVar: XAI_API_KEY_ENV, make: (model) => xai({ model }) },
  groq: { envVar: GROQ_API_KEY_ENV, make: (model) => groq({ model }) },
  gateway: { envVar: GATEWAY_API_KEY_ENV, make: (model) => gateway({ model }) },
};

/** Providers auto-selected (in order) when STUDIO_LLM_PROVIDER is unset. */
const AUTO_PROVIDER_ORDER = ["assemblyai", "anthropic"] as const;

export type StudioLlmSelection = {
  provider: string;
  model: string;
  descriptor: LlmProvider;
  envVar: string;
};

/**
 * Pick the studio chat LLM from host env. Explicit `STUDIO_LLM_PROVIDER`
 * wins; otherwise the AssemblyAI LLM Gateway when its key is present, then
 * Anthropic. Returns null when nothing is configured. Throws on a
 * misconfiguration worth surfacing (unknown provider, missing model).
 */
export function selectStudioLlm(env: NodeJS.ProcessEnv = process.env): StudioLlmSelection | null {
  const explicit = env.STUDIO_LLM_PROVIDER?.toLowerCase();
  let provider: string | undefined;
  if (explicit) {
    if (!(explicit in STUDIO_LLM_PROVIDERS)) {
      throw new Error(
        `Unknown STUDIO_LLM_PROVIDER "${explicit}" — one of: ${Object.keys(STUDIO_LLM_PROVIDERS).join(", ")}`,
      );
    }
    provider = explicit;
  } else {
    provider = AUTO_PROVIDER_ORDER.find((name) => {
      const candidate = STUDIO_LLM_PROVIDERS[name];
      return candidate !== undefined && Boolean(env[candidate.envVar]);
    });
  }
  if (!provider) return null;
  // Guarded above for the explicit path; AUTO_PROVIDER_ORDER names are keys.
  const entry = STUDIO_LLM_PROVIDERS[provider] as StudioLlmEntry;
  // `||` not `??`: an empty-string env var means "unset".
  const model = env.STUDIO_LLM_MODEL || entry.defaultModel;
  if (!model) {
    throw new Error(`STUDIO_LLM_MODEL is required for STUDIO_LLM_PROVIDER "${provider}"`);
  }
  return { provider, model, descriptor: entry.make(model, env), envVar: entry.envVar };
}

/** True when the platform host is configured to run the studio LLM. */
export function isStudioLlmConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    const selection = selectStudioLlm(env);
    return selection !== null && Boolean(env[selection.envVar]);
  } catch {
    return false;
  }
}

/** Provider/model info for the status endpoint; null when unconfigured. */
export function studioLlmInfo(
  env: NodeJS.ProcessEnv = process.env,
): { provider: string; model: string } | null {
  if (!isStudioLlmConfigured(env)) return null;
  // isStudioLlmConfigured just proved this select succeeds and is non-null.
  const selection = selectStudioLlm(env) as StudioLlmSelection;
  return { provider: selection.provider, model: selection.model };
}

/** Resolve the studio chat model from host env. Throws when unconfigured. */
export function studioModel(env: NodeJS.ProcessEnv = process.env): LanguageModel {
  const selection = selectStudioLlm(env);
  if (!selection) {
    throw new Error(
      "Studio LLM not configured: set ASSEMBLYAI_API_KEY (LLM Gateway) or " +
        "ANTHROPIC_API_KEY, or choose a provider with STUDIO_LLM_PROVIDER",
    );
  }
  const key = env[selection.envVar];
  if (!key) {
    throw new Error(`Studio LLM misconfigured: ${selection.envVar} is not set`);
  }
  // resolveLlm reads the key from the env record it is given — pass exactly
  // the one variable it needs (host env never flows anywhere else).
  return resolveLlm(selection.descriptor, { [selection.envVar]: key });
}

export type StudioChatDeps = {
  storage: Storage;
  scope: string;
  project: string;
  /** Deploys the current workspace; injected so routes wire the full deps once. */
  deploy: (env?: Record<string, string>) => Promise<StudioDeployResult>;
  /**
   * Lazy handle to this chat session's sandbox — the same warm-pool/gVisor
   * infrastructure deployed agents run in. Used by test_agent and (via the
   * deploy fn) config extraction. Provisioned on first use.
   */
  sandbox: () => Promise<StudioSandbox>;
  /** Tears down the session sandbox if one was provisioned. Idempotent. */
  disposeSandbox?: () => Promise<void>;
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
    worker = await bundleWorkspace(workspace.files);
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
      model: deps.model ?? studioModel(),
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
