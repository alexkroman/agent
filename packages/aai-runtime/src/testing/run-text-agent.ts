// Copyright 2026 the AAI authors. MIT license.
/**
 * Run a TEXT agent against a scripted model, from a spec.
 *
 * ## The gap this closes
 *
 * `createTextAgent` is how an agent runs as text, and its result is the AI SDK's
 * own `StreamTextResult` — deliberately, because *"a text agent's caller is a
 * chat surface, and every one of them already consumes that object"*. A SPEC is
 * not a chat surface. It wants three things off a turn (what the agent said,
 * what it called, and with what) and to get them it has to know that the stream
 * must be DRIVEN before any of the promises settle, that a tool call and its
 * result are two arrays keyed by `toolCallId`, and that a text agent's turn is
 * a list of steps rather than one reply. Every one of those is a chance to write
 * a spec that passes over a turn which never ran.
 *
 * So this drives the turn and projects it. What it is NOT is a fake of the
 * agent: the model is the only substitution. `createTextAgent` is the real one,
 * so the tool calls go through the real `executeToolCall` — argument coercion,
 * Standard Schema validation, the per-call deadline, the real `ctx`
 * (`env`/`state`/`db`/`generate`/`messages`/`signal`), and
 * failure-shaped-as-a-tool-result — and the step budget spends its last step
 * with `toolChoice: "none"` exactly as a deployed turn does. A spec that reached
 * past that (calling a tool's `execute` directly) asserts against a path
 * production does not take.
 *
 * ## What it does NOT cover, stated so a spec cannot over-claim
 *
 * - **A real model's choices.** The script says which tool is called and what
 *   the agent says; nothing here is evidence that a model WOULD. That is the
 *   eval tier (`@alexkroman1/aai-runtime/eval`), which is a measurement rather
 *   than an assertion.
 * - **Two turns at once.** One call is one turn on one fresh agent, so the
 *   per-turn `ctx.messages` isolation `createTextAgent` owns is exercised by its
 *   own specs and not by this. A spec that needs two turns of ONE conversation
 *   builds the agent itself.
 * - **Anything downstream of speech.** A text agent has no STT, TTS, barge-in or
 *   audio clock to begin with.
 *
 * ## No shipped TEMPLATE exercises this, and none can
 *
 * All seven names this module and `scripted-text-model.ts` publish are recorded
 * in `packages/aai-templates/template-api-allowlist.json`, whose gate asks that
 * every public export of an example-facing subpath be exercised by a shipped
 * template — so the entry is a claim, and this is it.
 *
 * A template's agent is a VOICE agent. `createTextAgent` refuses one by name
 * ("add `text: true` … or run it as a voice session with `createRuntime`"), so a
 * template cannot reach this harness without becoming a different kind of
 * template. Text mode's consumer is a host that embeds the runtime — the studio's
 * own coding agent is the shipped one — which is the same audience
 * `UNEXEMPLIFIED_SUBPATHS` already exempts this package's ROOT for, and the
 * reason `runWorkflow` beside this is the only `/testing` name a template
 * touches (its six types are allowlisted for the analogous reason: a spec names
 * the function, not the shapes).
 *
 * That is a claim about the AUDIENCE and not about coverage. Both modules carry
 * co-located suites that drive real turns, and `contracts/entrypoints/testing.ts`
 * holds the surface to an epoch either way. What is missing is an example an
 * agent AUTHOR would read, and the honest reason is that an agent author does
 * not write one — a host does.
 *
 * @module
 */

import type { AgentDef } from "@alexkroman1/aai";
import { omitUndefined } from "@alexkroman1/aai/utils";
import type { ModelMessage, StepResult, ToolSet } from "ai";
import { silentLogger } from "../runtime-config.ts";
import { createTextAgent, type TextAgentOptions, type TextTurnOptions } from "../text-agent.ts";
import { type ScriptedTextStep, scriptedTextModel } from "./scripted-text-model.ts";

/**
 * One tool call the turn made, with what it was given and what it answered.
 *
 * The two halves are one record here because they are one EVENT to a spec, and
 * the SDK hands them back as two arrays that have to be joined on
 * `toolCallId` — a join every caller was writing, and getting subtly wrong in
 * the same way: a `toolResults` walk alone silently omits a call that never came
 * back, which is exactly the case a spec about a failing tool is asserting.
 *
 * @public
 */
export type TextAgentTestToolCall = {
  /** The tool's name, as the model asked for it. */
  readonly name: string;
  /** The call id, which is what pairs this call with its result on the wire. */
  readonly id: string;
  /**
   * What the MODEL asked for — the script's `input`, as the SDK parsed it off
   * the wire.
   *
   * Deliberately not the value the tool's `execute` received: coercion and
   * Standard Schema validation happen inside `executeToolCall`, and nothing the
   * turn reports carries their output. So a script writing `{ n: "4" }` against
   * a `z.number()` reads back `{ n: "4" }` here while the tool really got `4` —
   * a spec asserting on the COERCED value asserts inside the tool, which is the
   * only place that value exists.
   */
  readonly args: unknown;
  /**
   * What the call answered, as the model sees it.
   *
   * A STRING in practice, and that is the production path rather than a
   * projection: `executeToolCall` serializes every result — a thrown error
   * included, which arrives as a failure string the model can read — because a
   * tool result is a wire value. So a tool returning `5` reads back `"5"`.
   *
   * `undefined` for a call the turn never came back from: an aborted turn, or
   * one the step budget ended on the call.
   */
  readonly result: unknown;
};

/**
 * What one scripted turn produced.
 *
 * @public
 */
export type TextAgentTestRun = {
  /**
   * Everything the agent said, concatenated across steps — what the caller
   * heard.
   *
   * NOT `StreamTextResult.text`, which is the LAST step's text alone. That is
   * the right value for a chat surface reconstructing one assistant message and
   * a trap for a spec: a turn that narrates ("let me check") and then calls a
   * tool reports only the sentence after the call, so an assertion on the
   * narration silently passes against nothing. Read {@link
   * TextAgentTestRun.texts} when the per-step split is what matters.
   */
  readonly text: string;
  /** What the agent said on each step, in order — one entry per model call. */
  readonly texts: readonly string[];
  /**
   * Every tool call the turn made, in the order the turn made them.
   *
   * Flattened across steps deliberately: a tool-calling turn's steps are an
   * artifact of how the loop is cut, while "it looked the order up and then
   * cancelled it" is the property a spec is about.
   */
  readonly toolCalls: readonly TextAgentTestToolCall[];
  /**
   * The AI SDK's own step results, for an assertion this projection does not
   * cover — usage, warnings, the per-step finish reason.
   *
   * The same escape hatch `WorkflowTestHandle.journal` is one surface over, and
   * for the same reason: a projection that has to grow a field for every
   * question is a projection nobody can rely on.
   */
  readonly steps: readonly StepResult<ToolSet>[];
  /**
   * The messages the turn APPENDED — every step's assistant reply and every
   * tool exchange, as the SDK reconstructs them.
   *
   * What a caller persists, and what a second turn of the same conversation is
   * built on: `[...sent, ...run.messages]`. Taken from `responseMessages`
   * (every step) rather than from `response` (the last step only), for the
   * reason {@link TextAgentTestRun.text} carries — a tool-calling turn's own
   * exchange lives in the steps before the last one, so the narrower field
   * hands back an assistant message with no tool call to explain it.
   */
  readonly messages: readonly ModelMessage[];
};

/**
 * What {@link runTextAgent} takes, beyond the definition and the conversation.
 *
 * The agent half is `TextAgentOptions` MINUS the two things this helper
 * supplies — derived by subtraction rather than restated, for the reason
 * `agent-server-forwarding.ts` exists in this package: every field of that type
 * is optional, so an omission is valid TypeScript and presents as a harness
 * quietly ignoring part of its own configuration. A capability added to a text
 * agent is reachable from here the day it lands.
 *
 * The turn half is deliberately NOT the whole of `TextTurnOptions`. `stopWhen`,
 * `prepareStep` and `onStepFinish` are hooks a chat surface installs, and a
 * caller that wants one is past the point where a one-call convenience helps —
 * it builds the agent with `createTextAgent` and streams the turn itself.
 *
 * @public
 */
export type RunTextAgentOptions = Omit<TextAgentOptions, "agent" | "model"> &
  Pick<TextTurnOptions, "signal" | "systemPrompt" | "maxSteps" | "temperature" | "toolChoice"> & {
    /**
     * One entry per model call — see {@link ScriptedTextStep}.
     *
     * Required, because a run with no script is a run against a model that
     * answers nothing, which is a spec asserting on silence by accident.
     */
    readonly script: readonly ScriptedTextStep[];
  };

/** A bare string prompt as the one-user-message conversation it means. */
function toMessages(input: string | readonly ModelMessage[]): ModelMessage[] {
  return typeof input === "string" ? [{ role: "user", content: input }] : [...input];
}

/**
 * Project one step's two tool arrays into the joined records a spec reads.
 *
 * The result map is built per STEP rather than across the turn, because
 * `toolCallId` is only unique within one model call by contract — a script that
 * names its own ids may repeat one, and a later step's result must not be
 * attributed to an earlier step's call.
 */
function toolCallsOf(step: StepResult<ToolSet>): TextAgentTestToolCall[] {
  const results = new Map(step.toolResults.map((result) => [result.toolCallId, result.output]));
  return step.toolCalls.map((call) => ({
    name: call.toolName,
    id: call.toolCallId,
    args: call.input,
    result: results.get(call.toolCallId),
  }));
}

/**
 * Run one turn of `def` against `script`, and hand back what it did.
 *
 * `def` must declare `text: true` — `createTextAgent` refuses a voice agent by
 * name, and this makes no exception, so a spec cannot accidentally measure an
 * agent whose `greeting` and voice tuning are being silently dropped.
 *
 * @example
 * ```ts
 * import { agent } from "@alexkroman1/aai";
 * import { runTextAgent } from "@alexkroman1/aai-runtime/testing";
 *
 * const desk = agent({ name: "Desk", text: true, systemPrompt: "Be brief." });
 *
 * const run = await runTextAgent(desk, "where is order 7?", {
 *   script: [
 *     { text: "Let me check.", toolCalls: [{ name: "look_up", input: { id: "7" } }] },
 *     { text: "It shipped yesterday." },
 *   ],
 * });
 *
 * console.log(run.text); // "Let me check.It shipped yesterday."
 * console.log(run.toolCalls[0]?.name, run.toolCalls[0]?.args);
 * ```
 *
 * @param def - The agent definition, exactly as a deployment runs it.
 * @param input - The conversation, or a string standing for one user message.
 *
 * @throws whatever ended the model stream, rather than reporting a turn that
 *   silently produced nothing. A scripted stream fails only when something under
 *   it is broken, and a harness that swallowed that would report the broken path
 *   as an agent with nothing to say.
 *
 * @public
 */
export async function runTextAgent(
  def: AgentDef,
  input: string | readonly ModelMessage[],
  options: RunTextAgentOptions,
): Promise<TextAgentTestRun> {
  const { script, signal, systemPrompt, maxSteps, temperature, toolChoice, ...agentOptions } =
    options;
  const agent = createTextAgent({
    ...agentOptions,
    agent: def,
    model: scriptedTextModel(script),
    // Silence rather than `consoleLogger`: a turn logs its step budget and every
    // provider hiccup at debug, and a spec suite that prints them reads as
    // failing. A caller asserting on a log line passes its own recorder.
    logger: options.logger ?? silentLogger,
  });
  const result = agent.stream({
    messages: toMessages(input),
    ...omitUndefined({ signal, systemPrompt, maxSteps, temperature, toolChoice }),
  });

  // `streamText` is LAZY: none of its promises settle until the stream is
  // consumed, so a harness that only awaited `result.steps` would hang. Driving
  // it here also means a tool call runs whether or not the caller reads a byte,
  // which is what makes `toolCalls` below honest.
  let failure: { error: unknown } | undefined;
  await result.consumeStream({
    onError: (error) => {
      failure ??= { error };
    },
  });
  if (failure) throw failure.error;

  const steps = await result.steps;
  const texts = steps.map((step) => step.text);
  return {
    text: texts.join(""),
    texts,
    toolCalls: steps.flatMap(toolCallsOf),
    steps,
    messages: await result.responseMessages,
  };
}
