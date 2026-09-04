// Copyright 2026 the AAI authors. MIT license.
/**
 * The studio coding agent's chat surface — served by the guest harness on
 * its PUBLIC tunnel endpoint (`POST /studio/chat`), mirroring how voice
 * sessions connect directly to a deployed agent's sandbox. The browser
 * talks to this sandbox, not to the platform host; the host only brokers
 * the URL (`POST /studio/projects/:project/session`) and serves the
 * guest→host RPCs (workspace sync, chat persistence, builds).
 *
 * The agentic loop runs HERE, in the tenant's own container, on the CALLER'S
 * OWN AssemblyAI key — delivered by `studio/session-init` over the
 * authenticated control channel, never platform-owned. The agent itself is an
 * ordinary `agent()` definition (`studio-agent.ts`) run by the SDK's
 * `createTextAgent`; what this module owns is the HTTP surface, the turn gate,
 * and one turn's delivery and settle. The chat surface's
 * bearer is a separate per-session token the broker mints alongside the
 * session and hands to both this guest and the browser: the tunnel URL is
 * public, and without auth anyone holding it could burn the caller's key
 * and edit their workspace. The token — not the key — is what the browser
 * re-presents on every turn, so no long-lived credential ever crosses the
 * public surface (browser sessions authenticate to the PLATFORM with a
 * Supabase session, and never hold the AssemblyAI key at all).
 *
 * CORS is open (`*`) — the studio page's origin differs per deployment and
 * the bearer, not the origin, is the access control (no cookies exist
 * here).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { errorMessage } from "@alexkroman1/aai";
import { ASSEMBLYAI_LLM_API_KEY_ENV } from "@alexkroman1/aai/host-internal";
import { omitUndefined } from "@alexkroman1/aai/utils";
import { createTextAgent } from "@alexkroman1/aai-runtime";
import { convertToModelMessages, type LanguageModel, type UIMessage } from "ai";
import { verifyBearer } from "./harness-auth.ts";
import { hostRequest } from "./harness-rpc.ts";
import type { HarnessBundleAccess } from "./harness-types.ts";
import { createStudioAgent, STUDIO_TOOL_TIMEOUT_MS } from "./studio-agent.ts";
import { typecheckWorkspaceDir } from "./studio-build.ts";
import {
  compactMessages,
  DEFAULT_COMPACTION,
  estimateTokens,
  needsCompaction,
} from "./studio-compaction.ts";
import { CORS_HEADERS, readBody, sendJson } from "./studio-http.ts";
import type { StudioSession } from "./studio-session.ts";
import { STUDIO_TOOL_LABELS } from "./studio-tools.ts";
import { createTurnBudget } from "./studio-turn-budget.ts";
import {
  createWorkspaceCheckpointer,
  MUTATING_TOOLS,
  SYNC_RPC_TIMEOUT_MS,
  settleTurn,
} from "./studio-turn-settle.ts";
import {
  deliverTurn,
  enterTurn,
  TURN_IN_FLIGHT_CODE,
  TURN_IN_FLIGHT_STATUS,
} from "./studio-turn-stream.ts";
import type { TypecheckFn } from "./studio-write-diagnostics.ts";

/** Matches the host store's whole-conversation byte cap (4 MB). */
const MAX_CHAT_BODY_BYTES = 4_000_000;

export type StudioChatDeps = HarnessBundleAccess & {
  /** Test seam. Defaults to the gateway model on the session's caller key. */
  model?: LanguageModel;
  /**
   * Test seam for the post-write type check. Defaults to
   * {@link typecheckWorkspaceDir} — a real `tsc --noEmit` spawn, which is
   * exactly right in a sandbox and wrong in a unit test: it is by far the
   * slowest thing a scripted turn does, so a suite running it under parallel
   * load times out on the compiler rather than on anything under test.
   */
  typecheck?: TypecheckFn;
};

/** Run one coding-agent turn, streaming the UI message stream to `res`. */
async function runTurn(
  session: StudioSession,
  deps: StudioChatDeps,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  let body: string;
  try {
    body = await readBody(req, MAX_CHAT_BODY_BYTES);
  } catch (err) {
    sendJson(res, 400, { error: errorMessage(err) });
    return;
  }
  let messages: UIMessage[];
  try {
    const parsed = JSON.parse(body) as { messages?: unknown };
    if (!Array.isArray(parsed.messages)) throw new Error("messages must be an array");
    messages = parsed.messages as UIMessage[];
  } catch (err) {
    sendJson(res, 400, { error: errorMessage(err) });
    return;
  }

  // A closed browser tab must stop the LLM stream and in-flight tools.
  const abort = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) abort.abort();
  });

  // Wall clock, not just steps: the step cap says nothing about how long a
  // user waits, and turns were reaching fifteen minutes.
  const budget = createTurnBudget();

  // Persist the conversation as it stands BEFORE the turn runs, so a guest
  // that dies mid-turn still leaves the user's prompt and the history behind
  // it. Without this the settle in `onFinish` was the only writer, and a
  // killed first turn erased the whole transcript.
  void hostRequest("studio/persist-chat", { messages }, SYNC_RPC_TIMEOUT_MS).catch(
    (err: unknown) => {
      console.error(`studio chat: failed to persist inbound messages: ${errorMessage(err)}`);
    },
  );

  const checkpointWorkspace = createWorkspaceCheckpointer(session);
  // The workspace type check the agent's post-write diagnostics run on. Handed
  // down as a FUNCTION: `createStudioAgent` builds the one shared checker over
  // it (see there for why there must only be one).
  const typecheck: TypecheckFn = deps.typecheck ?? (() => typecheckWorkspaceDir(session.dir));

  // The coding agent, as an ordinary `agent()` definition — see
  // studio-agent.ts. The SDK owns request assembly from here: model
  // resolution, the builtins, the tool executor and its `ctx`, the per-call
  // deadline, the reserved final answering step, and tool-call repair (which
  // matters here because the studio model regularly emits a whole source file
  // inside a JSON string and breaks the parse).
  const chat = createTextAgent({
    agent: createStudioAgent(session, {
      loadBundle: deps.loadBundle,
      executeTool: deps.executeTool,
      typecheck,
    }),
    // `ctx.env` stays EMPTY while the caller's key resolves the model: the
    // coding agent's tools have no business reading a credential, and the
    // providerEnv split is exactly the seam that says so.
    env: {},
    providerEnv: { [ASSEMBLYAI_LLM_API_KEY_ENV]: session.apiKey },
    ...omitUndefined({ model: deps.model }),
    sessionId: `${session.scope}/${session.project}`,
    toolTimeoutMs: STUDIO_TOOL_TIMEOUT_MS,
  });

  const result = chat.stream({
    messages: await convertToModelMessages(messages, { ignoreIncompleteToolCalls: true }),
    signal: abort.signal,
    // Checkpoint after any step that touched the filesystem — see
    // createWorkspaceCheckpointer for why this is not left to onFinish.
    onStepFinish: ({ toolCalls }) => {
      if (toolCalls?.some((call) => MUTATING_TOOLS.has(call.toolName))) checkpointWorkspace();
    },
    // Alongside the agent's own step cap, never instead of it.
    stopWhen: [() => budget.expired()],
    // A long repair loop accumulates bulky tool results (tsc dumps, build
    // logs) — one per attempt. Without this the raised step cap would just
    // trade a step-cap failure for a context-overflow one.
    prepareStep: async ({ messages: stepMessages }) => {
      // One estimate per step, threaded into both readers: it stringifies every
      // non-string message content, and this list is the whole conversation.
      const estimate = estimateTokens(stepMessages);
      const base = needsCompaction(stepMessages, DEFAULT_COMPACTION, estimate)
        ? await compactMessages(chat.model, stepMessages, DEFAULT_COMPACTION, estimate)
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
  });

  // The stream carries its own failures now — see studio-turn-stream.ts for
  // what a silently truncated turn looked like before it did.
  const { failure } = await deliverTurn(result, res, {
    headers: CORS_HEADERS,
    originalMessages: messages,
    // Fires on finish AND on client abort — either way the workspace edits
    // and the settled conversation reach the host's stores. A failure is
    // logged, never fatal: losing one snapshot must not kill the reply.
    onFinish: ({ messages: updated }) => {
      void settleTurn(session, updated).catch((err: unknown) => {
        console.error(`studio chat: failed to settle turn: ${errorMessage(err)}`);
      });
    },
    toErrorText: errorMessage,
  });
  if (failure !== undefined) {
    // The client was told in-band; this is the operator-side record.
    console.error(`studio chat: turn stream failed: ${errorMessage(failure)}`);
  }
}

/**
 * The harness's HTTP hook for `/studio/*` — returns true when the request
 * was claimed. Wired into `createRuntimeServer`'s `request` option.
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
  if (!verifyBearer(req.headers.authorization, session.chatToken)) {
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
  // One claim on the workspace at a time per guest: a project has one sandbox
  // and every tab posts its own whole-conversation view, so a second concurrent
  // turn interleaves workspace edits and its settle erases the first turn. The
  // same claim is what a mid-turn `studio/session-init` fails to take, which is
  // what stops it deleting the tree under this turn (see studio-turn-stream.ts).
  const release = enterTurn();
  if (!release) {
    sendJson(res, TURN_IN_FLIGHT_STATUS, {
      error: "This project is already running a turn",
      code: TURN_IN_FLIGHT_CODE,
    });
    return true;
  }
  // Released by whichever comes first: the response closing, or the turn
  // settling. Liveness over strictness — the turn promise only resolves once
  // the body has DRAINED, so a client that opens a turn and stops reading
  // would otherwise lock this project's chat out for the life of the sandbox.
  // The residual overlap is a settle (`onFinish` → sync + persist) still
  // running as the next turn starts, which its own inbound persist follows.
  //
  // This is also what keeps the composer's own queue working: it dispatches
  // the next follow-up the moment the client observes the stream end, which is
  // strictly after this response closed here — so back-to-back queued turns
  // are never refused as concurrent (25 in a row, measured).
  res.on("close", release);
  void runTurn(session, deps, req, res)
    .catch((err: unknown) => {
      const message = errorMessage(err);
      console.error(`studio chat: turn failed: ${message}`);
      if (!res.headersSent) sendJson(res, 500, { error: message });
      else res.destroy();
    })
    .finally(release);
  return true;
}
