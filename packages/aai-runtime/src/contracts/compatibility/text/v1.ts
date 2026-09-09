// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring template: `aai-runtime:text` epoch 1.
 *
 * Running an agent definition as TEXT — no session, no STT, no TTS — written
 * the way a host authored it at epoch 1. It must keep compiling for as long as
 * that epoch is advertised as supported.
 *
 * ## What moved, and why epoch 1 survives it
 *
 * Nothing this file names. `text-agent.ts` reached the 500-line source cap and
 * was SPLIT — the four caller-facing declarations to `text-agent-types.ts`, the
 * message assembly to `text-agent-messages.ts` — with `text-agent.ts`
 * re-exporting all of them, so no importer moved and every signature here is
 * byte-identical to the one epoch 1 promised. What bumped the epoch is the
 * rollup's PROVENANCE: the new module reaches the AI SDK through `import type`,
 * so the report's own import block changed form while no declaration did. That
 * is the widening — a change a caller cannot observe — and it is why this is a
 * retain rather than a drop.
 *
 * A turn also became observable from the inside on the same day (`onUsage` on
 * the generate bag, `role: "tool"` entries in `ctx.messages`). Neither is on
 * this surface: `TextAgentOptions.onEvent` was already here, and what a tool
 * reads off `ctx` is the SDK's contract, not this one.
 *
 * The direction that WOULD break is a required field arriving on
 * {@link TextTurnOptions}, or `stream()` ceasing to hand back the vendor's own
 * result — a caller consuming `textStream` has no wrapper to fall back on.
 *
 * Editing this file to make a future error go away defeats the mechanism: the
 * error IS the finding, and it means epoch 1 has to be dropped with a reason.
 *
 * @module
 */

import { agent } from "@alexkroman1/aai";
import {
  createTextAgent,
  type TextAgent,
  type TextAgentOptions,
  type TextTurnOptions,
  type TextTurnResult,
} from "../../../runtime-barrel.ts";

/**
 * The agent this host runs as text.
 *
 * EDIT THIS. Everything below is wiring; this is the agent. `text: true` is not
 * decoration — `createRuntime` refuses a text agent by name, and
 * `createTextAgent` is the door that takes one.
 */
const helper = agent({
  name: "Helper",
  text: true,
  systemPrompt: "Answer briefly, and look something up before you claim it.",
  maxSteps: 6,
});

/**
 * ── EDIT: what this host supplies the conversation. ─────────────────────
 *
 * `env` is what tool code reads as `ctx.env`; `providerEnv` is where the model
 * credential is resolved from and nowhere else. Splitting them is the whole
 * point of the two types — a caller's key can reach the model without becoming
 * something the agent's tools can read — and an empty `env` beside a populated
 * `providerEnv` is the shape that says so.
 *
 * `sessionId` names the conversation: one text agent is one conversation, so
 * `ctx.state` and `ctx.sessionId` mean here what they mean in a voice session.
 */
const OPTIONS: TextAgentOptions = {
  agent: helper,
  env: {},
  providerEnv: { ASSEMBLYAI_API_KEY: "not-a-real-key" },
  sessionId: "support/thread-1",
  // A voice turn's 30s tool budget is wrong for a text agent whose tools type-check
  // a workspace or install a package.
  toolTimeoutMs: 120_000,
};

/** One conversation. Reused across every turn it holds. */
export function chatFor(options: TextAgentOptions = OPTIONS): TextAgent {
  return createTextAgent(options);
}

/**
 * ── EDIT: one turn. ─────────────────────────────────────────────────────
 *
 * {@link TextTurnResult} is the AI SDK's own `streamText` result, deliberately
 * un-wrapped: a chat surface already knows how to consume one. What this SDK
 * owns is everything on the REQUEST side — model resolution, the builtins, the
 * tool executor and its `ctx`, the reserved final answering step.
 */
export function answer(chat: TextAgent, turn: TextTurnOptions): TextTurnResult {
  return chat.stream(turn);
}

/**
 * ── EDIT: what a turn overrides, and what it must not. ──────────────────
 *
 * `stopWhen` is ANDed into the step budget as an alternative rather than
 * replacing it, so a wall-clock deadline and the agent's own `maxSteps` both
 * still apply — a step cap says nothing about how long a caller waits.
 */
export async function ask(chat: TextAgent, text: string, signal?: AbortSignal): Promise<string> {
  const deadline = Date.now() + 30_000;
  const result = answer(chat, {
    messages: [{ role: "user", content: text }],
    ...(signal === undefined ? {} : { signal }),
    maxSteps: 4,
    temperature: 0,
    toolChoice: "auto",
    stopWhen: [() => Date.now() > deadline],
    onStepFinish: (step) => {
      // EDIT: a checkpoint, a token meter, a trace span. Fires per completed
      // step, which is the only place a caller sees a turn's middle.
      void step.finishReason;
    },
  });
  let said = "";
  for await (const delta of result.textStream) said += delta;
  return said;
}

/**
 * The tools this conversation will name in its stream.
 *
 * Read off the agent rather than the turn: these declarations belong to NO
 * turn, so a tool invoked through this copy reads an empty `ctx.messages`. A
 * console rendering tool names is the reason it is exposed at all.
 */
export function toolNamesOf(chat: TextAgent): readonly string[] {
  return Object.keys(chat.tools);
}
