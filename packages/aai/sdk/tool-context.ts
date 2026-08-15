// Copyright 2026 the AAI authors. MIT license.
/**
 * `ToolContext` — everything a tool's `execute` is handed.
 *
 * Split out of `types.ts` when adding `ctx.workflows` took that file over the
 * 500-line cap. The seam is the one the file already had: `types.ts` keeps the
 * agent-level declarations (`AgentDef`, `ToolDef`, the message and builtin
 * vocabularies) while this holds the per-CALL context, which is the half a tool
 * author reads and the half that grows a field every time the runtime gains a
 * capability (`db`, then `generate`, now `workflows`).
 *
 * Re-exported from `types.ts`, so no import path changes.
 */

import type { Db } from "./db.ts";
import type { GenerateFn } from "./generate.ts";
import type { SlotStore } from "./session-state.ts";
import type { Message } from "./types.ts";
import type { StartOptions, WorkflowClient } from "./workflow.ts";

/**
 * Context passed to tool `execute` functions.
 *
 * Provides access to the session environment, state, database, and
 * conversation history from within a tool's execute handler.
 *
 * @remarks
 * It takes no type parameter. It used to take the agent's state shape, because
 * `ctx.state` was a bag whose type a tool could only learn from an annotated
 * context — so every module in a multi-file agent either restated the
 * annotation or cast. {@link sessionSlot} is the whole of that job now: a
 * slot's value is typed by the slot, in the one module that declares it.
 *
 * @example
 * ```ts
 * import { tool } from "@alexkroman1/aai";
 * import { z } from "zod";
 *
 * const lookupNote = tool({
 *   description: "Look up a note from the database",
 *   inputSchema: z.object({ id: z.string() }),
 *   execute: async ({ id }, ctx) => {
 *     const rows = await ctx.db.query("select body from notes where id = $1", [id]);
 *     return { id, note: rows[0] ?? null };
 *   },
 * });
 * ```
 *
 * @public
 */
export type ToolContext = {
  /**
   * Environment variables available to this agent's tools (from `.env` under
   * `aai dev`, `aai secret` in production). Custom keys a tool depends on
   * should be declared in {@link AgentDef.requiredEnv} so a missing value
   * fails at deploy time.
   */
  env: Readonly<Record<string, string>>;
  /**
   * This session's slot storage. **Reach for {@link sessionSlot}, not this** —
   * it is on the context because a slot declared in one module has no other way
   * to find the session, not because a tool body should call it.
   *
   * It replaced `ctx.state`, a field typed `any` whose whole justification was
   * that the bag it held was dynamic. There is no bag: a slot owns its value,
   * types it, and is the only thing that writes it.
   */
  slots: SlotStore;
  /**
   * SQL database scoped to this app. Available when storage is enabled
   * (`aai storage enable`, or Settings → Database in the studio); accessing
   * it otherwise throws.
   */
  db: Db;
  /**
   * One-shot LLM generation, executed on the host (like `db`).
   * Defaults to the agent's pipeline `llm`; pass `llm` in the options to use
   * another provider (its API key must be in the agent's env). Throws when
   * no LLM is configured or named. Pass a Zod `schema` for typed structured
   * output ({@link GenerateFn}).
   */
  generate: GenerateFn;
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
  /**
   * Cooperative cancellation signal. Aborts when the turn that issued this
   * tool call is cancelled (barge-in, reset, or session stop), and also when
   * the call itself settles exceptionally — above all on timeout. Long-running
   * tools should pass it to `fetch` etc. so their work stops promptly.
   *
   * @remarks
   * Always present. It was optional until it was checked: the executor builds
   * a per-call `AbortController` on every path and there has never been a
   * context without one, so the `?` only bought authors a `?.` on every
   * `ctx.signal.aborted` and a `!` wherever a non-optional `AbortSignal` was
   * wanted. A context that genuinely cannot cancel supplies a signal that
   * never aborts rather than omitting the field.
   */
  signal: AbortSignal;
  /**
   * Start and inspect durable workflow runs — the way a tool hands off work that
   * must outlive the call.
   *
   * A voice tool cannot do slow work inline: the caller is on the line. So it
   * starts a run and answers in the same turn ("I've kicked that off, I'll text
   * you"), and the run continues on the queue after the session ends. Pass
   * `{ key: ctx.sessionId }` so a later turn — or a later CALL — can find it
   * again; see {@link StartOptions.key}.
   *
   * Every method rejects when the app declares no workflows or has no workflow
   * backend configured, naming which.
   */
  workflows: WorkflowClient;
};
