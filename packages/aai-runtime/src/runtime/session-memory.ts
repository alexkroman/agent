// Copyright 2026 the AAI authors. MIT license.
/**
 * One session's MEMORY wiring: what it is told at connect, what it remembers of
 * its client, and who is told when it stops.
 *
 * Three agent-facing features meet here because they share one lifetime — the
 * session's `start()` and `stop()` — and one key, the client the socket named:
 *
 * - **Bind** the session to its client (`session-state/clients.ts`), so its
 *   events outlive the grace sweep and its client's next session can read them.
 * - **Ask `sessionContext`** (`session/context.ts`) once, bounded, and install
 *   its `instructions` as the prompt's stable context block and its `location`
 *   as the session's (over the socket's `?location=`). Concurrently with
 *   the bind: neither needs the other, and both are on the start path. A
 *   `refuse` installs nothing and is left on {@link SessionMemory.refused} for
 *   the stream to act on; a `greeting` is left on {@link SessionMemory.greeting}
 *   for the transport, which reads it when the greeting fires.
 * - **Load the client's prior sessions** (`session/client-history.ts`), narrowed
 *   by the context's `historySince`, and hand them to
 *   `session-stream.ts`, which restores them together with a resume's
 *   own log in ONE `restoreHistory` — so a connect produces one
 *   `history.restored` frame and one seed, never two that could overlap.
 *
 * And on the way out, **`onSessionEnd`**, after the stream has flushed, so a run
 * it starts reads the session's last words rather than racing their write.
 *
 * The client id is read from `sessionClientId` rather than passed down, because
 * that is where the socket recorded it (`session/ws-handler.ts`, before the session
 * was built) and where a resume that named no client keeps the one it had. A
 * direct `runtime.createSession()` caller that recorded none gets no client
 * memory, and `sessionContext` without a `clientId` — which is the honest answer.
 */

import {
  type AgentDef,
  type SessionCall,
  type SessionEvent,
  sessionCall,
  sessionClientId,
} from "@alexkroman1/aai";
import { recordSessionIdentity } from "@alexkroman1/aai/host-internal";
import { rejectingWorkflows, WORKFLOWS_UNAVAILABLE_MESSAGE } from "@alexkroman1/aai/internal";
import { errorMessage, omitUndefined } from "@alexkroman1/aai/utils";
import type { WorkflowClient } from "@alexkroman1/aai/workflow-api";
import { feedClientSessionEnd } from "../inbox/index.ts";
import type { Logger } from "../runtime-config.ts";
import {
  bindClientSession,
  type ClientHistoryDeps,
  loadClientHistory,
  resolveSessionContext,
} from "../session/index.ts";
import type { SessionSystemPrompt } from "./system-prompt.ts";

/** What `attachSessionStream` calls on the way in and on the way out. */
export type SessionMemory = {
  /**
   * Bind, ask for context, and answer the client's prior events (oldest first;
   * empty for a session that named no client). Never rejects.
   */
  open(): Promise<readonly SessionEvent[]>;
  /**
   * The reason `sessionContext` answered with `refuse`, once `open()` has
   * settled — `undefined` for a session it let through. Acting on it is the
   * stream's (`session-stream.ts`), which is what wraps `start()`.
   */
  readonly refused: string | undefined;
  /**
   * The greeting `sessionContext` answered, once `open()` has settled — `""`
   * for "none this session", `undefined` for "the agent's" (no answer, no
   * field, a timeout, or a refusal).
   *
   * A getter the transport reads LATE rather than a value handed to it: the
   * transport is built before `open()` runs, and every transport speaks (or
   * sends) its greeting only after `start()`, which `open()` precedes — see
   * `session-stream.ts`. So the answer is in time without the session
   * waiting any longer than it already waits for the hook.
   */
  readonly greeting: string | undefined;
  /**
   * The session stopped and its log is flushed through `lastEventIndex`. Never
   * throws. A no-op for a REFUSED session: it never began, and a summarizer
   * started for it would digest a conversation a stranger was denied.
   */
  ended(lastEventIndex: number): void;
};

/**
 * Build one session's memory wiring.
 *
 * @internal
 */
export function openSessionMemory(deps: {
  agent: Pick<AgentDef, "sessionContext" | "onSessionEnd">;
  /** The AGENT's env — what a tool reads as `ctx.env`, never the provider env. */
  env: Readonly<Partial<Record<string, string>>>;
  workflows: WorkflowClient | undefined;
  history: ClientHistoryDeps;
  prompt: Pick<SessionSystemPrompt, "setContext">;
  sessionId: string;
  logger: Logger;
}): SessionMemory {
  const { agent, env, sessionId, logger } = deps;
  const sid = sessionId.slice(0, 8);
  const clientOf = (): string | undefined => sessionClientId({ sessionId });
  // Read where the socket recorded it, like the client id: `session/ws-handler.ts` sets
  // it before the session is built, from the carrier's `start` frame.
  const callOf = (): SessionCall | undefined => sessionCall({ sessionId });
  let refused: string | undefined;
  let greeting: string | undefined;
  return {
    get refused() {
      return refused;
    },
    get greeting() {
      return greeting;
    },
    async open() {
      const clientId = clientOf();
      const call = callOf();
      const [context] = await Promise.all([
        resolveSessionContext({
          hook: agent.sessionContext,
          args: { sessionId, env, ...omitUndefined({ clientId, call }) },
          logger,
        }),
        clientId === undefined ? undefined : bindClientSession(deps.history, sessionId, clientId),
      ]);
      if (context?.refuse !== undefined) {
        // Nothing else is installed: the session is about to be closed, and a
        // refused stranger's connect must not load the client's history either.
        refused = context.refuse;
        return [];
      }
      if (context?.instructions) deps.prompt.setContext(context.instructions);
      greeting = context?.greeting;
      // AFTER the socket's `?location=` (recorded before the session was built),
      // so the app's answer is the one the builtins and `sessionClientLocation` read.
      if (context?.location) recordSessionIdentity(sessionId, { location: context.location });
      if (clientId === undefined) return [];
      return await loadClientHistory(deps.history, {
        clientId,
        excludeSessionId: sessionId,
        since: context?.historySince,
      });
    },
    ended(lastEventIndex) {
      // The client's live feed hears it first: its log is flushed, which is what
      // a page reacting to it (reading the transcript back) relies on.
      feedClientSessionEnd(sessionId);
      const hook = agent.onSessionEnd;
      if (!hook || refused !== undefined) return;
      const report = (err: unknown): void => {
        logger.warn("onSessionEnd failed", { sid, error: errorMessage(err) });
      };
      try {
        const result: unknown = hook({
          sessionId,
          env,
          lastEventIndex,
          // The surface a tool's `ctx.workflows` is, minus `notify`: there is no
          // session left to announce a result to.
          workflows: deps.workflows ?? rejectingWorkflows(WORKFLOWS_UNAVAILABLE_MESSAGE),
          ...omitUndefined({ clientId: clientOf(), call: callOf() }),
        });
        // Not awaited by anything the caller waits on — but a rejection is
        // still this hook's failure, and an unhandled one would take the process.
        // `Promise.resolve` so any thenable is covered, and a plain value is a no-op.
        Promise.resolve(result).catch(report);
      } catch (err: unknown) {
        report(err);
      }
    },
  };
}
