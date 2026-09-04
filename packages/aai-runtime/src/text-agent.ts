// Copyright 2026 the AAI authors. MIT license.
/**
 * The TEXT session mode: run an `agent()` definition over a message list.
 *
 * This is the third way to drive an agent, beside the voice pipeline and S2S.
 * The definition is the same one — `systemPrompt`, `tools`, `builtinTools`,
 * `maxSteps`, `toolChoice`, `state`, `requiredEnv` all mean what they mean
 * everywhere else, and tool calls go through the same {@link executeToolCall}
 * — so a tool written for a voice agent runs unchanged in a text one. What
 * drops away is everything downstream of speech: no STT, no TTS, no barge-in,
 * no turn-taking, no audio clock.
 *
 * ```ts
 * import { agent, tool } from "@alexkroman1/aai";
 * import { createTextAgent } from "@alexkroman1/aai-runtime";
 *
 * const chat = createTextAgent({
 *   agent: agent({ name: "Helper", text: true, systemPrompt: "Be brief." }),
 *   env: { ASSEMBLYAI_API_KEY: process.env.ASSEMBLYAI_API_KEY ?? "" },
 * });
 * const result = chat.stream({ messages: [{ role: "user", content: "hi" }] });
 * for await (const delta of result.textStream) process.stdout.write(delta);
 * ```
 *
 * **It returns the AI SDK's own `StreamTextResult`, deliberately.** A text
 * agent's caller is a chat surface, and every one of them already consumes
 * that object — `toUIMessageStream`, `pipeUIMessageStreamToResponse`,
 * `textStream`, `steps`. Wrapping it would mean re-exporting that surface
 * piece by piece and falling behind it; what this module owns instead is
 * everything on the REQUEST side, which is where an agent definition
 * actually lives.
 *
 * What that buys over calling `streamText` by hand — and each of these was a
 * hand-rolled copy in the studio coding agent before this existed:
 *
 * - the LLM descriptor resolves through the same registry the pipeline uses,
 *   with credentials read from the agent env and never `process.env`;
 * - `builtinTools` works, so the keyless web builtins are a name in the agent
 *   definition rather than a hand-written adapter;
 * - tool calls get argument coercion, Standard Schema validation, `ctx`
 *   (`env`/`state`/`db`/`generate`/`messages`/`signal`), the per-call
 *   deadline, and failure-shaped-as-a-tool-result;
 * - the step budget spends its last step with `toolChoice: "none"`, so a
 *   capped turn answers instead of stopping mid-chain (see
 *   {@link forceFinalAnswer} — the same rule and the same code as the voice
 *   pipeline);
 * - malformed tool arguments are repaired (see `tool-call-repair.ts`).
 */

import type { AgentDef, Message, ToolChoice } from "@alexkroman1/aai";
import type { AgentEnv, ProviderEnv, RunCodeExecutor } from "@alexkroman1/aai/host-internal";
import { createDetachedSlotStore } from "@alexkroman1/aai/host-internal";
import type { Db } from "@alexkroman1/aai/internal";
import { DEFAULT_MAX_STEPS } from "@alexkroman1/aai/internal";
import type { LlmProvider } from "@alexkroman1/aai/llm";
import { assemblyAILlm } from "@alexkroman1/aai/llm";
import { agentToolsToSchemas } from "@alexkroman1/aai/manifest";
import { omitUndefined } from "@alexkroman1/aai/utils";
import type { WorkflowClient } from "@alexkroman1/aai/workflow-api";
import {
  type LanguageModel,
  type ModelMessage,
  type PrepareStepFunction,
  type StepResult,
  stepCountIs,
  streamText,
  type ToolSet,
} from "ai";
import { composePrepareStep, forceFinalAnswer } from "./_prepare-step.ts";
import { createGenerateFn } from "./generate.ts";
import { resolveLlm } from "./providers/resolve.ts";
import { consoleLogger, type Logger } from "./runtime-config.ts";
import { mergeBuiltinSurface } from "./runtime-tools.ts";
import { createSubagentRunner } from "./subagent.ts";
import { toVercelTools } from "./to-vercel-tools.ts";
import { createToolCallRepair } from "./tool-call-repair.ts";
import { createToolDispatcher, executeToolCall } from "./tool-executor.ts";

/**
 * What one turn hands back: the AI SDK's own `streamText` result, with this
 * SDK's tool set.
 *
 * Spelled as `ReturnType<typeof streamText<ToolSet>>` rather than by naming
 * `StreamTextResult`'s three type parameters, so the two type arguments we
 * have no opinion about (the runtime context and the structured-output shape)
 * keep tracking the vendor's own defaults instead of being pinned to whatever
 * they were on the day this was written.
 */
export type TextTurnResult = ReturnType<typeof streamText<ToolSet>>;

/** Session-fixed configuration for {@link createTextAgent}. */
export interface TextAgentOptions {
  /** The agent definition. Must declare `text: true`. */
  agent: AgentDef;
  /**
   * Tenant-owned env: what tool code reads as `ctx.env`, and — unless
   * `providerEnv` overrides it — where the LLM credential is read from.
   */
  env?: AgentEnv;
  /**
   * Env used for provider-credential resolution only. Defaults to `env`.
   * Split for the same reason `RuntimeOptions` splits them: a host-fallback
   * env may resolve a model and must never become `ctx.env`.
   */
  providerEnv?: ProviderEnv;
  /**
   * Pre-resolved model, bypassing descriptor resolution entirely. For a
   * caller that already holds a `LanguageModel` (and for tests, which is the
   * majority use — a text agent's whole observable behaviour is what it
   * sends the model).
   */
  model?: LanguageModel;
  /** `ctx.db`. Absent makes `ctx.db` throw with the enablement guidance. */
  db?: Db | undefined;
  /** `ctx.workflows`. Absent substitutes a client that rejects with the reason. */
  workflows?: WorkflowClient | undefined;
  /** In-sandbox `run_code` executor, for an agent that enables that builtin. */
  runCode?: RunCodeExecutor;
  /** Override the builtins' fetch. Tests only — see `BuiltinToolOptions`. */
  fetch?: typeof globalThis.fetch;
  /** Defaults to `consoleLogger`. */
  logger?: Logger;
  /**
   * Conversation identity for `ctx.sessionId` and the session's `ctx.state`.
   * Defaults to a fresh id per text agent — one instance is one conversation,
   * which is what makes `state` mean the same thing here as in a session.
   */
  sessionId?: string;
  /**
   * Per-tool-call deadline. Defaults to `TOOL_EXECUTION_TIMEOUT_MS`
   * (30s), which is a voice-turn budget; a text agent whose tools install
   * packages or type-check a workspace wants a larger one.
   */
  toolTimeoutMs?: number;
}

/** Per-turn parameters for {@link TextAgent.stream}. */
export interface TextTurnOptions {
  /** The conversation so far, in AI SDK `ModelMessage` form. */
  messages: ModelMessage[];
  /** Aborts the LLM stream and every in-flight tool call. */
  signal?: AbortSignal;
  /** Overrides the agent's `systemPrompt` for this turn. */
  systemPrompt?: string;
  /** Overrides the agent's `maxSteps` for this turn. */
  maxSteps?: number;
  /** Overrides the agent's `temperature` for this turn. */
  temperature?: number;
  /** Overrides the agent's `toolChoice` for this turn. */
  toolChoice?: ToolChoice;
  /**
   * Extra stop conditions, ANDed into the step budget as alternatives — a
   * wall-clock deadline is the usual one, since a step cap says nothing
   * about how long a caller waits.
   */
  stopWhen?: readonly ((opts: {
    steps: readonly StepResult<ToolSet>[];
  }) => boolean | PromiseLike<boolean>)[];
  /**
   * Per-step hook, composed WITH this module's own: whatever it returns is
   * applied first, and the forced final answer is layered over the result, so
   * a caller may rewrite the step's messages (compaction, an injected notice)
   * without being able to hand the model tools on the step the budget
   * reserved for answering.
   */
  prepareStep?: PrepareStepFunction<ToolSet>;
  /** Fires after each completed step, with that step's result. */
  onStepFinish?: (step: StepResult<ToolSet>) => void | Promise<void>;
}

/** A text agent bound to one conversation — see {@link createTextAgent}. */
export interface TextAgent {
  /** The resolved model every turn runs on. */
  readonly model: LanguageModel;
  /**
   * The agent's tools as the AI SDK sees them — its own plus its enabled
   * builtins, each bound to the shared executor. Exposed because a caller
   * rendering a tool console needs the names it will see in the stream.
   *
   * These declarations belong to NO turn: {@link TextAgent.stream} builds its
   * own set bound to that turn's messages, so `ctx.messages` cannot be handed a
   * conversation from a concurrent turn. A tool invoked through this copy reads
   * an empty `ctx.messages`.
   */
  readonly tools: ToolSet;
  /** This conversation's id — `ctx.sessionId` for every tool call. */
  readonly sessionId: string;
  /** Run one turn, streaming. */
  stream(turn: TextTurnOptions): TextTurnResult;
}

/**
 * The LLM a text agent runs on when its definition names none.
 *
 * `defaultProviders` deliberately fills nothing for a text agent (it fills
 * *pipeline stages*, and a text agent has none), so the default lands here
 * instead — the same AssemblyAI LLM Gateway default every other mode gets,
 * on the same one key.
 */
function resolveModel(opts: TextAgentOptions): LanguageModel {
  if (opts.model) return opts.model;
  const descriptor: LlmProvider = opts.agent.llm ?? assemblyAILlm();
  return resolveLlm(descriptor, opts.providerEnv ?? opts.env ?? {});
}

/**
 * The error `createRuntime` throws for a text agent — defined here because it
 * names this module, and because the rationale belongs beside what it points
 * at rather than in the middle of the runtime's provider resolution.
 *
 * Refused by NAME rather than left to fall through: a text agent fills no
 * pipeline stages and resolves no transport, so the unguarded path ends at
 * `buildTransport`'s generic "no transport for this config" — which describes
 * the symptom of the mistake instead of the mistake.
 */
export function textAgentHasNoSession(name: string): Error {
  return new Error(
    `Agent "${name}" declares \`text: true\` and has no voice session — run it ` +
      "with `createTextAgent` from `@alexkroman1/aai-runtime`, not `createRuntime`.",
  );
}

/**
 * Create a text agent bound to one conversation.
 *
 * @throws if the definition does not declare `text: true`. A voice agent run
 *   as a text one would silently drop its `greeting` and every voice knob it
 *   was tuned with; refusing by name is the mirror of `createRuntime`'s
 *   refusal of a text agent.
 *
 * @public
 */
export function createTextAgent(opts: TextAgentOptions): TextAgent {
  const { agent, logger = consoleLogger } = opts;
  if (agent.text !== true) {
    throw new Error(
      `Agent "${agent.name}" is not a text agent — add \`text: true\` to its ` +
        "definition, or run it as a voice session with `createRuntime`.",
    );
  }
  const model = resolveModel(opts);
  const sessionId = opts.sessionId ?? crypto.randomUUID();
  const env = Object.freeze({ ...(opts.env ?? {}) });

  const builtins = mergeBuiltinSurface(
    agent,
    {
      ...omitUndefined({ fetch: opts.fetch }),
      ...omitUndefined({ runCode: opts.runCode }),
    },
    { schemas: agentToolsToSchemas(agent.tools ?? {}) },
  );
  // The agent's own tools win a name collision, exactly as in a session — the
  // merge above has already dropped the shadowed builtin from the schemas, so
  // the model never sees a duplicate name either.
  const allTools: Record<string, AgentDef["tools"][string]> = {
    ...builtins.defs,
    ...agent.tools,
  };

  // Derived ONCE and shared by both, rather than the same two expressions
  // written out three times across this factory (`resolveModel` is the third).
  // They have to agree by construction: `ctx.generate` and `ctx.delegate` are
  // documented as running on the same descriptor and the same credential as the
  // turns do, and three independent spellings is three chances at a text agent
  // whose tools quietly dial a different provider than its replies.
  const toolLlm: LlmProvider = agent.llm ?? assemblyAILlm();
  const toolEnv = opts.providerEnv ?? opts.env ?? {};

  const generate = createGenerateFn({ llm: toolLlm, env: toolEnv });

  /**
   * `ctx.delegate`, on the same descriptor and the same credential env as
   * `generate` — a text agent's tools delegate exactly as a voice agent's do.
   */
  const subagents = createSubagentRunner({
    llm: toolLlm,
    env: toolEnv,
    ...omitUndefined({ fetch: opts.fetch }),
    ...omitUndefined({ runCode: opts.runCode }),
    logger,
  });

  /**
   * The agent's slot state for this text agent's whole life — one store, so two
   * turns of one conversation see the same cart.
   *
   * Detached rather than the runtime's two-backend store, and that is a real
   * limitation stated in place: a text agent is not a session (`createRuntime`
   * refuses one), it has no resume path and no grace window, so there is nothing
   * for a durable value to survive INTO. Slots still behave identically —
   * `createDetachedSlotStore` applies the same storability check and the same
   * freeze — so a text agent cannot hold a shape a voice one could not store.
   */
  const slots = createDetachedSlotStore();

  const executeTool = createToolDispatcher(allTools, (tool, call) =>
    executeToolCall(call.name, call.args, {
      tool,
      env,
      slots,
      // The agent's own id when the caller named none: one text agent is one
      // conversation, which is what makes its slots mean the same thing here as
      // in a session.
      sessionId: call.sessionId || sessionId,
      workflows: opts.workflows,
      messages: call.messages,
      generate,
      subagents,
      logger,
      signal: call.options?.signal,
      timeoutMs: opts.toolTimeoutMs,
    }),
  );

  /**
   * The tool set for ONE turn, closing over that turn's own messages.
   *
   * Per turn rather than per agent, and this is the correctness half rather than
   * a style choice. `ctx.messages` used to read a single instance-scoped `let`
   * that `stream()` overwrote — so two overlapping `stream()` calls (a chat
   * surface answering two tabs, a caller racing a retry against a slow turn) gave
   * turn 1's in-flight tool call turn 2's conversation, silently, and the
   * comment on that variable claimed the opposite outright. A turn's tools are
   * built with a value, so there is nothing left to overwrite.
   */
  const toolsFor = (messages: readonly Message[]): ToolSet =>
    toVercelTools(builtins.schemas, { executeTool, sessionId, messages: () => messages });

  /**
   * The declarations a caller renders, bound to NO turn.
   *
   * `TextAgent.tools` exists so a caller can name the tools it will see in the
   * stream; it is not the set a turn runs on, which `stream()` builds from that
   * turn's messages. A tool invoked through this copy reads an empty
   * `ctx.messages` — correct, since it belongs to no conversation.
   */
  const tools = toolsFor([]);

  return {
    model,
    tools,
    sessionId,
    stream(turn: TextTurnOptions): TextTurnResult {
      const turnTools = toolsFor(toContextMessages(turn.messages));
      const maxSteps = turn.maxSteps ?? agent.maxSteps ?? DEFAULT_MAX_STEPS;
      const forceFinal = forceFinalAnswer(maxSteps, logger, sessionId);
      return streamText({
        model,
        // `system` is the AI SDK's key; `systemPrompt` is ours, at both levels.
        system: turn.systemPrompt ?? agent.systemPrompt,
        messages: turn.messages,
        tools: turnTools,
        toolChoice: turn.toolChoice ?? agent.toolChoice ?? "auto",
        // Only when set — some models ignore it and warn. Per-turn beats the
        // agent's own, the way `maxSteps` and `toolChoice` above already do.
        ...omitUndefined({ temperature: turn.temperature ?? agent.temperature }),
        // `maxSteps` bounds TOOL-CALLING steps; the budget is one larger so
        // the forced answer step has somewhere to run. Caller conditions are
        // alternatives, not replacements — a wall-clock deadline must be able
        // to end a turn early and must never extend one past the step cap.
        stopWhen: [stepCountIs(maxSteps + 1), ...(turn.stopWhen ?? [])],
        prepareStep: composePrepareStep(turn.prepareStep, forceFinal),
        experimental_repairToolCall: createToolCallRepair(model, logger, () => turn.signal),
        ...omitUndefined({ abortSignal: turn.signal }),
        ...omitUndefined({ onStepFinish: turn.onStepFinish }),
        // Claiming this callback is what keeps a provider failure to one log
        // line: the SDK's default is `console.error(error)`, which spends
        // ~100 lines on three nested stack traces plus the whole request body
        // (see the same note in `pipeline-llm-stream.ts`).
        onError: ({ error }) => {
          logger.debug("streamText onError", { error: String(error), sid: sessionId });
        },
      });
    },
  };
}

/**
 * Project the turn's messages into the `{ role, content }` shape
 * `ctx.messages` promises a tool.
 *
 * Text content only, and joined across parts: `ctx.messages` is documented as
 * conversation CONTEXT for a tool to read, and a tool reading it wants the
 * words. Non-text parts (a tool call's arguments, an image) have no string
 * form that belongs in that field, and the roles narrow to the three the
 * public {@link Message} type declares — a `system` message is the agent's
 * own prompt, which a tool does not need handed back to it.
 */
function toContextMessages(messages: readonly ModelMessage[]): readonly Message[] {
  const out: Message[] = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    const role = message.role === "tool" ? "tool" : message.role;
    const content =
      typeof message.content === "string"
        ? message.content
        : message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
    if (content !== "") out.push({ role, content });
  }
  return out;
}
