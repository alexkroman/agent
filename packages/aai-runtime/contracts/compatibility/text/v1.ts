// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai-runtime:text` epoch 1.
 *
 * What "frozen" obliges is one thing only: this file must keep COMPILING
 * against current source for as long as epoch 1 is advertised as retained, so
 * `pnpm typecheck` — not a claim in a changelog — is the backward-compatibility
 * gate. An error here IS the finding; editing the example to make it go away
 * defeats the whole mechanism. The imports are relative source paths because
 * nothing ships this file and the package's own npm name does not resolve from
 * inside it.
 *
 * The TEXT session mode: the same `agent()` definition a voice agent is, driven
 * over a message list. `createTextAgent` is the counterpart of `createRuntime`
 * for the mode that has NO SESSION — no STT, no TTS, no barge-in, no turn
 * taking, no audio clock, and so nothing to hold state for between turns. The
 * caller owns the message list; the agent owns the request built from it. The
 * studio's own coding agent is the real user of this, and the shape below is
 * that shape: a definition, an options bag, and one turn at a time.
 *
 * Three things the surface is deliberate about, and each is visible here:
 *
 * - **`text: true` is EXPLICIT.** A mode reachable by omission is one a config
 *   lands in when it loses a field, and the symptom there would be a deployed
 *   voice agent that silently answers nothing.
 * - **One turn returns the AI SDK's own `StreamTextResult`** ({@link
 *   TextTurnResult}), not a wrapper. Every chat surface already consumes that
 *   object — `textStream`, `steps`, `toUIMessageStream` — so wrapping it would
 *   mean re-exporting that surface piece by piece and falling behind it. What
 *   this mode owns is everything on the REQUEST side, which is where an agent
 *   definition actually lives.
 * - **A tool is a FILE, so `agent()` takes none.** `withTools` is the seam a
 *   registry attaches through, which is what a spec, a studio session or any
 *   host with a non-file registry uses; a real project's `agent.ts` gets the
 *   same record from the bundler enumerating `tools/`.
 */

import { agent, tool } from "@alexkroman1/aai";
import { withTools } from "@alexkroman1/aai/manifest";
import { z } from "zod";
import {
  createTextAgent,
  type TextAgent,
  type TextAgentOptions,
  type TextTurnOptions,
  type TextTurnResult,
} from "../../../runtime-barrel.ts";

/**
 * How long one turn may run, whatever the step budget says.
 *
 * A wall clock and a step cap answer different questions, so a host that needs
 * both passes the first as a `stopWhen` and leaves the second on the agent.
 */
const TURN_BUDGET_MS = 120_000;

/**
 * A tool, written exactly as a voice agent's is.
 *
 * It runs through the same executor here — Standard Schema validation, argument
 * coercion, the `ctx` a voice tool gets, the per-call deadline, and a throw
 * shaped into a result the model can read — which is the whole reason this mode
 * takes an `AgentDef` rather than a bag of AI SDK tools.
 */
const summarize = tool({
  description: "Summarize a passage the assistant has already read.",
  inputSchema: z.object({ passage: z.string() }),
  execute: ({ passage }) => passage.slice(0, 280),
});

/**
 * The definition. Identical in kind to a voice agent's, minus the speech
 * stages — `systemPrompt`, `maxSteps`, `builtinTools` and `requiredEnv` all
 * mean what they mean everywhere else.
 *
 * `builtinTools` is a list of NAMES, not adapters: the keyless web builtins are
 * resolved by the runtime, so a host writes no fetch wrapper of its own.
 */
export const assistant = withTools(
  agent({
    name: "Docs Assistant",
    text: true,
    system: "Answer from the documentation. Say plainly when you do not know.",
    maxSteps: 40,
    builtinTools: ["visit_webpage", "web_search"],
  }),
  { summarize },
);

/**
 * The options bag, assembled by the host.
 *
 * `env` is the agent's OWN env and becomes `ctx.env` — a plain record, which is
 * what makes it assignable here while a host-credential env (the only thing
 * `withHostCredentialFallback` mints) is not. `toolTimeoutMs` is raised because
 * the SDK's 30s default is a VOICE budget; these tools read pages.
 */
export function chatOptions(env: Record<string, string>, sessionId: string): TextAgentOptions {
  return {
    agent: assistant,
    env,
    sessionId,
    toolTimeoutMs: TURN_BUDGET_MS,
  };
}

/**
 * One chat. Cheap to hold and cheap to make — a process serving many
 * conversations makes one of these per conversation, since the `sessionId` is
 * what a tool's session slots hang off.
 */
export function openChat(env: Record<string, string>, sessionId: string): TextAgent {
  return createTextAgent(chatOptions(env, sessionId));
}

/** What a host wants to know about a chat it just opened, in one line. */
export function describeChat(chat: TextAgent): string {
  const model = typeof chat.model === "string" ? chat.model : chat.model.modelId;
  return `${chat.sessionId}: ${Object.keys(chat.tools).length} tools on ${model}`;
}

/**
 * One turn.
 *
 * `messages` is the whole conversation as the caller holds it — this mode keeps
 * none of it, which is what makes compaction, retries and editing an earlier
 * message the caller's business rather than a hidden one.
 *
 * `stopWhen` composes with the agent's own step cap rather than replacing it,
 * and the runtime spends the LAST step with `toolChoice: "none"` so a capped
 * turn ANSWERS instead of stopping straight after a tool result — a turn that
 * ends there completes successfully with nothing said, which reads to a user as
 * the agent simply giving up.
 */
export function askTurn(
  chat: TextAgent,
  messages: TextTurnOptions["messages"],
  signal: AbortSignal,
  onSteps: (toolCalls: number) => void,
): TextTurnResult {
  const deadline = Date.now() + TURN_BUDGET_MS;
  const turn: TextTurnOptions = {
    messages,
    signal,
    toolChoice: "auto",
    stopWhen: [() => Date.now() > deadline],
    onStepFinish: (step) => onSteps(step.toolCalls.length),
  };
  return chat.stream(turn);
}

/** A turn's system prompt may be overridden per turn; the agent's is the default. */
export function askWithPreamble(
  chat: TextAgent,
  messages: TextTurnOptions["messages"],
  system: string,
): TextTurnResult {
  return chat.stream({ messages, system });
}

/**
 * What a chat surface does with the result.
 *
 * Draining `textStream` is also what forces the tool loop to run: nothing is
 * requested from the model until something reads.
 */
export async function replyText(result: TextTurnResult): Promise<string> {
  let reply = "";
  for await (const delta of result.textStream) reply += delta;
  return reply;
}
