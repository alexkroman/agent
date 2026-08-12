// Copyright 2026 the AAI authors. MIT license.
/**
 * {@link AgentContext} — the capabilities a tool and a workflow BOTH get.
 *
 * `ToolContext` and `WorkflowContext` were two independent declarations that
 * happened to agree on four fields, so a helper reaching for any of them had to
 * pick one context and stop being callable from the other. Both are now that base
 * plus their own capability group, which is the whole content of "one context":
 * the shared surface is a type you can name.
 *
 * Re-exported from `types.ts` and the package root; nothing imports it from here.
 */

import type { Db } from "./db.ts";
import type { GenerateFn } from "./generate.ts";

/**
 * What a tool's `run` and a workflow's `run` both receive.
 *
 * Write a helper against this and it is callable from either — which is the point,
 * because the code that wants to be shared is exactly the code that only needs
 * these four: read a credential, query the app database, ask a model something.
 *
 * ```ts
 * import type { AgentContext } from "@alexkroman1/aai";
 *
 * // Callable from a tool's `run` and from inside a workflow's `ctx.step`.
 * export async function creditLimit(ctx: AgentContext, userId: string): Promise<number> {
 *   const rows = await ctx.db.query<{ limit: number }>(
 *     "select limit from accounts where user_id = $1",
 *     [userId],
 *   );
 *   return rows[0]?.limit ?? 0;
 * }
 * ```
 *
 * **What is deliberately NOT here, and why the omissions are the design.** The
 * session-scoped fields (`state`, `messages`, `sessionId`, `send`) are absent
 * because a workflow has no session — it outlives the one that started it, so
 * there is nothing to read state from or send an event to. The durable ones
 * (`step`, `sleep`, `waitFor`, `continueAs`) are absent because a tool call is not
 * a journaled run: giving `ToolContext` a `step` that merely called its function
 * would make `chargeCard(ctx)` LOOK portable while flipping exactly-once to
 * at-least-once invisibly, which is the one property a caller cannot check for
 * itself. Portability comes from this type, not from a method that means two
 * different things.
 *
 * @public
 */
export interface AgentContext {
  /**
   * Environment variables available to this app (from `.env` under `aai dev`,
   * `aai secret` in production). Names the code depends on should be declared in
   * {@link AgentDef.requiredEnv} so a missing value fails at deploy time rather
   * than mid-call or mid-run.
   */
  env: Readonly<Record<string, string>>;
  /**
   * SQL database scoped to this app.
   *
   * The TYPE is the same in both contexts and the GUARANTEE is not: inside a
   * workflow it is always available, because the journal that makes the run
   * durable lives here, while in a tool it throws unless storage is enabled
   * (`aai storage enable`, or Settings → Database in the studio). Shared code
   * that must work either way should treat a throw as "storage is off".
   */
  db: Db;
  /**
   * One-shot LLM generation, executed on the host (like `db`).
   *
   * Defaults to the agent's pipeline `llm`; pass `llm` in the options to use
   * another provider (its API key must be in the agent's env). Throws when no LLM
   * is configured or named. Pass a Zod `schema` for typed structured output
   * ({@link GenerateFn}).
   */
  generate: GenerateFn;
  /**
   * Cooperative cancellation signal: aborts when the work that owns this context
   * is being abandoned. Pass it to `fetch` and anything else long-running.
   *
   * What abandonment MEANS differs by context, and neither is a failure worth
   * reporting. In a tool it is the turn being cancelled (barge-in, reset, session
   * stop) or the call itself settling exceptionally — above all on timeout. In a
   * workflow it is the host draining, or the run being cancelled while this
   * process happens to be executing it; a drained run resumes from its last
   * journaled step, so abandoning work is safe either way.
   *
   * Always present. In a tool it was optional until it was checked: the executor
   * builds a per-call `AbortController` on every path and there has never been a
   * context without one, so the `?` only bought authors a `?.` on every
   * `ctx.signal.aborted`. A context that genuinely cannot cancel supplies a signal
   * that never aborts rather than omitting the field.
   */
  signal: AbortSignal;
}
