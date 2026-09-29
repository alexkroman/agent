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
 * - **Ask `sessionContext`** (`session-context.ts`) once, bounded, and install
 *   its `instructions` as the prompt's stable context block and its `location`
 *   as the session's (over the socket's `?location=`). Concurrently with
 *   the bind: neither needs the other, and both are on the start path.
 * - **Load the client's prior sessions** (`session-client-history.ts`), narrowed
 *   by the context's `historySince`, and hand them to
 *   `runtime-session-stream.ts`, which restores them together with a resume's
 *   own log in ONE `restoreHistory` — so a connect produces one
 *   `history.restored` frame and one seed, never two that could overlap.
 *
 * And on the way out, **`onSessionEnd`**, after the stream has flushed, so a run
 * it starts reads the session's last words rather than racing their write.
 *
 * The client id is read from `sessionClientId` rather than passed down, because
 * that is where the socket recorded it (`ws-handler.ts`, before the session
 * was built) and where a resume that named no client keeps the one it had. A
 * direct `runtime.createSession()` caller that recorded none gets no client
 * memory, and `sessionContext` without a `clientId` — which is the honest answer.
 */

import { type AgentDef, type SessionEvent, sessionClientId } from "@alexkroman1/aai";
import { setSessionLocation } from "@alexkroman1/aai/host-internal";
import { rejectingWorkflows, WORKFLOWS_UNAVAILABLE_MESSAGE } from "@alexkroman1/aai/internal";
import { errorMessage, omitUndefined } from "@alexkroman1/aai/utils";
import type { WorkflowClient } from "@alexkroman1/aai/workflow-api";
import { feedClientSessionEnd } from "./client-event-feed.ts";
import type { Logger } from "./runtime-config.ts";
import type { SessionSystemPrompt } from "./runtime-system-prompt.ts";
import {
  bindClientSession,
  type ClientHistoryDeps,
  loadClientHistory,
} from "./session-client-history.ts";
import { resolveSessionContext } from "./session-context.ts";

/** What `attachSessionStream` calls on the way in and on the way out. */
export type SessionMemory = {
  /**
   * Bind, ask for context, and answer the client's prior events (oldest first;
   * empty for a session that named no client). Never rejects.
   */
  open(): Promise<readonly SessionEvent[]>;
  /** The session stopped and its log is flushed through `lastEventIndex`. Never throws. */
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
  return {
    async open() {
      const clientId = clientOf();
      const [context] = await Promise.all([
        resolveSessionContext({
          hook: agent.sessionContext,
          args: { sessionId, env, ...omitUndefined({ clientId }) },
          logger,
        }),
        clientId === undefined ? undefined : bindClientSession(deps.history, sessionId, clientId),
      ]);
      if (context?.instructions) deps.prompt.setContext(context.instructions);
      // AFTER the socket's `?location=` (recorded before the session was built),
      // so the app's answer is the one the builtins and `sessionClientLocation` read.
      if (context?.location) setSessionLocation(sessionId, context.location);
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
      if (!hook) return;
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
          ...omitUndefined({ clientId: clientOf() }),
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
