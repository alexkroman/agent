// Copyright 2026 the AAI authors. MIT license.
/**
 * Epoch-1 TEMPLATE for the `aai-runtime:runtime` capability — a host that owns
 * its own HTTP stack, as it was written at epoch 1. Copy the file into that
 * host, edit the lines marked `←`, and leave the rest alone.
 *
 * **Restored, and it is a promise now.** This file was deleted when the epoch
 * history was reset (nothing had shipped for it to be compatible WITH, so the
 * current epoch owes no example). `toolTimeoutMs`, an `@internal` `workflows` seam, and an `@internal` `generate` seam joined `RuntimeOptions` at epoch 2, which supersedes epoch 1 while keeping
 * it supported — so this is the evidence that a host written against epoch 1
 * still compiles. It was recovered verbatim and needed no edit, which is itself
 * the finding: the change was additive.
 *
 * FROZEN. It must keep compiling for as long as epoch 1 is supported, so do not
 * edit it to follow a change in this package's API: a compile error here is the
 * finding, not a chore. Changing the API means a NEW epoch with a new template
 * beside this one — never an edit to this file.
 *
 * Start from `createAgentServer` (the `server` capability) unless you need this
 * one. This is the layer underneath: you already have a Node server, an upgrade
 * handler and a socket, and you want the engine rather than a second listener.
 * What the template gives you:
 *
 * 1. One engine, built at boot from the agent, its env and the deployment facts
 *    this process cannot derive for itself.
 * 2. Which optional surfaces the engine offers, so you mount only real routes.
 * 3. A session per accepted socket, tracked in a registry your other routes can
 *    read.
 * 4. A drain mode that turns sessions away with a reason, and a shutdown that
 *    waits for the live ones.
 *
 * Nothing runs on import: call {@link boot} from your entrypoint, then
 * {@link attachSocket} from your upgrade handler.
 */

import { agent } from "@alexkroman1/aai";
import type { ClientSink } from "@alexkroman1/aai/protocol";

import {
  type AgentRuntime,
  createRuntime,
  decliningRuntime,
  type RunCodeExecutor,
  type Runtime,
  type RuntimeOptions,
  type SessionRuntime,
  type SessionStartOptions,
  type SessionWebSocket,
} from "../../../runtime-barrel.ts";

/** ← your agent. In a CLI-scaffolded project, the built `.aai/worker.mjs`. */
const hosted = agent({
  name: "Concierge",
  systemPrompt: "You are a hotel concierge. Keep answers to one sentence.",
  greeting: "Front desk — how can I help?",
});

/** ← the label your log pipeline files these sessions under. */
const DEPLOYMENT = "self-hosted";

/** ← what a caller hears when this process is draining rather than serving. */
const DRAINING = "This deployment is restarting — please reconnect in a moment.";

/** How long a session may take to open, and how long `shutdown()` waits. */
const SESSION_START_TIMEOUT_MS = 10_000;
const SHUTDOWN_TIMEOUT_MS = 30_000;

/**
 * The sink of every live session, keyed by session id.
 *
 * Held by the host rather than by the runtime because it is the host's other
 * routes that need it — "is this session still up", "how many are on this
 * box". The sink is also the identity token {@link releaseSession} compares.
 */
export type LiveSessions = Map<string, ClientSink>;

/**
 * Hooks this process supplies because the runtime cannot: `runCode` is the
 * executor behind the `run_code` builtin, and there is no default — omit it and
 * the builtin is simply not offered.
 *
 * ← your sandbox. Do not reach for `eval` or a bare subprocess: the code is
 * model-authored, so whatever you pass here is the isolation boundary.
 */
export type HostHooks = {
  runCode?: RunCodeExecutor;
};

/**
 * Build the engine. Once per process, at boot — not per session.
 *
 * `env` is the agent's own: what its tool code reads as `ctx.env`. Nothing falls
 * back to this process's `process.env`, which is deliberate — assemble it
 * yourself so a credential cannot arrive by accident.
 *
 * `publicUrl` is where the outside world reaches this deployment, which behind a
 * proxy is nothing like the socket you bind. `ctx.workflows.publicWebhookUrl()`
 * is its only reader and throws when it is unset, which beats handing a third
 * party a `localhost` URL it will dial days later. Leave it out if this agent
 * has no webhooks.
 */
export function boot(env: Record<string, string>, hooks: HostHooks = {}): Runtime {
  const publicUrl = process.env.PUBLIC_URL?.trim();
  const options: RuntimeOptions = {
    agent: hosted,
    env,
    sessionStartTimeoutMs: SESSION_START_TIMEOUT_MS,
    shutdownTimeoutMs: SHUTDOWN_TIMEOUT_MS,
    ...(publicUrl ? { publicUrl } : {}),
    ...(hooks.runCode ? { runCode: hooks.runCode } : {}),
  };
  return createRuntime(options);
}

/**
 * What the model will be offered — your own tools plus the builtins the agent
 * enabled. Log it at boot: a tool file that failed to make it into the bundle is
 * visible here, rather than as a model that never calls it.
 */
export function toolInventory(runtime: Runtime): string[] {
  return runtime.toolSchemas.map((schema) => schema.name);
}

/**
 * Which optional surfaces this engine actually has, so your router mounts only
 * the routes something is behind.
 *
 * Both are absent on a runtime that keeps neither — mount their routes anyway
 * and a caller gets a hang or a 500 where a 404 was the honest answer.
 */
export function surfaces(runtime: AgentRuntime): { workflowApi: boolean; sessionEvents: boolean } {
  return {
    workflowApi: runtime.workflows !== undefined,
    sessionEvents: runtime.sessionEvents !== undefined,
  };
}

/**
 * What to start sessions on right now: the engine, or a runtime that declines.
 *
 * Flip `draining` in your `SIGTERM` handler BEFORE calling {@link shutdown}, so
 * sockets arriving during the drain are turned away with a stated reason. The
 * alternative hosts reach for — a placeholder agent — accepts the socket and
 * then answers nothing.
 */
export function sessionsFor(engine: Runtime, draining: boolean): SessionRuntime {
  return draining ? decliningRuntime(DRAINING) : engine;
}

/**
 * One accepted socket. Call this from your upgrade handler, once per connection.
 *
 * It does not return a promise and there is nothing to await: the session's
 * whole life happens on the socket, and these callbacks are how you observe it.
 *
 * `resumeFrom` is the one option that changes what the session IS — it
 * reattaches to a previous session's id and the runtime restores that
 * conversation from its own retained events, not from anything the client claims
 * to remember. Take the id from your own reconnect parameter.
 */
export function attachSocket(
  sessions: SessionRuntime,
  ws: SessionWebSocket,
  live: LiveSessions,
  resumeFrom?: string,
): void {
  const options: SessionStartOptions = {
    ...(resumeFrom ? { resumeFrom } : {}),
    logContext: { deployment: DEPLOYMENT },
    onSinkCreated: (id, sink) => {
      live.set(id, sink);
    },
    onSessionEnd: (id, sink) => releaseSession(live, id, sink),
    onClose: () => console.log("socket closed"),
  };
  sessions.startSession(ws, options);
}

/**
 * Drop a finished session from the registry — comparing the SINK, not just the
 * id.
 *
 * A resume can register a new session under the same id while the old one is
 * still draining, so a teardown keyed on the id alone deletes the live entry and
 * your routes then report the caller as gone while they are still talking. When
 * no sink is given there is nothing to compare and the entry goes.
 */
export function releaseSession(live: LiveSessions, id: string, ending?: ClientSink): void {
  if (ending !== undefined && live.get(id) !== ending) return;
  live.delete(id);
}

/**
 * Stop serving. Once, at the end of the process's life.
 *
 * `shutdown()` waits for live sessions up to `shutdownTimeoutMs` — a voice
 * session in the middle of a sentence is worth a few seconds. Stop accepting
 * sockets first (see {@link sessionsFor}), or you are draining into a queue that
 * keeps refilling.
 */
export async function shutdown(engine: Runtime, live: LiveSessions): Promise<void> {
  await engine.shutdown();
  live.clear();
}
