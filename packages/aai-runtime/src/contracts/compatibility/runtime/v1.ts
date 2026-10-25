// Copyright 2025 the AAI authors. MIT license.
/**
 * Frozen template: `aai-runtime:runtime` epoch 1.
 *
 * An embedder's bootstrap as it was written against epoch 1: `createRuntime`
 * over an agent and its env, a phone session started on a socket with the call
 * the carrier reported, a console session attached through `connectSession`,
 * and the rejecting runtime a host serves where no agent is deployed. It must
 * keep compiling against current source for as long as epoch 1 is advertised
 * as supported.
 *
 * What epoch 2 moved, and why this file still compiles:
 * `SessionStartOptions.call` takes `SessionCallInput` — the carrier, call id and
 * parameters the bridge hands in, which is everything `SessionCall` was at
 * epoch 1. The probe reports `call.brief` removed on every signature that
 * reaches the options because it reads today's `SessionCall` on both sides;
 * the reader did not exist then, and no embedder could have passed one.
 */

import { type AgentDef, agent } from "@alexkroman1/aai";
import type { ClientSink } from "@alexkroman1/aai/protocol";
import {
  type AgentRuntime,
  connectSession,
  createRuntime,
  type HostAgentOptions,
  type RunCodeExecutor,
  type Runtime,
  type RuntimeOptions,
  rejectingRuntime,
  type runtimeBrand,
  type SessionConnection,
  type SessionConnectOptions,
  type SessionRuntime,
  type SessionStartOptions,
} from "../../../runtime-barrel.ts";
import type { SessionWebSocket } from "../../../session/index.ts";

// --- The agent and its runtime -------------------------------------------------

const frontDesk: AgentDef = agent({ name: "Front desk", systemPrompt: "You answer the phone." });

const runCode: RunCodeExecutor = async (code) =>
  code.length > 10_000 ? { error: "too long" } : "ok";

const host: HostAgentOptions = { agent: frontDesk, runCode, toolTimeoutMs: 30_000 };

const options: RuntimeOptions = {
  ...host,
  env: {},
  publicUrl: "https://desk.example.com",
  shutdownTimeoutMs: 5000,
};

export const runtime: Runtime = createRuntime(options);

/** The brand `createRuntime` stamps, named so a host can type what it holds. */
export type RuntimeBrand = typeof runtimeBrand;

export function isRuntime(candidate: AgentRuntime): candidate is Runtime {
  return "readyConfig" in candidate;
}

// --- A phone session, with the call the carrier reported ----------------------

export function acceptPhone(ws: SessionWebSocket, callSid: string): void {
  const start: SessionStartOptions = {
    skipGreeting: false,
    clientPhone: "+15550100",
    call: { carrier: "twilio", callId: callSid, parameters: { campaign: "spring" } },
    logContext: { carrier: "twilio" },
    onOpen: () => undefined,
    onSessionEnd: (sessionId) => {
      if (sessionId.length === 0) throw new Error("unreachable");
    },
    audioLeadMs: 200,
  };
  runtime.startSession(ws, start);
}

// --- A console session attached to a sink ----------------------------------

export function attach(sink: ClientSink): SessionConnection {
  const connect: SessionConnectOptions = { skipGreeting: true, logContext: { source: "console" } };
  return connectSession(runtime, sink, connect);
}

// --- Where no agent is deployed -----------------------------------------------

export const fallback: SessionRuntime = rejectingRuntime("This agent is not deployed here.");

export async function stop(target: AgentRuntime = runtime): Promise<void> {
  await target.shutdown();
}
