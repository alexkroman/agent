// Copyright 2026 the AAI authors. MIT license.
/**
 * `ToolContext` — the second argument every tool's `run` receives.
 *
 * Its own module because it is the biggest type in `types.ts` and the one an
 * author reads most often, and that file was at the file-length cap. Re-exported
 * from `types.ts` (and so from the package root), so nothing imports it from
 * here: the split is packaging, not a new surface.
 */

import type { AgentContext } from "./agent-context.ts";
import type { DefaultSessionState, Message } from "./session-state.ts";
import type { WorkflowClient } from "./workflow.ts";

/**
 * Context passed to tool `run` functions.
 *
 * {@link AgentContext} — `env`, `db`, `generate`, `signal` — plus everything that
 * only makes sense inside a live session: the per-session state, the conversation
 * so far, the client to push events to, and the handle for starting work that
 * outlives the session. A helper that needs only the base four should be typed
 * against `AgentContext` so a workflow can call it too.
 *
 * @typeParam S - The shape of per-session state created by the agent's
 *   `state` factory. Defaults to {@link DefaultSessionState}; annotate the
 *   context (`ctx: ToolContext<MyState>`) to get real checking.
 *
 * @example
 * ```ts
 * import { tool } from "@alexkroman1/aai";
 * import { z } from "zod";
 *
 * const lookupNote = tool({
 *   description: "Look up a note from the database",
 *   input: z.object({ id: z.string() }),
 *   run: async ({ id }, ctx) => {
 *     const rows = await ctx.db.query("select body from notes where id = $1", [id]);
 *     return { id, note: rows[0] ?? null };
 *   },
 * });
 * ```
 *
 * @public
 */
export interface ToolContext<S = DefaultSessionState> extends AgentContext {
  /** Mutable per-session state created by the agent's `state` factory. */
  state: S;
  /**
   * Start and inspect durable workflow runs ({@link WorkflowClient}).
   *
   * The seam between a turn and work that outlives it: `start()` resolves as
   * soon as the run is journaled, so a tool can answer the caller in the same
   * turn while the run continues past the end of the session. Requires
   * storage, and requires the workflow to be declared in
   * {@link AgentDef.workflows} — both surface as a rejected promise naming
   * what is missing.
   */
  workflows: WorkflowClient;
  /** Read-only snapshot of conversation messages so far. */
  messages: readonly Message[];
  /** Unique identifier for the current session. Useful for correlating logs across concurrent sessions. */
  sessionId: string;
  /**
   * Push a custom event to the connected browser client. Fire-and-forget:
   * events whose name exceeds {@link MAX_CLIENT_EVENT_NAME_LENGTH} or whose
   * serialized payload exceeds {@link MAX_CLIENT_EVENT_PAYLOAD_BYTES} are
   * dropped (with a warning log), not thrown.
   */
  send(event: string, data: unknown): void;
}
