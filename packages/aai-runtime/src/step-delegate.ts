// Copyright 2026 the AAI authors. MIT license.
/**
 * The published half of `stepDelegate` — a subagent runner for a workflow step
 * (`sdk/step-delegate.ts` in `@alexkroman1/aai` holds the contract and the slot).
 *
 * It is `createSubagentRunner` with a SESSIONLESS parent bag, and that reuse is
 * the whole design: the alternative is a second tool loop, and the last thing a
 * subagent's behaviour should depend on is which side of the `ToolContext`
 * boundary reached it. So a `SubagentDef` delegated from a step gets the same
 * model resolution, the same `executeToolCall` for its tools, the same forced
 * final answer at the budget, and the same guardrail loop as one delegated from
 * a tool.
 *
 * ## What "sessionless" costs, precisely
 *
 * `ToolCallDefaults` is `env` plus a handful of optional capabilities, so a step
 * supplies the two it has — the agent env and a logger — and every other field
 * is legitimately absent:
 *
 * - **no `slots` / `sessionId`** — a run is not a session. `executeToolCall`
 *   hands a sessionless caller a DETACHED slot store, so a subagent tool that
 *   reaches for one gets a working object whose writes go nowhere, which is the
 *   honest shape: there is nothing for them to be committed to. It also MINTS a
 *   session id per call rather than passing `""`, and for a fan-out that is the
 *   half that matters: the `remember`/`recall` builtins key their notes by that
 *   id in a process-wide map, so N concurrent `investigate` steps sharing one
 *   bucket would read each other's notes.
 * - **no `messages`** — a delegated run never sees a transcript anyway, session
 *   or not; that is what `DelegateOptions.task` is for.
 * - **no `workflows`** — a subagent's tool cannot start a run. It is already
 *   inside one, and a step that wants to fan out has `mapConcurrent`.
 * - **no `signal`** — nothing cancels a step from outside. The engine's own
 *   deadline is the delivery timeout, which abandons the walk rather than
 *   unwinding it.
 *
 * ## The default model is the GATEWAY's, like `stepGenerate`'s
 *
 * A step has no agent definition to read an `llm` off — `installWorkflowSupport`
 * is handed an env and a logger, and a workflow app has no pipeline at all. So
 * the default is `ASSEMBLYAI_LLM_DEFAULT_MODEL` through the AssemblyAI LLM
 * Gateway on `ASSEMBLYAI_API_KEY`, exactly what `stepGenerate` resolves and for
 * the same reason: a workflow and the agent beside it should not silently run on
 * different models. A `SubagentDef.llm` still wins, so a step that wants a
 * cheaper or a bigger model names one.
 */

import type { StepDelegateFn } from "@alexkroman1/aai/host-internal";
import { normalizeLlm } from "@alexkroman1/aai/host-internal";
import { ASSEMBLYAI_LLM_DEFAULT_MODEL } from "@alexkroman1/aai/llm";
import { omitUndefined } from "@alexkroman1/aai/utils";
import type { Logger } from "./runtime-config.ts";
import { createSubagentRunner } from "./subagent.ts";

/**
 * Build the runner `installWorkflowSupport` publishes.
 *
 * The agent env is taken as a RECORD and frozen into the runner rather than read
 * per call, matching every other consumer here: `installWorkflowSupport` already
 * owns the one copy of it, and a runner that re-read a mutable global would make
 * a subagent's credential depend on when in the run it happened to be reached.
 *
 * @internal
 */
export function createStepDelegate(options: {
  env?: Record<string, string> | undefined;
  logger: Logger;
}): StepDelegateFn {
  const env = options.env ?? {};
  // Resolved ONCE, not per delegation: `normalizeLlm` returns a fresh descriptor
  // object each call, and `createSubagentRunner` memoizes its model clients per
  // descriptor OBJECT — so re-normalizing here would build a new provider client
  // for every step in a fan-out.
  const llm = normalizeLlm(ASSEMBLYAI_LLM_DEFAULT_MODEL);
  const run = createSubagentRunner({ llm, env, logger: options.logger });
  return (subagent, delegateOptions) =>
    run(subagent, delegateOptions, { env, ...omitUndefined({ logger: options.logger }) });
}
