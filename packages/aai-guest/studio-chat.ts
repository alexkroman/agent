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

import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { ASSEMBLYAI_LLM_API_KEY_ENV, assemblyAI } from "@alexkroman1/aai/llm";
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
import type { z } from "zod";
import { hostRequest } from "./harness-rpc.ts";
import {
  createStudioTools,
  materializeWorkspace,
  STUDIO_TOOL_LABELS,
  snapshotWorkspace,
} from "./studio-tools.ts";

/** Matches the host store's whole-conversation byte cap (4 MB). */
const MAX_CHAT_BODY_BYTES = 4_000_000;
/** Guest→host build deadline — a cold Vite pass takes tens of seconds. */
const BUILD_RPC_TIMEOUT_MS = 200_000;
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
export async function initStudioSession(params: StudioSessionParams): Promise<StudioSession> {
  const dir = path.join(os.tmpdir(), `aai-studio-ws-${process.pid}`);
  await materializeWorkspace(dir, params.files);
  return { ...params, dir };
}

function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
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
        const parsed = def.parameters
          ? ((def.parameters as z.ZodType).safeParse(args ?? {}) as z.ZodSafeParseResult<unknown>)
          : { success: true as const, data: args ?? {} };
        if (!parsed.success) return { error: `Invalid arguments: ${parsed.error.message}` };
        return await def.execute(parsed.data as never, ctx as never);
      },
    });
  }
  return out;
}

/** Push the workspace and settled conversation back to the host's stores. */
async function settleTurn(session: StudioSession, messages: UIMessage[]): Promise<void> {
  const { files, warnings } = await snapshotWorkspace(session.dir);
  for (const warning of warnings) console.error(`studio sync: ${warning}`);
  await hostRequest("studio/sync-workspace", { files }, SYNC_RPC_TIMEOUT_MS);
  await hostRequest("studio/persist-chat", { messages }, SYNC_RPC_TIMEOUT_MS);
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
      assemblyAI({
        model: session.model,
        ...(session.region === "eu" ? { region: "eu" as const } : {}),
      }),
      { [ASSEMBLYAI_LLM_API_KEY_ENV]: session.apiKey },
    );

  const result = streamText({
    model,
    system: session.system,
    messages: await convertToModelMessages(messages, { ignoreIncompleteToolCalls: true }),
    // Studio tools last: a web builtin may never shadow write_file.
    tools: {
      ...createGuestWebTools(),
      ...createStudioTools({
        dir: session.dir,
        build: async (files) =>
          (await hostRequest("studio/build", { files }, BUILD_RPC_TIMEOUT_MS)) as {
            worker?: string;
            buildError?: string;
          },
        loadBundle: deps.loadBundle,
        executeTool: deps.executeTool,
      }),
    },
    abortSignal: abort.signal,
    stopWhen: stepCountIs(session.maxSteps),
  });

  void result.pipeUIMessageStreamToResponse(res, {
    headers: CORS_HEADERS,
    originalMessages: messages,
    // Fires on finish AND on client abort — either way the workspace edits
    // and the settled conversation reach the host's stores. A failure is
    // logged, never fatal: losing one snapshot must not kill the reply.
    onFinish: ({ messages: updated }) => {
      void settleTurn(session, updated).catch((err: unknown) => {
        console.error(
          `studio chat: failed to settle turn: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    },
    onError: (error) => (error instanceof Error ? error.message : String(error)),
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
  const header = req.headers.authorization ?? "";
  const bearer = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  if (!(bearer && constantTimeEquals(bearer, session.apiKey))) {
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
    const message = err instanceof Error ? err.message : String(err);
    console.error(`studio chat: turn failed: ${message}`);
    if (!res.headersSent) sendJson(res, 500, { error: message });
    else res.destroy();
  });
  return true;
}
