// Copyright 2026 the AAI authors. MIT license.
/**
 * How the runtime attaches session analytics (`host/analytics.ts`).
 *
 * Split out of `runtime.ts` because the wiring has two halves that live at
 * different scopes and each needs its reasoning stated: one recorder per
 * session, and one tool-executor wrapper for the whole runtime.
 *
 * Everything here is inert without a sink — `createRuntimeAnalytics(undefined)`
 * returns wrappers that are the identity function, so an agent that never
 * enabled analytics pays one branch per session and nothing else.
 */

import type { ExecuteTool } from "../sdk/agent-config.ts";
import { createOwnedMap } from "../sdk/owned-map.ts";
import type { ClientSink } from "../sdk/protocol.ts";
import { type AnalyticsSink, createSessionAnalytics, type SessionAnalytics } from "./analytics.ts";

export type RuntimeAnalytics = {
  /**
   * Build a recorder for one session, claim its slot, and hand back the
   * session options with the CLIENT SINK substituted — or the options
   * untouched when analytics is off.
   *
   * The substitution happens here, once, because the recorder observes
   * through that sink: everything downstream must use the wrapped one
   * (`sinkMap`, which `ctx.send` writes to; the transport callbacks' direct
   * `tool_call` emits; SessionCore itself), and doing it at the single point
   * the options are threaded from makes that true by construction rather
   * than by remembering at four call sites.
   *
   * `wireSessionSocket` keeps handing the RAW sink to `onSinkCreated` and
   * `onSessionEnd`, which is correct and must stay that way: the platform
   * compares those two by identity to tell a resumed session from the one it
   * superseded, and both come from ws-handler.
   *
   * `release` must be called on teardown, and releases BY IDENTITY — a resume
   * re-claims the id while the superseded session's async stop is still
   * draining, so a keyed delete would evict the successor's recorder.
   */
  attachSession<T extends { id: string; agent: string; client: ClientSink }>(
    sessionOpts: T,
  ): { sessionOpts: T; recorder: SessionAnalytics | null; release: () => void };
  /**
   * Time every tool call, whichever transport runs it.
   *
   * Wrapped ONCE, at runtime scope, rather than per session: pipeline-mode
   * tools execute inside `streamText`, which closes over the runtime-level
   * executor, so a per-session wrapper would silently cover S2S sessions only
   * — and tool reliability is exactly the metric a pipeline agent's author
   * asks for. `ExecuteTool` carries the session id, so the per-session
   * recorder is a lookup rather than a capture.
   */
  wrapExecuteTool(execute: ExecuteTool): ExecuteTool;
  /** Drop every recorder — the runtime's own `releaseResources`. */
  clear(): void;
};

export function createRuntimeAnalytics(sink: AnalyticsSink | undefined): RuntimeAnalytics {
  const recorders = createOwnedMap<string, SessionAnalytics>();

  return {
    attachSession(sessionOpts) {
      if (!sink) return { sessionOpts, recorder: null, release: () => undefined };
      const recorder = createSessionAnalytics({
        sink,
        sessionId: sessionOpts.id,
        agent: sessionOpts.agent,
      });
      const release = recorders.claim(sessionOpts.id, recorder);
      return {
        sessionOpts: { ...sessionOpts, client: recorder.wrapSink(sessionOpts.client) },
        recorder,
        release: () => {
          release();
        },
      };
    },

    wrapExecuteTool(execute) {
      if (!sink) return execute;
      return (name, args, sessionId, messages, callOpts) => {
        const recorder = sessionId === undefined ? undefined : recorders.get(sessionId);
        const wrapped = recorder ? recorder.wrapExecuteTool(execute) : execute;
        return wrapped(name, args, sessionId, messages, callOpts);
      };
    },

    clear() {
      recorders.clear();
    },
  };
}
