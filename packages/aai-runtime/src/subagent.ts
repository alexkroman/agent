// Copyright 2026 the AAI authors. MIT license.
/**
 * Host-side implementation of the `ctx.delegate` capability
 * (see `sdk/subagent.ts` in `@alexkroman1/aai` for the contract).
 *
 * A subagent is the AI SDK's own subagent pattern — a `ToolLoopAgent` invoked
 * from inside a tool's `execute` — with the three things that pattern leaves
 * to the author supplied by the runtime instead:
 *
 * - **the model**, resolved through the same `resolveLlm` registry the
 *   pipeline and `ctx.generate` use, with credentials from the agent's env and
 *   never `process.env`;
 * - **the tools**, run through {@link executeToolCall} like every other tool
 *   call, so a subagent's tools get argument coercion, Standard Schema
 *   validation, the per-call deadline, a real `ToolContext`, and
 *   failure-shaped-as-a-tool-result — the same guarantees the parent loop
 *   gives, rather than a second hand-rolled set;
 * - **the step budget**, whose last step is spent with `toolChoice: "none"` so
 *   a capped subagent ANSWERS instead of stopping mid-chain. That is
 *   {@link forceFinalAnswer}, the same rule and the same code as the voice
 *   pipeline and {@link createTextAgent}.
 *
 * Like `db` and `generate`, one implementation runs wherever the runtime runs —
 * in-process under `aai dev`, inside the guest sandbox on the platform — so
 * dev and prod cannot drift on what a delegated run may reach.
 *
 * **A subagent's context is the parent's, minus the conversation.** Its tools
 * see the same `env`, the same slots, the same `db`, the same `sessionId` — it
 * is the same session, and a subagent that could not read the cart would be a
 * worse tool than the one that delegated to it. What it does NOT see is
 * `ctx.messages`: the isolation a subagent exists for is the CONTEXT WINDOW,
 * and a subagent handed the transcript has given that back. The brief in
 * `DelegateOptions.task` is what carries anything from the conversation, which
 * is why the contract insists it be written as a complete one.
 */

import type { SubagentDef, SubagentToolCall, ToolDef } from "@alexkroman1/aai";
import type { ProviderEnv, RunCodeExecutor } from "@alexkroman1/aai/host-internal";
import { normalizeLlm, resolveAllBuiltins } from "@alexkroman1/aai/host-internal";
import { DEFAULT_MAX_STEPS } from "@alexkroman1/aai/internal";
import type { LlmProvider } from "@alexkroman1/aai/llm";
import { agentToolsToSchemas } from "@alexkroman1/aai/manifest";
import { omitUndefined } from "@alexkroman1/aai/utils";
import { type LanguageModel, stepCountIs, ToolLoopAgent } from "ai";
import { createLlmModelCache, isLlmDescriptor } from "./_llm-model-cache.ts";
import { forceFinalAnswer } from "./_prepare-step.ts";
import { consoleLogger, type Logger } from "./runtime-config.ts";
import { toVercelTools } from "./to-vercel-tools.ts";
import { createToolDispatcher, executeToolCall, type SubagentRunner } from "./tool-executor.ts";

/**
 * Options for {@link createSubagentRunner}.
 * @internal
 */
export type CreateSubagentRunnerOptions = {
  /**
   * Default LLM descriptor — the agent's own. A subagent may name its own
   * with `SubagentDef.llm`; when neither is present a delegation fails with a
   * descriptive error, exactly as `ctx.generate` does (an S2S agent has no
   * pipeline LLM and must name one).
   */
  llm?: LlmProvider | undefined;
  /** Env the provider credential resolves from (agent env / providerEnv). */
  env: ProviderEnv;
  /** Override the builtins' fetch. Tests only — see `BuiltinToolOptions`. */
  fetch?: typeof globalThis.fetch | undefined;
  /** In-sandbox `run_code` executor, for a subagent that enables that builtin. */
  runCode?: RunCodeExecutor | undefined;
  logger?: Logger | undefined;
};

/**
 * Why a subagent's own tools cannot delegate again.
 *
 * Stated rather than left to a generic "not available": the author who hits it
 * wrote a legal-looking `ctx.delegate` inside a tool a subagent calls, and the
 * useful thing to say is that the depth is the rule, not that the capability
 * is missing here.
 *
 * @internal
 */
export const NESTED_DELEGATE_MESSAGE =
  "ctx.delegate is not available inside a subagent's own tools: delegation is " +
  "one level deep. A subagent that may delegate can delegate to itself, and " +
  "nothing at this seam can see the recursion — give the subagent the tool it " +
  "needs directly, or have the parent tool run the second subagent itself.";

/**
 * Build the host `ctx.delegate` implementation for one agent.
 *
 * Models resolve lazily and are memoized per descriptor OBJECT, like
 * `createGenerateFn` — a subagent declared at module scope hands back the same
 * descriptor on every call, so one client is reused across a session's
 * delegations.
 *
 * @internal
 */
export function createSubagentRunner(opts: CreateSubagentRunnerOptions): SubagentRunner {
  const logger = opts.logger ?? consoleLogger;
  const modelFor = createLlmModelCache(opts.env);

  const resolveModel = (sub: SubagentDef): LanguageModel => {
    const descriptor = sub.llm ? normalizeLlm(sub.llm) : opts.llm;
    if (!isLlmDescriptor(descriptor)) {
      throw new Error(
        `subagent "${sub.name}": no LLM configured. Give the subagent an \`llm\` ` +
          "(a descriptor from @alexkroman1/aai/llm, or a model-id string), or run " +
          "the agent in pipeline mode.",
      );
    }
    return modelFor(descriptor);
  };

  return async (sub, delegateOptions, parent) => {
    const model = resolveModel(sub);
    const maxSteps = delegateOptions.maxSteps ?? sub.maxSteps ?? DEFAULT_MAX_STEPS;
    const sessionId = parent.sessionId ?? "";

    const builtins = resolveAllBuiltins(sub.builtinTools ?? [], {
      ...omitUndefined({ fetch: opts.fetch }),
      ...omitUndefined({ runCode: opts.runCode }),
    });
    // The subagent's OWN tools win a name collision with a builtin, which is
    // the same policy `mergeBuiltinSurface` applies one level up — and the
    // colliding builtin is dropped from the schemas too, so the model never
    // sees a duplicate name.
    const allTools: Record<string, ToolDef> = { ...builtins.defs, ...sub.tools };
    const schemas = agentToolsToSchemas(allTools);

    const executeTool = createToolDispatcher(allTools, (toolDef, call) =>
      executeToolCall(call.name, call.args, {
        ...parent,
        tool: toolDef,
        // The subagent's conversation, not the session's — see the module doc.
        messages: call.messages,
        // One level. The runner is REPLACED rather than dropped so the refusal
        // says why, not merely that nothing is wired here.
        subagents: () => Promise.reject(new Error(NESTED_DELEGATE_MESSAGE)),
      }),
    );

    const agent = new ToolLoopAgent({
      id: sub.name,
      model,
      // `instructions` is the agent library's own key; `systemPrompt` is ours.
      instructions: delegateOptions.context
        ? `${sub.systemPrompt}\n\n${delegateOptions.context}`
        : sub.systemPrompt,
      tools: toVercelTools(schemas, {
        executeTool,
        sessionId,
        // A subagent's tools read an EMPTY `ctx.messages`, deliberately: the
        // session transcript is exactly the context this indirection exists to
        // keep out of the subagent's window.
        messages: () => [],
        ...omitUndefined({ signal: parent.signal }),
      }),
      // One more than the tool-calling budget, so the forced answering step has
      // somewhere to run — the same arithmetic as `createTextAgent`.
      stopWhen: stepCountIs(maxSteps + 1),
      prepareStep: forceFinalAnswer(maxSteps, logger, sessionId),
      ...omitUndefined({ temperature: sub.temperature }),
      ...omitUndefined({ maxOutputTokens: sub.maxOutputTokens }),
    });

    const result = await agent.generate({
      prompt: delegateOptions.task,
      ...omitUndefined({ abortSignal: parent.signal }),
    });

    return {
      text: result.text,
      steps: result.steps.length,
      toolCalls: collectToolCalls(result.steps),
    };
  };
}

/**
 * Every tool call the run made, flattened across its steps.
 *
 * The RESULTS are deliberately not carried: they are what stayed inside the
 * subagent's context window, and a caller handed them back has undone the
 * delegation. What a caller legitimately wants is the shape of the work — how
 * many lookups, against what — which is the call alone.
 */
function collectToolCalls(
  steps: readonly { toolCalls: readonly { toolName: string; input: unknown }[] }[],
): readonly SubagentToolCall[] {
  return steps.flatMap((step) =>
    step.toolCalls.map((call) => ({ name: call.toolName, input: call.input })),
  );
}
