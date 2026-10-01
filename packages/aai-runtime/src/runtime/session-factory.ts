// Copyright 2025 the AAI authors. MIT license.
/**
 * Building ONE session: everything `createRuntimeWithSeams` wires a new
 * `ServerSession` with — its controls, its transport, its core, and the state
 * and event-log bookends — over the runtime-scoped collaborators it is handed.
 */

import { invariant } from "@alexkroman1/aai/internal";
import type { AgentConfig } from "@alexkroman1/aai/manifest";
import { omitUndefined } from "@alexkroman1/aai/utils";
import type { Logger } from "../logger.ts";
import {
  composeSessionGreeting,
  createResumeFindings,
  createSessionCore,
  type ServerSession,
  type SessionDirectory,
} from "../session/index.ts";
import type { ClientToolBroker } from "../tools/index.ts";
import type { TransportCallbacks } from "../transports/types.ts";
import { openSessionWiring } from "./session-controls.ts";
import { openSessionMemory } from "./session-memory.ts";
import { attachSessionState, type RuntimeSessionState } from "./session-state.ts";
import { attachSessionStream } from "./session-stream.ts";
import type { SystemPromptResolver } from "./system-prompt.ts";
import type { setupTools } from "./tools.ts";
import type { createTransportFactory, SessionBuildOpts } from "./transport.ts";
import type { HostRuntimeOptions } from "./types.ts";

export type SessionFactoryDeps = {
  agent: HostRuntimeOptions["agent"];
  env: HostRuntimeOptions["env"];
  agentConfig: AgentConfig;
  logger: Logger;
  sessionState: RuntimeSessionState;
  sessions: SessionDirectory;
  systemPrompts: SystemPromptResolver;
  buildTransport: ReturnType<typeof createTransportFactory>;
  tools: Pick<
    ReturnType<typeof setupTools>,
    "executeTool" | "toolSchemas" | "pushStateSnapshot" | "commitSessionState"
  >;
  clientTools: ClientToolBroker;
  /** Relay (host) mode's tool-result hook, when this runtime relays tools. */
  relayToolResult: HostRuntimeOptions["onToolResult"];
  /** What a session's memory and recall read — shared with the route table. */
  recall: Omit<Parameters<typeof openSessionMemory>[0], "sessionId" | "prompt">;
};

/** The runtime's `createSession`, over its runtime-scoped collaborators. */
export function createSessionFactory(
  deps: SessionFactoryDeps,
): (sessionOpts: SessionBuildOpts) => ServerSession {
  const { agent, env, agentConfig, logger, sessionState, sessions, tools } = deps;

  return function createSession(sessionOpts) {
    // A resume under this id (same key, new socket) reclaims its tool state —
    // cancel the sweep the previous session's stop() scheduled.
    sessionState.sweeps.cancel(sessionOpts.id);
    // Everything one session is wired with before its transport exists — the
    // event emitter and its hooks, the dialogs that address the prompt, the
    // token meter and the guardrails. See `session-controls.ts`.
    const { dialogs, personas, emitter, usage, guardrails } = openSessionWiring({
      agent,
      env,
      sessionId: sessionOpts.id,
      client: sessionOpts.client,
      state: sessionState,
      prompt: deps.systemPrompts,
      limits: agentConfig.usageLimits,
      transport: () => transport,
      logger,
      speech: sessions.speech.of(sessionOpts.id),
      ...omitUndefined({ commitSessionState: tools.commitSessionState }),
    });
    const wiring = { sink: sessionOpts.client, emitter, meter: usage };
    const releaseWiring = sessions.claimWiring(sessionOpts.id, wiring);

    // Late-bound: callbacks are built before the ServerSession, filled in below.
    let core: ServerSession | null = null;
    function bindCore(): ServerSession {
      // An invariant rather than a validation: `core` is this closure's own
      // local, filled in below and readable by nobody else, so a null here is a
      // mis-ordering in THIS function and never anything a caller did.
      invariant(core !== null, "session.core.bound");
      return core;
    }

    // A flat forward: what a report MEANS — a `tool.called` the transport
    // already ran versus one it needs run — is the session core's decision,
    // read off the transport's own `capabilities` (`../session/core.ts`).
    const callbacks: TransportCallbacks = {
      report: (event) => bindCore().report(event),
      onAudioChunk: (bytes) => bindCore().onAudioChunk(bytes),
      onReplyStarted: (replyId) => bindCore().onReplyStarted(replyId),
    };

    // What this resume recovered; must exist BEFORE the transport, and
    // `session/resume-found.ts` owns the decision `skipGreeting` becomes.
    const findings = createResumeFindings();
    const { id, skipGreeting, resumed } = sessionOpts;
    // Before the transport, which reads the greeting `sessionContext` answered.
    const memory = openSessionMemory({ ...deps.recall, sessionId: id, prompt: dialogs.prompt });
    const transport = deps.buildTransport({
      sessionOpts: {
        ...sessionOpts,
        // THE one place the greeting is decided — see `SessionGreeting`.
        greeting: composeSessionGreeting({ skipGreeting, resumed, findings, memory, agentConfig }),
      },
      // The THUNK, not its value: a transport that can resolve per turn does,
      // and one that cannot resolves it once (see `transport.ts`).
      systemPrompt: () => dialogs.prompt.resolve(),
      callbacks,
      guardrails,
      usage,
      ...omitUndefined({ dialogTurn: dialogs.turnKnobs, personaTurn: personas.turnKnobs }),
      ...omitUndefined({ personaInterruption: personas.interruption }),
    });

    core = createSessionCore({
      id: sessionOpts.id,
      agent: sessionOpts.agent,
      client: sessionOpts.client,
      emitter,
      agentConfig,
      executeTool: tools.executeTool,
      toolSchemas: tools.toolSchemas,
      transport,
      logger,
      ...omitUndefined({ onToolResult: deps.relayToolResult }),
      clientTools: deps.clientTools,
    });

    // Hydration in, reclamation out — `attachSessionState` owns both orderings
    // and why they are here rather than in `ws-handler`.
    attachSessionState(core, {
      state: sessionState,
      sessionId: sessionOpts.id,
      emitter,
      // Both claims come off together: they are one session's hold on one id, and
      // releasing only the sink would leave a `ctx.send` from a straggling tool
      // call resolving an emitter whose socket is gone.
      release: () => {
        // The dialog deadlines come off here too: a pending timer keeps the
        // event loop alive and would fire into a session already swept.
        dialogs.stop();
        return releaseWiring();
      },
      pushStateSnapshot: tools.pushStateSnapshot,
      findings,
    });

    // The event log's own bookends — `session-stream.ts`, which also
    // restores the client's prior sessions (`memory`) beside a resume's own log.
    attachSessionStream(core, {
      stream: sessionState.stream,
      sessionId: sessionOpts.id,
      resumed: sessionOpts.resumed === true,
      findings,
      memory,
    });

    return core;
  };
}
