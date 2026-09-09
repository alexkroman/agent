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
 *   (`env`/`slots`/`generate`/`messages`/`signal`), the per-call
 *   deadline, and failure-shaped-as-a-tool-result;
 * - the step budget spends its last step with `toolChoice: "none"`, so a
 *   capped turn answers instead of stopping mid-chain (see
 *   {@link forceFinalAnswer} — the same rule and the same code as the voice
 *   pipeline);
 * - malformed tool arguments are repaired (see `tool-call-repair.ts`).
 *
 * **And a turn is OBSERVABLE without wrapping that result**, which is how the
 * two claims above coexist: `onEvent` reports the turn as the same typed
 * {@link SessionEvent} stream a voice session emits, so an eval reads a text
 * agent's behaviour with the readers it already has instead of scraping text.
 * It is additive — nothing about `TextTurnResult` changes — and
 * `text-agent-events.ts` carries the vocabulary and its argument.
 */

import type { AgentDef, AgentSessionContext, Message } from "@alexkroman1/aai";
import {
  createDetachedSlotStore,
  staticSystemPrompt,
  systemPromptResolver,
} from "@alexkroman1/aai/host-internal";
import { DEFAULT_MAX_STEPS } from "@alexkroman1/aai/internal";
import type { LlmProvider } from "@alexkroman1/aai/llm";
import { assemblyAILlm } from "@alexkroman1/aai/llm";
import { agentToolsToSchemas } from "@alexkroman1/aai/manifest";
import { omitUndefined } from "@alexkroman1/aai/utils";
import { type LanguageModel, stepCountIs, streamText, type ToolSet } from "ai";
import {
  composePrepareStep,
  forceFinalAnswer,
  resetToolChoiceAfterFirstStep,
} from "./_prepare-step.ts";
import { createGenerateFn } from "./generate.ts";
import { resolveLlm } from "./providers/resolve.ts";
import { consoleLogger } from "./runtime-config.ts";
import { mergeBuiltinSurface } from "./runtime-tools.ts";
import { createSubagentRunner } from "./subagent.ts";
import { createTextAgentEvents } from "./text-agent-events.ts";
import { toContextMessages } from "./text-agent-messages.ts";
// Imported as well as re-exported below: a re-export does not bring a name into
// this module's scope, and the factory's own signature needs all four.
import type {
  TextAgent,
  TextAgentOptions,
  TextTurnOptions,
  TextTurnResult,
} from "./text-agent-types.ts";
import { toVercelTools } from "./to-vercel-tools.ts";
import { createToolCallRepair } from "./tool-call-repair.ts";
import { createFatalToolLatch, type FatalToolLatch, withFatalSignal } from "./tool-error-policy.ts";
import { createToolDispatcher, executeToolCall } from "./tool-executor.ts";
import { createUsageMeter } from "./usage-meter.ts";

/**
 * The four public TYPES — `TextTurnResult`, `TextAgentOptions`,
 * `TextTurnOptions` and `TextAgent` — live in `text-agent-types.ts`, split off
 * when this file passed the source-length cap. They are the surface a caller
 * writes against and carry a paragraph per field; what is left here is the
 * factory. Re-exported below, so no importer moved.
 */
export type {
  TextAgent,
  TextAgentOptions,
  TextTurnOptions,
  TextTurnResult,
} from "./text-agent-types.ts";

/**
 * The LLM a text agent runs on when its definition names none.
 *
 * `defaultProviders` deliberately fills nothing for a text agent (it fills
 * *pipeline stages*, and a text agent has none), so the default lands here
 * instead — the same AssemblyAI LLM Gateway default every other mode gets,
 * on the same one key.
 */
function resolveModel(options: TextAgentOptions): LanguageModel {
  if (options.model) return options.model;
  const descriptor: LlmProvider = options.agent.llm ?? assemblyAILlm();
  return resolveLlm(descriptor, options.providerEnv ?? options.env ?? {});
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
export function createTextAgent(options: TextAgentOptions): TextAgent {
  const { agent, logger = consoleLogger } = options;
  if (agent.text !== true) {
    throw new Error(
      `Agent "${agent.name}" is not a text agent — add \`text: true\` to its ` +
        "definition, or run it as a voice session with `createRuntime`.",
    );
  }
  const model = resolveModel(options);
  const sessionId = options.sessionId ?? crypto.randomUUID();
  const env = Object.freeze({ ...(options.env ?? {}) });

  const builtins = mergeBuiltinSurface(
    agent,
    {
      ...omitUndefined({ fetch: options.fetch }),
      ...omitUndefined({ runCode: options.runCode }),
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
  const toolEnv = options.providerEnv ?? options.env ?? {};

  const generate = createGenerateFn({ llm: toolLlm, env: toolEnv });

  /**
   * `ctx.delegate`, on the same descriptor and the same credential env as
   * `generate` — a text agent's tools delegate exactly as a voice agent's do.
   */
  const subagents = createSubagentRunner({
    llm: toolLlm,
    env: toolEnv,
    ...omitUndefined({ fetch: options.fetch }),
    ...omitUndefined({ runCode: options.runCode }),
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

  /**
   * This conversation's typed event stream — inert unless `onEvent` is set.
   *
   * Built here, above the dispatcher, because two of the three things it
   * reports come from TOOL execution rather than from the model stream:
   * `ctx.send` and a tool that threw were both dropped on the floor in text
   * mode until this existed.
   */
  const events = createTextAgentEvents(options.onEvent, logger);

  /**
   * This conversation's token meter — see `usage-meter.ts`.
   *
   * Built unconditionally, because usage is worth REPORTING whether or not a
   * budget is declared; the cap is `agent.usageLimits` and is `undefined` for
   * almost every agent. A text agent's numbers come from the same place a
   * pipeline session's do (each completed step's reported usage), which is what
   * makes an eval's assertion about spend mean the same thing in both.
   */
  const usage = createUsageMeter({
    limits: agent.usageLimits,
    onUpdate: (snapshot) => events.usage(snapshot),
  });

  /**
   * What a per-session author function is handed — a `systemPrompt` resolver
   * here, and nothing else yet: guardrails are refused in text mode
   * (`assertGuardrailScope`) because this door returns the model stream
   * directly and owns no point at which to hold a reply.
   */
  const sessionContext: AgentSessionContext = { sessionId, env, slots };
  const instructions = systemPromptResolver(agent.systemPrompt);

  const executeTool = createToolDispatcher(allTools, (tool, call) =>
    executeToolCall(call.name, call.args, {
      tool,
      env,
      slots,
      // The agent's own id when the caller named none: one text agent is one
      // conversation, which is what makes its slots mean the same thing here as
      // in a session.
      sessionId: call.sessionId || sessionId,
      workflows: options.workflows,
      messages: call.messages,
      generate,
      subagents,
      // A text agent's tools spend on the same meter its turns do — one
      // conversation, one budget. Handed over directly rather than resolved by
      // id: this door builds exactly one meter and one dispatcher.
      usage,
      logger,
      signal: call.options?.signal,
      timeoutMs: options.toolTimeoutMs,
      send: events.custom,
      onUncaught: events.toolFault,
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
   *
   * **That value GROWS within the turn, and only within it.** Each settled tool
   * call appends its own result, so a second tool in the same reply reads what
   * the first answered — the `"tool"` arm of {@link Message}, which nothing
   * produced before. The array is minted here, per call, so it is still the
   * case that nothing outlives the turn and nothing another turn can reach is
   * ever written: the hazard the paragraph above records was ONE array shared
   * by every turn, not a mutable one.
   */
  const toolsFor = (messages: readonly Message[], fatalTool: FatalToolLatch): ToolSet => {
    const view: Message[] = [...messages];
    return toVercelTools(builtins.schemas, {
      executeTool,
      sessionId,
      onFatalToolError: (error) => fatalTool.report(error),
      messages: () => view,
      recordToolResult: (message) => {
        view.push(message);
      },
    });
  };

  /**
   * The declarations a caller renders, bound to NO turn.
   *
   * `TextAgent.tools` exists so a caller can name the tools it will see in the
   * stream; it is not the set a turn runs on, which `stream()` builds from that
   * turn's messages. A tool invoked through this copy reads an empty
   * `ctx.messages` — correct, since it belongs to no conversation.
   *
   * Built WITHOUT `recordToolResult`, and that is the difference from
   * `toolsFor([])`: this set is agent-scoped, so a growing view behind it would
   * be exactly the instance-scoped accumulator `toolsFor` exists to avoid —
   * every call made through this copy leaking into the next one's
   * `ctx.messages` for the life of the agent.
   */
  const tools = toVercelTools(builtins.schemas, {
    executeTool,
    sessionId,
    messages: () => [],
  });

  return {
    model,
    tools,
    sessionId,
    stream(turn: TextTurnOptions): TextTurnResult {
      // One latch per RUN here, where the pipeline keeps one per session: a text
      // agent's turns are not serialized (two `stream()` calls may overlap), so
      // a shared latch would let one run's fatal tool abort another's request.
      const fatalTool = createFatalToolLatch();
      const turnTools = toolsFor(toContextMessages(turn.messages), fatalTool);
      // Opened before the request, so the turn's own user transcript is the
      // first event of it. `undefined` when nothing is listening, which is what
      // keeps an unobserved turn from installing a per-part callback at all.
      const turnEvents = events.openTurn(turn.messages);
      const maxSteps = turn.maxSteps ?? agent.maxSteps ?? DEFAULT_MAX_STEPS;
      const forceFinal = forceFinalAnswer(maxSteps, logger, sessionId);
      const toolChoice = turn.toolChoice ?? agent.toolChoice ?? "auto";
      // The budget, checked where the request is about to be made — see
      // `usage-meter.ts`. A throw rather than a silently empty stream: this
      // door's caller is code, not a person on a phone, and it can act on one.
      const exhausted = usage.exhausted();
      if (exhausted !== undefined) throw new Error(exhausted);
      return streamText({
        model,
        // `system` is the AI SDK's key; `systemPrompt` is ours, at both levels.
        // A per-turn override wins; otherwise the agent's own, which may be a
        // RESOLVER called here — once per turn rather than once per step, since
        // this door assembles one request and lets the SDK step it.
        ...omitUndefined({
          system:
            turn.systemPrompt ??
            instructions?.(sessionContext) ??
            staticSystemPrompt(agent.systemPrompt),
        }),
        messages: turn.messages,
        tools: turnTools,
        toolChoice,
        // Only when set — some models ignore it and warn. Per-turn beats the
        // agent's own, the way `maxSteps` and `toolChoice` above already do.
        ...omitUndefined({
          temperature: turn.temperature ?? agent.temperature,
          maxOutputTokens: agent.maxOutputTokens,
          maxRetries: agent.maxRetries,
        }),
        // `maxSteps` bounds TOOL-CALLING steps; the budget is one larger so
        // the forced answer step has somewhere to run. Caller conditions are
        // alternatives, not replacements — a wall-clock deadline must be able
        // to end a turn early and must never extend one past the step cap.
        stopWhen: [stepCountIs(maxSteps + 1), ...(turn.stopWhen ?? [])],
        prepareStep: composePrepareStep(
          turn.prepareStep,
          // Before `forceFinalAnswer`, which owns the same key on the reserved
          // step — see `_prepare-step.ts`.
          resetToolChoiceAfterFirstStep(toolChoice, agent.resetToolChoice ?? true),
          forceFinal,
        ),
        experimental_repairToolCall: createToolCallRepair(model, logger, () => turn.signal),
        // The caller's signal PLUS the fatal-tool latch, so a tool the author
        // declared unrecoverable stops the run instead of handing the model a
        // `tool-error` part to retry against — see `tool-error-policy.ts`.
        ...omitUndefined({ abortSignal: withFatalSignal(turn.signal, fatalTool) }),
        onStepFinish: (step) => {
          usage.record(step.usage);
          return turn.onStepFinish?.(step);
        },
        // Both halves of the event stream: every part maps through `onChunk`,
        // and `onEnd` is the guarded backstop terminator.
        ...omitUndefined({ onChunk: turnEvents?.onChunk }),
        ...omitUndefined({ onEnd: turnEvents?.onEnd }),
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
 * The message projection — `toContextMessages` and the three helpers under it —
 * lives in `text-agent-messages.ts`, split off when this file passed the
 * 500-line cap. The seam is the natural one: everything there is about turning
 * the AI SDK's `ModelMessage` list into the `{ role, content }` view
 * `ctx.messages` promises a tool, and nothing in it knows this module exists.
 */
