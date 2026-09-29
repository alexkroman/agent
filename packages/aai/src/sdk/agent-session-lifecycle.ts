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

import type { SessionCall } from "./session-call.ts";
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
  /**
   * The phone call, for a session that arrived on `WS /phone`: the carrier, its
   * call id and the stream's custom parameters (`<Parameter>`), from the
   * carrier's `start` frame — which the runtime waits for before it asks you.
   * What the far end CLAIMED; check a parameter your app issued, and `refuse`
   * when it is not one. The same object `sessionCall(ctx)` reads.
   */
  call?: SessionCall;
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
  /**
   * The greeting for THIS session, spoken instead of `agent({ greeting })` —
   * for an opening only known per connect, like an outbound call that names
   * who it is calling for:
   *
   * ```ts
   * import { agent } from "@alexkroman1/aai";
   *
   * agent({
   *   name: "Reminder calls",
   *   greeting: "Hi, this is an AI assistant.",
   *   telephony: ["twilio"],
   *   sessionContext: ({ call }) => ({
   *     greeting: `Hi, this is an AI assistant calling on behalf of ${call?.parameters.for ?? "a customer"}. Do you have a moment?`,
   *   }),
   * });
   * ```
   *
   * It replaces the TEXT, never the decision: a session that would not greet —
   * a resume, `?resume=1` — still does not, and one that would speaks this
   * exactly as it speaks the agent's (synthesized as written, no model call,
   * recorded in history as the agent's opening line, spoken again after a
   * client `reset`). An empty string means no greeting this session. Control
   * characters become spaces, and the text is trimmed and cut at
   * `MAX_SESSION_GREETING_CHARS` (500). Absent — or a throw, or an answer past
   * the `SESSION_CONTEXT_TIMEOUT_MS` deadline — keeps the agent's greeting.
   *
   * Every transport honours it: the pipeline and OpenAI Realtime read it when
   * the greeting fires, AssemblyAI S2S when it sends its session config — both
   * after this hook has answered.
   */
  greeting?: string | undefined;
  /**
   * Refuse the session: the reason, for your logs. The runtime closes it before
   * the greeting and before any model call — a WebSocket client with a 1008
   * (policy violation) close carrying this reason, a phone call by closing the
   * carrier's stream, which hangs up. Logged once, with the session id and this
   * reason and nothing else; never sent to the model. `onSessionEnd` does not
   * fire for a refused session.
   *
   * For a server reachable from outside — a phone agent behind a tunnel — this
   * is what keeps a stranger who found the URL from spending your model:
   *
   * ```ts
   * import { agent } from "@alexkroman1/aai";
   *
   * agent({
   *   name: "Reminder calls",
   *   telephony: ["twilio"],
   *   async sessionContext({ call, env, signal }) {
   *     const id = call?.parameters.call;
   *     if (!id) return { refuse: "not a placed call" };
   *     const res = await fetch(`${env.CALLS_URL}/calls/${id}`, { signal });
   *     if (!res.ok) return { refuse: "unknown call" };
   *     return { instructions: `This call is about: ${(await res.json()).topic}` };
   *   },
   * });
   * ```
   *
   * A throw or a timeout is NOT a refusal — the session starts without context,
   * as it always has — so an app that must refuse on doubt catches its own
   * failures and returns `refuse`. Trimmed and capped at 200 characters; an
   * empty string is ignored.
   */
  refuse?: string | undefined;
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
  /** The phone call it was, for a `WS /phone` session — see {@link SessionContextArgs.call}. */
  call?: SessionCall;
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
