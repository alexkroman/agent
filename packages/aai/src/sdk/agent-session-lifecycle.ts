// Copyright 2026 the AAI authors. MIT license.
/**
 * The two declarations that bracket a SESSION rather than a turn: what a
 * session is told before its first model call, and what the app does once it
 * has stopped.
 *
 * They exist for a device that has ONE conversation across many sessions — a
 * smart speaker that connects with `?client=<id>` every time somebody says the
 * wake word. The runtime already keeps that client's raw transcript (see
 * `aai-runtime`'s `session-client-history.ts`) and loads the recent part of it
 * into every new session; what it cannot do is decide what an OLDER part of it
 * means. So the app does: {@link AgentSessionLifecycle.onSessionEnd} starts a
 * workflow that summarizes what was just said (reading it back with
 * `stepClientTranscript`), and {@link AgentSessionLifecycle.sessionContext}
 * hands the next session that summary as instructions, with `historySince`
 * narrowing what is loaded verbatim so the summary and the transcript do not
 * both say the same thing.
 *
 * ## Why not `systemPrompt` as a resolver
 *
 * A resolver is SYNCHRONOUS and asked on EVERY request. The context this is for
 * is a database read or a model call — once per connect, not once per turn —
 * and a prompt that changes between requests defeats the provider's prompt
 * cache. So the answer is awaited once, before the first model call, and the
 * text is installed as a STABLE block for the whole session (see
 * `aai-runtime`'s `runtime-system-prompt.ts` for where it lands).
 *
 * ## Why their contexts are narrower than a tool's
 *
 * Neither may speak: `sessionContext` runs before there is anything to say to,
 * and `onSessionEnd` after there is nobody left. So there is no `send`, no
 * `generate`, no `messages` — the same omissions `AgentSessionContext` makes
 * for the same reason. `onSessionEnd` does get `workflows`, because handing
 * work to a run that outlives the session is the whole point of a hook that
 * fires when the session is gone.
 *
 * Split out of `types.ts` at the source-length cap, on the seam the other field
 * groups use. Re-exported from `types.ts`, so it is on the root.
 */

import type { WorkflowClient } from "./workflow.ts";

/**
 * What {@link AgentSessionLifecycle.sessionContext} is called with.
 *
 * @sealed
 * @public
 */
export interface SessionContextArgs {
  /** The session about to start (a fresh id, or the one a `?sessionId=` resumed). */
  sessionId: string;
  /**
   * The client the socket named with `?client=`, when it named one — the key
   * the app's own memory of that client is filed under. Absent for a browser
   * tab or a phone call that sent none.
   */
  clientId?: string;
  /** The agent's environment — the same view a tool reads as `ctx.env`. */
  env: Readonly<Partial<Record<string, string>>>;
  /**
   * Aborted when the runtime stops waiting, `SESSION_CONTEXT_TIMEOUT_MS` after
   * the call. Pass it to whatever you fetch with; an answer that arrives after
   * it fired is dropped.
   */
  signal: AbortSignal;
}

/**
 * What {@link AgentSessionLifecycle.sessionContext} may answer.
 *
 * @public
 */
export type SessionContext = {
  /**
   * Text appended to the system prompt for the WHOLE session, after the agent's
   * own prompt — a memory profile, a summary of older conversations, open
   * reminders. Asked once, so it is byte-stable across the session's requests
   * and the provider's prompt cache keeps working.
   */
  instructions?: string | undefined;
  /**
   * Epoch ms. The client's prior sessions are loaded into the new one verbatim
   * only from this instant on — sessions whose last event is older are left
   * out, and so are older events of a session that straddles it. Set it to the
   * point your `instructions` already summarize up to, so the model is not told
   * the same thing twice. Absent, the runtime's own budget decides.
   */
  historySince?: number | undefined;
  /**
   * Where this client is — the street address the app has on file for it.
   * Recorded as the session's location, REPLACING the one the socket reported
   * with `?location=`, so `google_places`, `open_meteo` and
   * `sessionClientLocation(ctx)` use the app's answer: an address a person
   * typed into the app's settings beats whatever a device was flashed with.
   *
   * Held to the socket's rule: control characters are stripped, and one over
   * 200 characters is ignored. Personal data — the runtime never logs it.
   */
  location?: string | undefined;
};

/**
 * What {@link AgentSessionLifecycle.onSessionEnd} is called with.
 *
 * @sealed
 * @public
 */
export interface SessionEndContext {
  /** The session that stopped. */
  sessionId: string;
  /** The client it belonged to (`?client=`), when it named one. */
  clientId?: string;
  /** The agent's environment — the same view a tool reads as `ctx.env`. */
  env: Readonly<Partial<Record<string, string>>>;
  /**
   * The same `start()` surface a tool's `ctx.workflows` is. Start the run that
   * digests this session here, keyed so a second stop of the same session is a
   * no-op: `{ key: \`${sessionId}:${lastEventIndex}\` }`.
   */
  workflows: WorkflowClient;
  /**
   * The index of the last event this session's log holds, already flushed — or
   * `-1` for a session that recorded nothing. A session resumed and stopped
   * again ends with a HIGHER index, which is what makes it a new key.
   */
  lastEventIndex: number;
}

/**
 * The session-bracketing half of an agent declaration — see this module's
 * header.
 *
 * @public
 */
export interface AgentSessionLifecycle {
  /**
   * Context for a session, fetched once when it connects and before its first
   * model call.
   *
   * ```ts
   * import { agent } from "@alexkroman1/aai";
   *
   * agent({
   *   name: "Kitchen speaker",
   *   async sessionContext({ clientId, env, signal }) {
   *     if (!clientId) return undefined;
   *     const res = await fetch(`${env.MEMORY_URL}/profile/${clientId}`, { signal });
   *     const { summary, summarizedUntil } = await res.json();
   *     return { instructions: summary, historySince: summarizedUntil };
   *   },
   * });
   * ```
   *
   * Bounded by `SESSION_CONTEXT_TIMEOUT_MS` (1.5 s): the caller is waiting to
   * be heard. A throw, a timeout or `undefined` is logged and the session starts
   * without it — a memory service that is down must not stop the speaker
   * answering.
   */
  sessionContext?: (
    ctx: SessionContextArgs,
  ) => Promise<SessionContext | undefined> | SessionContext | undefined;
  /**
   * Called each time a session stops — hang-up, disconnect or idle timeout —
   * after its events are written, so a run it starts can read them back with
   * `stepClientTranscript`.
   *
   * Fire-and-forget: its return value is discarded, an async one is not
   * awaited by anything the caller waits on, and a throw is logged. Delivery is
   * at-least-once across a restart, so key the work it starts (see
   * {@link SessionEndContext.workflows}).
   */
  onSessionEnd?: (ctx: SessionEndContext) => unknown;
}
