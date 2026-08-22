// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai-runtime:runtime` epoch 1.
 *
 * See `../../../../aai/contracts/compatibility/agent/v3.ts` for what "frozen"
 * obliges and why the imports are relative.
 *
 * The runtime is the layer a server is built AROUND, so this file is written
 * from the position of a host that does not want `createAgentServer`: it owns
 * its own HTTP stack, or its own transport, and reaches for the engine directly.
 * Three shapes, in the order a host meets them:
 *
 * - **Build one** ({@link createRuntime} over {@link RuntimeOptions}) — one
 *   agent, its env, and the deployment facts nothing in the process can derive.
 * - **Start a session on it** ({@link AgentRuntime.startSession} over
 *   {@link SessionStartOptions}), which is all a server needs, and all
 *   {@link SessionRuntime} exposes.
 * - **Drive it with no socket at all** — {@link Runtime}'s three extras
 *   (`createSession`, `executeTool`, `toolSchemas`), which is how the eval tier
 *   runs a real pipeline above the audio boundary.
 *
 * `AgentRuntime` is the narrow half deliberately: the platform's sandbox facade
 * implements it without being a `createRuntime` result at all, which is why the
 * two workflow-adjacent members on it are OPTIONAL rather than always present.
 */

import { agent } from "@alexkroman1/aai";
import type { ClientSink } from "@alexkroman1/aai/protocol";

import {
  type AgentRuntime,
  createRuntime,
  decliningRuntime,
  type Runtime,
  type RuntimeOptions,
  type SessionRuntime,
  type SessionStartOptions,
  type SessionWebSocket,
  type SkipGreeting,
} from "../../../runtime-barrel.ts";

const concierge = agent({
  name: "Concierge",
  systemPrompt: "You are a hotel concierge. Keep answers to one sentence.",
  greeting: "Front desk — how can I help?",
});

/**
 * The engine. `env` is the agent's own — what its tool code reads as `ctx.env`
 * — and the two deployment facts beside it are the ones no code in this process
 * can work out for itself:
 *
 * - `publicUrl` is where the outside world reaches this agent, which behind a
 *   proxy or inside a sandbox is nothing like the socket it binds. Only
 *   `ctx.workflows.publicWebhookUrl()` reads it, and it throws when absent
 *   rather than minting a `localhost` URL a third party will dial later.
 * - `shutdownTimeoutMs` bounds how long `shutdown()` waits for live sessions.
 */
export function buildRuntime(env: Record<string, string>): Runtime {
  const options: RuntimeOptions = {
    agent: concierge,
    env,
    publicUrl: "https://concierge.example.com",
    sessionStartTimeoutMs: 10_000,
    shutdownTimeoutMs: 30_000,
  };
  return createRuntime(options);
}

/**
 * One connected socket, handed to the runtime.
 *
 * `startSession` is deliberately not `async` and returns nothing: the session's
 * whole life happens on the socket, and the callbacks are how a host observes
 * it. `resumeFrom` is the one option that changes what the session IS — it
 * reattaches to a prior session's id, so the runtime restores that
 * conversation from its own retained event stream rather than from anything the
 * client claims to remember.
 */
export function attachSocket(
  runtime: AgentRuntime,
  ws: SessionWebSocket,
  resumeFrom?: string,
): void {
  const opts: SessionStartOptions = {
    ...(resumeFrom ? { resumeFrom } : {}),
    logContext: { deployment: "self-hosted" },
    onOpen: () => console.log("session open"),
    onClose: () => console.log("socket closed"),
    onSinkCreated: (id) => console.log(`session ${id} live`),
    onSessionEnd: (id) => console.log(`session ${id} finished`),
    // A programmatic client that buffers the reply and meters playback itself
    // wants no pacing lead; the default suits a browser playing in real time.
    audioLeadMs: 0,
  };
  runtime.startSession(ws, opts);
}

/**
 * Why `onSessionEnd` is handed the ending connection's own sink, and not just
 * the session id.
 *
 * A resume can register a NEW session under the SAME id while the old one is
 * still draining, so a teardown keyed on the id alone releases the live
 * session's state. The sink is the identity token: a host holding per-session
 * state compares before releasing.
 */
export function isSupersededTeardown(
  live: ReadonlyMap<string, ClientSink>,
  id: string,
  ending: ClientSink | undefined,
): boolean {
  return ending !== undefined && live.get(id) !== ending;
}

/**
 * Whether a greeting is spoken, in the form a transport takes it.
 *
 * The thunk arm is not decoration: a resumed session only knows whether to
 * greet AFTER the restore has run and reported what it recovered, which is
 * later than the moment the option is passed. A plain boolean cannot express
 * "decide when you get there".
 */
export function willGreet(skip: SkipGreeting): boolean {
  return !(typeof skip === "function" ? skip() : skip);
}

/**
 * The socket-free shape: one session over a caller-supplied sink.
 *
 * This is what `createSession` is for, and the reason the handshake is a
 * separate call — `configure(runtime.readyConfig)` is the frame that tells the
 * client the audio format and this session's id, and a caller assembling its
 * own transport has to send it. `executeTool` beside it runs a tool by name
 * with no model in the loop, which is how a tool's real behaviour gets tested
 * against the runtime that will run it in production.
 */
export async function runOneTool(
  runtime: Runtime,
  client: ClientSink,
  tool: string,
): Promise<string> {
  const session = runtime.createSession({
    id: "harness-1",
    agent: concierge.name,
    client,
    skipGreeting: true,
  });
  session.configure(runtime.readyConfig);
  await session.start();
  try {
    return await runtime.executeTool(tool, { room: "412" }, session.id);
  } finally {
    await session.stop();
  }
}

/** What the model will be offered this session — custom tools and built-ins. */
export function toolNames(runtime: Runtime): string[] {
  return runtime.toolSchemas.map((schema) => schema.name);
}

/**
 * The two optional members, read as the questions they answer.
 *
 * Both are absent on a facade that keeps neither — the platform's sandbox
 * runtime forwards sessions to a guest that owns the real stream — and that is
 * why they are optional rather than always-present: a server without them
 * answers 404 and 503 instead of pretending to a surface it does not have.
 */
export function surfaces(runtime: AgentRuntime): { workflows: boolean; events: boolean } {
  return {
    workflows: runtime.workflows !== undefined,
    events: runtime.sessionEvents !== undefined,
  };
}

/**
 * A runtime for a server that has no agent behind `/websocket`.
 *
 * It satisfies {@link SessionRuntime} — the narrowed slice a server needs — and
 * turns every session away with a stated reason. The alternative a host reaches
 * for is a placeholder agent whose prompt is never read, which accepts the
 * socket and then answers nothing.
 */
export function noAgentHere(): SessionRuntime {
  return decliningRuntime("This deployment serves host-mode sessions only.");
}
