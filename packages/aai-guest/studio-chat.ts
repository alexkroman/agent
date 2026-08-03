// Copyright 2026 the AAI authors. MIT license.
/**
 * The studio coding agent's chat surface — served by the guest harness on
 * its PUBLIC tunnel endpoint (`POST /studio/chat`), mirroring how voice
 * sessions connect directly to a deployed agent's sandbox. The browser
 * talks to this sandbox, not to the platform host; the host only brokers
 * the URL (`POST /studio/projects/:project/session`) and serves the
 * guest→host RPCs (workspace sync, chat persistence, builds).
 *
 * The agentic loop (Vercel AI SDK `streamText`, same stack pipeline mode
 * uses) runs HERE, in the tenant's own container, on the CALLER'S OWN
 * AssemblyAI key — delivered by `studio/session-init` over the
 * authenticated control channel, never platform-owned. That key is also
 * the chat surface's bearer: the tunnel URL is public, and without auth
 * anyone holding it could burn the caller's key and edit their workspace.
 * The caller proved possession of the key to the platform to get the URL,
 * so requiring the same key here adds no new secret.
 *
 * CORS is open (`*`) — the studio page's origin differs per deployment and
 * the bearer, not the origin, is the access control (no cookies exist
 * here).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { formatSchemaIssues } from "@alexkroman1/aai/internal";
import { ASSEMBLYAI_LLM_API_KEY_ENV, assemblyAILlm } from "@alexkroman1/aai/llm";
import { resolveAllBuiltins, resolveLlm } from "@alexkroman1/aai/runtime";
import {
  convertToModelMessages,
  jsonSchema,
  type LanguageModel,
  stepCountIs,
  streamText,
  type ToolSet,
  tool,
  type UIMessage,
} from "ai";
import { verifyBearer } from "./harness-auth.ts";
import { errMsg, hostRequest } from "./harness-rpc.ts";
import {
  buildWorkspaceDir,
  toolchainModules,
  typecheckWorkspaceDir,
  workspacesRoot,
} from "./studio-build.ts";
import { compactMessages, needsCompaction } from "./studio-compaction.ts";
import { ensureProjectShape } from "./studio-project-shape.ts";
import { createDesignInspirationTool, createProjectTools } from "./studio-project-tools.ts";
import { createToolCallRepair } from "./studio-tool-repair.ts";
import { createStudioTools, STUDIO_TOOL_LABELS, withToolDeadlines } from "./studio-tools.ts";
import { createTurnBudget } from "./studio-turn-budget.ts";
import { materializeWorkspace, snapshotWorkspace } from "./studio-workspace-fs.ts";

/** Matches the host store's whole-conversation byte cap (4 MB). */
const MAX_CHAT_BODY_BYTES = 4_000_000;
/** Deadline for the end-of-turn workspace sync / chat persist RPCs. */
const SYNC_RPC_TIMEOUT_MS = 30_000;

export type StudioSessionParams = {
  project: string;
  files: Record<string, string>;
  /** The caller's AssemblyAI key — LLM credential AND chat bearer. */
  apiKey: string;
  system: string;
  model: string;
  region?: "eu" | undefined;
  maxSteps: number;
};

export type StudioSession = StudioSessionParams & { dir: string };

export type StudioChatDeps = {
  /** The harness's own bundle loader (`bundle/load` internals). */
  loadBundle: (code: string) => Promise<{ config?: unknown }>;
  /** The harness's one-shot trial executor (`tool/execute` internals). */
  executeTool: (name: string, args: Record<string, unknown>) => Promise<string>;
  /** Test seam. Defaults to the gateway model on the session's caller key. */
  model?: LanguageModel;
};

/**
 * Initialize (or replace) the harness's studio session: materialize the
 * workspace to a scratch dir and remember the turn configuration. Called by
 * the `studio/session-init` control-channel request — repeat calls reset
 * the workspace to the store's current files (the broker re-inits on every
 * page session so the sandbox never serves a stale tree).
 */
/**
 * The concrete on-disk paths the coding agent can read, appended to the
 * host-composed system prompt.
 *
 * The host cannot write these: the harness sits at a different depth in the
 * two layouts (`/opt/aai/harness.mjs` in the Modal image,
 * `packages/aai-guest/dist/harness.mjs` under the subprocess backend), so
 * any relative path baked into the preamble is right in one and wrong in the
 * other. Only the guest can resolve it, and it does so by searching for the
 * toolchain rather than assuming an offset.
 *
 * They are absolute because that is the one form that survives a `bash` call
 * with an unexpected cwd, and `bash` is the only tool that can reach them at
 * all — `read_file` is jailed to the workspace, and `glob`/`grep` skip
 * node_modules by design.
 */
export function toolchainPromptSection(modulesDir: string | null = toolchainModules()): string {
  if (modulesDir === null) return "";
  const at = (rel: string): string => path.join(modulesDir, rel);
  return `

## Installed packages on this machine

Read these with \`bash\` — they live outside your workspace, so read_file,
glob, and grep cannot see them. They are ground truth, ahead of memory:

- Worked example agents: \`${at("@alexkroman1/aai-cli/dist/templates")}\`
  (\`ls\` it; five have a real client.tsx — dispatch-center,
  infocom-adventure, night-owl, pizza-ordering, solo-rpg). Read the closest
  match before writing a pattern from scratch.
- SDK types (agent(), tool(), ctx): \`${at("@alexkroman1/aai/dist")}\`
- client.tsx imports: \`${at("@alexkroman1/aai-ui/dist/index.d.ts")}\`, and
  per-component props in \`${at("@alexkroman1/aai-ui/dist/components")}\``;
}

export async function initStudioSession(params: StudioSessionParams): Promise<StudioSession> {
  // Under the workspaces root, NOT os.tmpdir(): builds run in-guest through
  // the aai CLI bundlers, and only this root has the toolchain's
  // node_modules above it for the workspace's bare imports to resolve.
  const dir = path.join(workspacesRoot(), `session-${process.pid}`);
  await materializeWorkspace(dir, params.files);
  // Complete the workspace into a real project (package.json, tsconfig,
  // …) — same shape `aai init` scaffolds; the files sync back to the
  // store at end of turn like everything else in the workspace.
  await ensureProjectShape(dir);
  return { ...params, system: params.system + toolchainPromptSection(), dir };
}

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type",
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json", ...CORS_HEADERS });
  res.end(JSON.stringify(body));
}

/** Read the request body with a hard byte cap. */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_CHAT_BODY_BYTES) {
        reject(new Error("Conversation too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

/**
 * The SDK's keyless web builtins (`visit_webpage`, `get_page_design`,
 * `web_search`), mapped to AI SDK tools. Same mapping the host used to do —
 * now the fetches originate in the guest, whose open egress is the norm for
 * tenant code (`safeFetch` still screens the model-controlled URLs).
 */
export function createGuestWebTools(): ToolSet {
  const { defs, schemas } = resolveAllBuiltins(["visit_webpage", "get_page_design", "web_search"]);
  const ctx = {
    env: {},
    state: {},
    db: { query: () => Promise.reject(new Error("Storage is not available in studio web tools")) },
    generate: () => Promise.reject(new Error("generate is not available in studio web tools")),
    messages: [],
    sessionId: "studio-web",
    send: () => undefined,
  };
  const out: ToolSet = {};
  for (const schema of schemas) {
    const def = defs[schema.name];
    if (!def) continue;
    out[schema.name] = tool({
      description: schema.description,
      inputSchema: jsonSchema(schema.parameters),
      execute: async (args: unknown) => {
        if (!def.inputSchema) return await def.execute((args ?? {}) as never, ctx as never);
        const parsed = await def.inputSchema["~standard"].validate(args ?? {});
        if (parsed.issues) {
          return { error: `Invalid arguments: ${formatSchemaIssues(parsed.issues)}` };
        }
        return await def.execute(parsed.value as never, ctx as never);
      },
    });
  }
  return out;
}

/**
 * Push the workspace and settled conversation back to the host's stores.
 *
 * `done: true` marks this sync as the TURN-COMPLETE one — the guest's analog
 * of opencode's `session.idle` / codex's `agent-turn-complete`. The host
 * keys auto preview deploys off it; mid-turn checkpoints (below) share the
 * RPC method but never carry the flag, so a half-finished workspace is never
 * preview-deployed.
 */
async function settleTurn(session: StudioSession, messages: UIMessage[]): Promise<void> {
  const { files, warnings } = await snapshotWorkspace(session.dir);
  for (const warning of warnings) console.error(`studio sync: ${warning}`);
  // Independent stores — no reason to pay two 30s worst cases in sequence.
  await Promise.all([
    hostRequest("studio/sync-workspace", { files, done: true }, SYNC_RPC_TIMEOUT_MS),
    hostRequest("studio/persist-chat", { messages }, SYNC_RPC_TIMEOUT_MS),
  ]);
}

/**
 * Tools whose success changes files on disk. `bash` is in the set because it
 * is a real shell — a redirect or `mv` is as much an edit as `write_file`.
 * Read-only tools are excluded so a turn that only searches and reads never
 * pays for a snapshot.
 */
export const MUTATING_TOOLS: ReadonlySet<string> = new Set([
  "write_file",
  "edit_file",
  "delete_file",
  "bash",
  "add_dependency",
  "remove_dependency",
  "download_to_workspace",
]);

/**
 * Mid-turn workspace checkpointing.
 *
 * `settleTurn` runs from `onFinish`, which a killed guest never reaches — so
 * before this, a sandbox that died mid-turn lost every edit the turn had
 * made, and the user reloaded to an empty project having watched the agent
 * write the file. Checkpointing after each mutating step caps that loss at
 * the step in flight.
 *
 * Snapshots are serialized rather than concurrent: two overlapping walks of
 * the same workspace can interleave into a torn tree, and the host applies
 * whichever lands last. A checkpoint requested while one is running sets a
 * trailing flag instead of queueing without bound, so a long tool chain
 * issues at most one extra sync after the current one, never a backlog.
 */
function createWorkspaceCheckpointer(session: StudioSession): () => void {
  let inFlight: Promise<void> | null = null;
  let trailing = false;

  const run = async (): Promise<void> => {
    const { files } = await snapshotWorkspace(session.dir);
    await hostRequest("studio/sync-workspace", { files }, SYNC_RPC_TIMEOUT_MS);
  };

  const pump = (): void => {
    if (inFlight !== null) {
      trailing = true;
      return;
    }
    inFlight = run()
      .catch((err: unknown) => {
        // Never fatal — a lost checkpoint costs recoverable work, while a
        // thrown one would kill a reply that is otherwise fine.
        console.error(`studio chat: workspace checkpoint failed: ${errMsg(err)}`);
      })
      .finally(() => {
        inFlight = null;
        if (!trailing) return;
        trailing = false;
        pump();
      });
  };

  return pump;
}

/** Run one coding-agent turn, streaming the UI message stream to `res`. */
async function runTurn(
  session: StudioSession,
  deps: StudioChatDeps,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  let body: string;
  try {
    body = await readBody(req);
  } catch (err) {
    sendJson(res, 400, { error: err instanceof Error ? err.message : "Bad request" });
    return;
  }
  let messages: UIMessage[];
  try {
    const parsed = JSON.parse(body) as { messages?: unknown };
    if (!Array.isArray(parsed.messages)) throw new Error("messages must be an array");
    messages = parsed.messages as UIMessage[];
  } catch (err) {
    sendJson(res, 400, { error: err instanceof Error ? err.message : "Malformed body" });
    return;
  }

  // A closed browser tab must stop the LLM stream and in-flight tools.
  const abort = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) abort.abort();
  });

  const model =
    deps.model ??
    resolveLlm(
      assemblyAILlm({
        model: session.model,
        ...(session.region === "eu" ? { region: "eu" as const } : {}),
      }),
      { [ASSEMBLYAI_LLM_API_KEY_ENV]: session.apiKey },
    );

  // Wall clock, not just steps: the step cap says nothing about how long a
  // user waits, and turns were reaching fifteen minutes.
  const budget = createTurnBudget();

  // Persist the conversation as it stands BEFORE the turn runs, so a guest
  // that dies mid-turn still leaves the user's prompt and the history behind
  // it. Without this the settle in `onFinish` was the only writer, and a
  // killed first turn erased the whole transcript.
  void hostRequest("studio/persist-chat", { messages }, SYNC_RPC_TIMEOUT_MS).catch(
    (err: unknown) => {
      console.error(`studio chat: failed to persist inbound messages: ${errMsg(err)}`);
    },
  );

  const checkpointWorkspace = createWorkspaceCheckpointer(session);

  const result = streamText({
    model,
    system: session.system,
    messages: await convertToModelMessages(messages, { ignoreIncompleteToolCalls: true }),
    // Studio tools last: a web builtin may never shadow write_file. The
    // deadline wrap goes around the MERGED set so every tool family — web,
    // design, project, studio — shares the per-call timeout.
    tools: withToolDeadlines({
      ...createGuestWebTools(),
      ...createDesignInspirationTool(model),
      ...createProjectTools({ dir: session.dir }),
      ...createStudioTools({
        dir: session.dir,
        // Post-write diagnostics: the same tsc pass builds run, so a type
        // error reaches the agent inside the write result that caused it.
        typecheck: () => typecheckWorkspaceDir(session.dir),
        // Build the live session workspace in place, in THIS sandbox,
        // through the same CLI bundler pass `aai deploy` runs.
        build: () => buildWorkspaceDir(session.dir, { worker: true, client: false }),
        loadBundle: deps.loadBundle,
        executeTool: deps.executeTool,
      }),
    }),
    abortSignal: abort.signal,
    // Checkpoint after any step that touched the filesystem — see
    // createWorkspaceCheckpointer for why this is not left to onFinish.
    onStepFinish: ({ toolCalls }) => {
      if (toolCalls?.some((call) => MUTATING_TOOLS.has(call.toolName))) checkpointWorkspace();
    },
    stopWhen: [stepCountIs(session.maxSteps), () => budget.expired()],
    // A long repair loop accumulates bulky tool results (tsc dumps, build
    // logs) — one per attempt. Without this the raised step cap would just
    // trade a step-cap failure for a context-overflow one.
    prepareStep: async ({ messages: stepMessages }) => {
      const base = needsCompaction(stepMessages)
        ? await compactMessages(model, stepMessages)
        : stepMessages;
      // Past the hard deadline the turn gets exactly one more step, with
      // tools off, so it ends on something the user can read rather than on
      // whatever tool call happened to be in flight.
      const final = budget.takeFinalNotice();
      if (final) {
        return {
          messages: [...base, { role: "user" as const, content: final }],
          toolChoice: "none",
        };
      }
      const wrapUp = budget.takeWrapUpNotice();
      const next = wrapUp ? [...base, { role: "user" as const, content: wrapUp }] : base;
      return next === stepMessages ? {} : { messages: next };
    },
    // The default studio model regularly emits tool arguments that are not
    // valid JSON — a whole source file inside a JSON string is the usual
    // trigger. Without this the call is lost and the model apologizes for a
    // "JSON parsing error" and retries, burning steps on the same mistake.
    repairToolCall: createToolCallRepair(model),
  });

  void result.pipeUIMessageStreamToResponse(res, {
    headers: CORS_HEADERS,
    originalMessages: messages,
    // Fires on finish AND on client abort — either way the workspace edits
    // and the settled conversation reach the host's stores. A failure is
    // logged, never fatal: losing one snapshot must not kill the reply.
    onFinish: ({ messages: updated }) => {
      void settleTurn(session, updated).catch((err: unknown) => {
        console.error(`studio chat: failed to settle turn: ${errMsg(err)}`);
      });
    },
    onError: (error) => errMsg(error),
  });
  await result.consumeStream({ onError: () => undefined });
}

/**
 * The harness's HTTP hook for `/studio/*` — returns true when the request
 * was claimed. Wired into `createServer`'s `request` option.
 */
export function handleStudioRequest(
  session: StudioSession | null,
  deps: StudioChatDeps,
  req: IncomingMessage,
  res: ServerResponse,
  url: string,
  method: string,
): boolean {
  if (!(url === "/studio/chat" || url === "/studio/tools")) return false;
  if (method === "OPTIONS") {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return true;
  }
  if (!session) {
    sendJson(res, 409, { error: "No studio session loaded — re-open the project" });
    return true;
  }
  if (!verifyBearer(req.headers.authorization, session.apiKey)) {
    sendJson(res, 401, { error: "Unauthorized" });
    return true;
  }
  if (url === "/studio/tools") {
    if (method !== "GET") {
      sendJson(res, 405, { error: "Method not allowed" });
      return true;
    }
    sendJson(res, 200, {
      tools: Object.entries(STUDIO_TOOL_LABELS).map(([name, label]) => ({ name, label })),
    });
    return true;
  }
  if (method !== "POST") {
    sendJson(res, 405, { error: "Method not allowed" });
    return true;
  }
  void runTurn(session, deps, req, res).catch((err: unknown) => {
    const message = errMsg(err);
    console.error(`studio chat: turn failed: ${message}`);
    if (!res.headersSent) sendJson(res, 500, { error: message });
    else res.destroy();
  });
  return true;
}
