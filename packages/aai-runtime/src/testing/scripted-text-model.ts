// Copyright 2026 the AAI authors. MIT license.
/**
 * A `LanguageModel` a spec can hand `createTextAgent` — an explicit script, no
 * network, no key.
 *
 * ## The gap this closes
 *
 * `createTextAgent` takes a pre-resolved `model`, and its own doc says why:
 * *"For a caller that already holds a `LanguageModel` (and for tests, which is
 * the majority use — a text agent's whole observable behaviour is what it sends
 * the model)."* There was nothing published to put in that field. So every
 * caller wrote the provider shape out by hand and cast it — `aai-guest` had two
 * copies, one of them 30 lines, each ending in `as unknown as LanguageModel` —
 * and a hand-written provider fake is exactly the artifact this repo has learned
 * not to leave to a call site: **the fakes' fidelity is where the false findings
 * came from, every time** (`packages/aai-runtime/CLAUDE.md`, on the S2S fuzz).
 *
 * The concrete instance is the `finish` part. A step that ends in a tool call
 * must report `tool-calls`, and the reason must be the `{ unified, raw }` PAIR
 * the v3 provider spec declares rather than the bare v2 string — since
 * ai@7.0.70, tool execution is conditional on that value, so a fake emitting a
 * string runs no tools, accumulates no results, and takes no follow-up step.
 * Thirty pipeline specs failed that way and none of them named the fake. Both
 * of those facts are properties of the WIRE, not of any one spec, and
 * {@link scriptedTextModel} is where they are stated once.
 *
 * ## The vocabulary is a STEP, not a stream part
 *
 * `_fake-llm.ts`'s `ScriptedPart` is the wire's own alphabet — a `tool-call`
 * carries its arguments as a JSON STRING and its own call id, and a step's
 * `finish` is implied rather than written. That is the right shape for the
 * pipeline specs it was built for, which assert on frame ORDER, and the wrong
 * one to publish: a caller would be writing `JSON.stringify` at every call site
 * and minting ids by hand for a field it never reads. So this publishes a STEP
 * — what the model says, and what it calls — and keeps the alphabet internal.
 * Nothing is lost that a text agent can observe: a turn's observable behaviour
 * is its steps, its tool calls and its text.
 *
 * ## No shipped template exercises these names
 *
 * The three this module publishes are in
 * `packages/aai-templates/template-api-allowlist.json` along with the four next
 * door; `run-text-agent.ts`'s module doc carries the reason, which is the same
 * one for all seven.
 *
 * @module
 */

import type { LanguageModel } from "ai";
import { createFakeLanguageModel, type ScriptedPart } from "../_fake-llm.ts";

/**
 * One tool call in a {@link ScriptedTextStep}.
 *
 * @public
 */
export type ScriptedToolCall = {
  /** The tool's name, as the agent's `tools` record keys it. */
  readonly name: string;
  /**
   * The arguments, as an object.
   *
   * Serialized to the JSON string the wire carries, so a spec writes the
   * arguments it means and the real coercion, Standard Schema validation and
   * repair path (`tool-call-repair.ts`) all still run on the way in — which is
   * the point of scripting a MODEL rather than calling `execute` directly.
   * Defaults to `{}`.
   */
  readonly input?: Record<string, unknown>;
  /**
   * The call id. Defaults to `call-1`, `call-2`, … across the whole script.
   *
   * Worth naming only when a spec asserts on the id itself — everything a turn
   * reports carries it, so two calls of one tool are already distinguishable
   * without one.
   */
  readonly id?: string;
};

/**
 * One step of a scripted turn: what the model says, and what it calls.
 *
 * A step with tool calls finishes as `tool-calls`, so the agent runs them and
 * comes back for the next step; a step without them ends the turn. That makes a
 * tool-calling turn the obvious two-entry script — the call, then the answer —
 * and a plain reply a one-entry one.
 *
 * @public
 */
export type ScriptedTextStep = {
  /** What the model streams as text on this step. Absent streams none. */
  readonly text?: string;
  /** The tool calls the model makes on this step, in order. */
  readonly toolCalls?: readonly ScriptedToolCall[];
};

/** Project one published step onto the wire alphabet. */
function stepToParts(step: ScriptedTextStep, mintId: () => string): ScriptedPart[] {
  const parts: ScriptedPart[] = [];
  // Text FIRST, which is the order a real provider streams: a model narrates
  // ("let me check that") and then calls. A spec asserting that the narration
  // reached the client before the tool ran depends on it.
  if (step.text !== undefined) parts.push({ type: "text", text: step.text });
  for (const call of step.toolCalls ?? []) {
    parts.push({
      type: "tool-call",
      toolCallId: call.id ?? mintId(),
      toolName: call.name,
      input: JSON.stringify(call.input ?? {}),
    });
  }
  return parts;
}

/**
 * A `LanguageModel` that answers one scripted step per model call.
 *
 * Hand it to `createTextAgent({ model })` — or to anything else that takes a
 * resolved model, which is what the studio's own coding-agent specs do — and the
 * turn takes the production path with nothing faked below the provider socket:
 * the real tool executor, the real `ctx`, the real step budget.
 *
 * Past the end of the script it answers with an EMPTY step rather than throwing,
 * for the reason `createScriptedOneShotModel` gives: a turn that took one step
 * more than a spec expected should fail on the assertion that names the
 * difference, not on a fake running dry.
 *
 * @example
 * ```ts
 * import { agent } from "@alexkroman1/aai";
 * import { createTextAgent } from "@alexkroman1/aai-runtime";
 * import { scriptedTextModel } from "@alexkroman1/aai-runtime/testing";
 *
 * const chat = createTextAgent({
 *   agent: agent({ name: "Desk", text: true, systemPrompt: "Be brief." }),
 *   model: scriptedTextModel([
 *     { text: "Let me check.", toolCalls: [{ name: "look_up", input: { id: "7" } }] },
 *     { text: "It shipped yesterday." },
 *   ]),
 * });
 *
 * const turn = chat.stream({ messages: [{ role: "user", content: "where is order 7?" }] });
 * for await (const delta of turn.textStream) console.log(delta);
 * ```
 *
 * @param steps - One entry per model call, in order.
 *
 * @public
 */
export function scriptedTextModel(steps: readonly ScriptedTextStep[]): LanguageModel {
  // Ids are minted while the script is PROJECTED rather than while it is
  // streamed, so the same script always produces the same ids however many
  // times the model is driven — a run whose ids depend on how far a previous
  // one got is not replayable.
  let minted = 0;
  const mintId = () => `call-${++minted}`;
  return createFakeLanguageModel({ steps: steps.map((step) => stepToParts(step, mintId)) });
}
