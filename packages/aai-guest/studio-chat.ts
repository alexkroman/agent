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
 * authenticated control channel, never platform-owned. The chat surface's
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
import { CORS_HEADERS, readBody, sendJson } from "./studio-http.ts";
import { ensureProjectShape } from "./studio-project-shape.ts";
import { createDesignInspirationTool, createProjectTools } from "./studio-project-tools.ts";
import { createTemplateTools } from "./studio-template-tools.ts";
import { createToolCallRepair } from "./studio-tool-repair.ts";
import { createStudioTools, STUDIO_TOOL_LABELS, withToolDeadlines } from "./studio-tools.ts";
import { createTurnBudget } from "./studio-turn-budget.ts";
import { createWorkspaceCheckpointer, MUTATING_TOOLS, settleTurn } from "./studio-turn-settle.ts";
import {
  createTurnGate,
  deliverTurn,
  TURN_IN_FLIGHT_CODE,
  TURN_IN_FLIGHT_STATUS,
} from "./studio-turn-stream.ts";
import { materializeWorkspace } from "./studio-workspace-fs.ts";
import type { TypecheckFn } from "./studio-write-diagnostics.ts";

/** Matches the host store's whole-conversation byte cap (4 MB). */
const MAX_CHAT_BODY_BYTES = 4_000_000;
/** Deadline for the end-of-turn workspace sync / chat persist RPCs. */
const SYNC_RPC_TIMEOUT_MS = 30_000;

/**
 * One turn at a time, per PROCESS — not per session object.
 *
 * A sandbox serves one project (its identity is pinned at first install), but
 * `studio/session-init` runs again on every page open, so a gate hanging off
 * the session would be replaced by the very event that creates the race:
 * measured, a second tab opening the project mid-turn re-installed the
 * session, got a fresh gate, and streamed a concurrent turn anyway.
 */
let turnGate = createTurnGate();

/** Test-only: drop the in-flight turn, like {@link resetSessionIdentity}. */
export function resetTurnGate(): void {
  turnGate = createTurnGate();
}

export type StudioSessionParams = {
  /** Workspace scope (`user:<uid>` or a key digest) — half of this guest's identity. */
  scope: string;
  project: string;
  files: Record<string, string>;
  /** The caller's AssemblyAI key — the LLM credential (never the bearer). */
  apiKey: string;
  /** Broker-minted per-session bearer for the public chat surface. */
  chatToken: string;
  system: string;
  model: string;
  region?: "eu" | undefined;
  maxSteps: number;
};

export type StudioSession = StudioSessionParams & { dir: string };

export type StudioChatDeps = {
  /** The harness's own bundle loader (`loadBundle`). */
  loadBundle: (code: string) => Promise<{ config?: unknown }>;
  /** The harness's one-shot trial executor (`executeTool`). */
  executeTool: (name: string, args: Record<string, unknown>) => Promise<string>;
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

- Worked example agents: enumerate them with list_templates and copy the
  closest match into the workspace with use_template — the files arrive
  verbatim, so never retype template code by hand. Five have a real
  client.tsx — dispatch-center, infocom-adventure, night-owl,
  pizza-ordering, solo-rpg. The sources sit at
  \`${at("@alexkroman1/aai-cli/dist/templates")}\` if you only want to
  read one in place with \`bash\`.
- SDK types (agent(), tool(), ctx): \`${at("@alexkroman1/aai/dist")}\`
- client.tsx imports: \`${at("@alexkroman1/aai-ui/dist/index.d.ts")}\`, and
  per-component props in \`${at("@alexkroman1/aai-ui/dist/components")}\``;
}

/**
 * The (scope, project) this harness was FIRST installed for. A studio sandbox
 * serves exactly one project for its whole life, so this is process identity.
 */
let installedFor: { scope: string; project: string } | null = null;

/**
 * A guest pins its own identity rather than trusting the caller's key.
 *
 * Every host caller is supposed to route (scope, project) correctly — the
 * broker keys its map and its registry row on it — but "supposed to" is the
 * part that fails. Now that ANY replica can install a session over HTTP (see
 * studio-session-init.ts), a mis-keyed registry row or a stale cross-replica
 * lookup would materialize one tenant's workspace into another tenant's
 * sandbox, where the coding agent would edit it and sync it back. Refusing
 * here makes that a 409 instead of a data-crossing bug, on the same
 * reasoning agent mode hash-verifies its bundle instead of trusting the
 * spawner to have written the right one.
 *
 * Re-installs for the SAME project are the normal path (every broker call
 * refreshes the tree), so only a CHANGE of identity is refused.
 */
export class SessionIdentityError extends Error {
  constructor(want: { scope: string; project: string }, got: { scope: string; project: string }) {
    super(
      `This sandbox serves ${want.scope}/${want.project}; refusing session-init for ` +
        `${got.scope}/${got.project}`,
    );
    this.name = "SessionIdentityError";
  }
}

/** Test seam: forget the pinned identity (one harness per test process). */
export function resetSessionIdentity(): void {
  installedFor = null;
}

export async function initStudioSession(params: StudioSessionParams): Promise<StudioSession> {
  const identity = { scope: params.scope, project: params.project };
  if (
    installedFor &&
    (installedFor.scope !== identity.scope || installedFor.project !== identity.project)
  ) {
    throw new SessionIdentityError(installedFor, identity);
  }
  // Under the workspaces root, NOT os.tmpdir(): builds run in-guest through
  // the aai CLI bundlers, and only this root has the toolchain's
  // node_modules above it for the workspace's bare imports to resolve.
  const dir = path.join(workspacesRoot(), `session-${process.pid}`);
  await materializeWorkspace(dir, params.files);
  // Complete the workspace into a real project (package.json, tsconfig,
  // …) — same shape `aai init` scaffolds; the files sync back to the
  // store at end of turn like everything else in the workspace.
  await ensureProjectShape(dir);
  // Pinned only once the install actually succeeded: a rejected first install
  // must not brand the sandbox with an identity it never served.
  installedFor = identity;
  return { ...params, system: params.system + toolchainPromptSection(), dir };
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
  // One checker for both tool families — they share the diagnostics backend,
  // and building it twice would double the coalescing runner it hangs off.
  const typecheck: TypecheckFn = deps.typecheck ?? (() => typecheckWorkspaceDir(session.dir));

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
      ...createTemplateTools({
        dir: session.dir,
        // Same post-copy diagnostics backend the write tools use.
        typecheck,
      }),
      ...createStudioTools({
        dir: session.dir,
        // Post-write diagnostics: the same tsc pass builds run, so a type
        // error reaches the agent inside the write result that caused it.
        typecheck,
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
        console.error(`studio chat: failed to settle turn: ${errMsg(err)}`);
      });
    },
    toErrorText: errMsg,
  });
  if (failure !== undefined) {
    // The client was told in-band; this is the operator-side record.
    console.error(`studio chat: turn stream failed: ${errMsg(failure)}`);
  }
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
  // One turn at a time per guest: a project has one sandbox and every tab
  // posts its own whole-conversation view, so a second concurrent turn
  // interleaves workspace edits and its settle erases the first turn.
  const release = turnGate.enter();
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
      const message = errMsg(err);
      console.error(`studio chat: turn failed: ${message}`);
      if (!res.headersSent) sendJson(res, 500, { error: message });
      else res.destroy();
    })
    .finally(release);
  return true;
}
