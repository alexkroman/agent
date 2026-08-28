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

import type { GenerateFn } from "./generate.ts";
import type { SlotStore } from "./session-state.ts";
import type { DelegateFn } from "./subagent.ts";
import type { Message } from "./types.ts";
import type { WorkflowClient } from "./workflow.ts";

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
 *   description: "Look up a note",
 *   inputSchema: z.object({ id: z.string() }),
 *   execute: async ({ id }, ctx) => {
 *     // `ctx.env` for a credential, and whatever client the author brought —
 *     // there is no `ctx.db`, because the platform hands tool code no database.
 *     const res = await fetch(`${ctx.env.NOTES_API}/notes/${id}`);
 *     return { id, note: res.ok ? await res.json() : null };
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
   *
   * **`Partial`, so every read is `string | undefined`.** A variable that was
   * never set is `undefined` at runtime whatever the type says, and the type
   * used to say `string`: `ctx.env.NEVER_DECLARED` type-checked, built green,
   * and threw a `TypeError` on the first live call — which `tool-executor.ts`
   * then hands to the MODEL, so the caller hears the agent improvise an
   * apology. `noUncheckedIndexedAccess` says the same thing, but it is the
   * AUTHOR's tsconfig and cannot be relied on from here.
   *
   * Reach for {@link requireEnv} rather than a `??` at each site — it throws
   * a sentence naming the variable and pointing at `requiredEnv`.
   */
  env: Readonly<Partial<Record<string, string>>>;
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
   * One-shot LLM generation, executed on the host.
   * Defaults to the agent's pipeline `llm`; pass `llm` in the options to use
   * another provider (its API key must be in the agent's env). Throws when
   * no LLM is configured or named. Pass a Zod `schema` for typed structured
   * output ({@link GenerateFn}).
   */
  generate: GenerateFn;
  /**
   * Hand a bounded task to a SUBAGENT — a second tool loop with its own
   * instructions, model, tools and context window — and get back what it
   * concluded, not how it got there ({@link DelegateFn}).
   *
   * The sibling of {@link ToolContext.generate}, and the line between them is
   * how many model turns the answer takes: `generate` is one prompt, `delegate`
   * is a loop whose intermediate tool results the caller has no reason to
   * carry. Executes on the host wherever the runtime runs, like `generate`.
   *
   * **A subagent's own tools cannot delegate further** — their `ctx.delegate`
   * rejects naming the reason. One level is a bill a caller can quote; a
   * subagent that may delegate can delegate to itself, and nothing at this
   * seam can see the recursion.
   *
   * @remarks
   * The TENTH field on this type, and the one that raised `guard-invariants`
   * rule 24 from nine. Recorded here because that is where a baselined
   * occurrence's reason belongs: a field on this type is a capability the
   * runtime must supply on EVERY tool call, on every host, in every test
   * double — so it is a promise, not a convenience, and the rule exists to make
   * adding one an argued decision rather than a diff nobody reads.
   *
   * The argument for this one is that it passes the test the rule sets: it is
   * per-CALL and it cannot be reached any other way. A tool body cannot build a
   * subagent runner itself — resolving the model, the builtins, the step budget
   * and the nesting refusal are all the host's, exactly as they are for
   * `generate`. Anything reachable from a value the author already holds is not
   * this, and belongs in that value's own module.
   */
  delegate: DelegateFn;
  /** Read-only snapshot of conversation messages so far. */
  messages: readonly Message[];
  /** Unique identifier for the current session. Useful for correlating logs across concurrent sessions. */
  sessionId: string;
  /**
   * Push a custom event to the connected browser client. Fire-and-forget:
   * events whose name exceeds `MAX_CLIENT_EVENT_NAME_LENGTH` or whose
   * serialized payload exceeds `MAX_CLIENT_EVENT_PAYLOAD_BYTES` are
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
   * again; see `StartOptions.key` (`@alexkroman1/aai/workflow-api`).
   *
   * Every method rejects when the app declares no workflows or has no workflow
   * backend configured, naming which.
   */
  workflows: WorkflowClient;
};
