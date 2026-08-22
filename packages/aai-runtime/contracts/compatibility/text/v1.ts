// Copyright 2026 the AAI authors. MIT license.
/**
 * Epoch-1 template: `aai-runtime:text`. A text-mode agent and the loop a host
 * drives it with, as a starter written at epoch 1 — copy this file into your
 * host, swap the marked edit points, and keep the loop.
 *
 * FROZEN. It must keep compiling for as long as epoch 1 is supported, so
 * `pnpm typecheck` is the backward-compatibility gate and an error here IS the
 * finding. Do not edit it to make an error go away: an API that has to change
 * gets a NEW epoch carrying a new template, never a change to this one. The
 * imports are relative source paths because nothing ships this file.
 *
 * Front to back: an agent definition, one chat opened per conversation, and a
 * turn — append the user's message, stream, drain, append the reply. There is
 * no session in this mode (no STT, no TTS, no barge-in, no turn taking), so
 * there is nothing to hold between turns: the CALLER owns the message list,
 * which is what makes compaction, retries and editing an earlier message its
 * business rather than a hidden one.
 *
 * What to change:
 *
 * - {@link summarize} and {@link assistant} — your tools and your agent. In a
 *   real project a tool is a FILE and the bundler enumerates `tools/`;
 *   `withTools` is the seam a host with its own registry attaches through.
 * - {@link MODEL} — your model. Omit the field entirely to take whatever the
 *   agent's own `llm` resolves to.
 * - {@link TOOL_TIMEOUT_MS} — read its note before lowering it.
 *
 * What not to change: `text: true` is explicit on purpose (a mode reachable by
 * omission is one a config lands in when it loses a field, and the symptom
 * would be a deployed voice agent that silently answers nothing), and
 * {@link drainReply} is what makes a turn happen at all.
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
 * How long one tool call may run. ← raise or lower to fit YOUR tools
 *
 * Deliberately not the SDK's default, which is a 30s VOICE budget: a caller
 * waiting on speech has left by then, and nobody is waiting on speech here.
 * These tools read pages, so the budget is a chat's patience instead. Lowering
 * it below what your slowest tool needs turns that tool into a timeout the
 * model then has to recover from.
 */
export const TOOL_TIMEOUT_MS = 120_000;

/**
 * How long one whole turn may run, whatever the step budget says.
 *
 * A wall clock and a step cap answer different questions, so pass the first as
 * a `stopWhen` and leave the second on the agent.
 */
export const TURN_BUDGET_MS = 180_000;

/** The model this host runs chats on. ← change this */
export const MODEL = "claude-haiku-4-5-20251001";

/**
 * A tool, written exactly as a voice agent's is. ← your tools
 *
 * It runs through the same executor here — schema validation, argument
 * coercion, the `ctx` a voice tool gets, the per-call deadline, and a throw
 * shaped into a result the model can read — which is why this mode takes an
 * agent definition rather than a bag of raw model tools.
 */
const summarize = tool({
  description: "Summarize a passage the assistant has already read.",
  inputSchema: z.object({ passage: z.string() }),
  execute: ({ passage }) => passage.slice(0, 280),
});

/**
 * The definition. ← your agent
 *
 * Identical in kind to a voice agent's, minus the speech stages:
 * `systemPrompt`, `maxSteps`, `builtinTools` and `requiredEnv` all mean what
 * they mean everywhere else, and `builtinTools` is a list of NAMES rather than
 * adapters — the keyless web builtins are resolved by the runtime, so a host
 * writes no fetch wrapper of its own.
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
 * `env` is the AGENT's own env and becomes `ctx.env` — a plain record, which is
 * what makes it assignable here while a host-credential env is not. `sessionId`
 * is what a tool's session slots hang off, so it identifies the conversation
 * even though nothing in this mode holds session state.
 */
export function chatOptions(env: Record<string, string>, sessionId: string): TextAgentOptions {
  return {
    agent: assistant,
    env,
    sessionId,
    model: MODEL,
    toolTimeoutMs: TOOL_TIMEOUT_MS,
  };
}

/**
 * One chat. Cheap to hold and cheap to make: a process serving many
 * conversations makes one of these per conversation and keeps no list of them.
 */
export function openChat(env: Record<string, string>, sessionId: string): TextAgent {
  return createTextAgent(chatOptions(env, sessionId));
}

/** The conversation, as the caller holds it. Nothing here holds a copy. */
export type ChatHistory = TextTurnOptions["messages"];

/**
 * Start one turn.
 *
 * `stopWhen` composes with the agent's own step cap rather than replacing it,
 * and the runtime spends the LAST step with `toolChoice: "none"` so a capped
 * turn ANSWERS instead of stopping straight after a tool result — a turn that
 * ends there completes successfully with nothing said, which reads to a user as
 * the agent giving up.
 *
 * The result is the model stream itself, not a wrapper: pass it to whatever
 * your chat surface already consumes (`textStream`, `steps`,
 * `toUIMessageStream`).
 */
export function streamTurn(
  chat: TextAgent,
  messages: ChatHistory,
  signal?: AbortSignal,
): TextTurnResult {
  const deadline = Date.now() + TURN_BUDGET_MS;
  const turn: TextTurnOptions = {
    messages,
    toolChoice: "auto",
    stopWhen: [() => Date.now() > deadline],
  };
  return chat.stream(signal === undefined ? turn : { ...turn, signal });
}

/**
 * Read a turn to the end.
 *
 * Draining the stream is also what FORCES the tool loop: nothing is requested
 * from the model until something reads, so a host that ignores the result gets
 * a turn that never ran. A surface that streams to a client instead of
 * accumulating still has to consume every chunk.
 */
export async function drainReply(result: TextTurnResult): Promise<string> {
  let reply = "";
  for await (const delta of result.textStream) reply += delta;
  return reply;
}

/**
 * The loop: append the user's message, run the turn, append the reply.
 *
 * Appending only after the drain is deliberate — an aborted or failed turn
 * leaves the history with the user's message and no half-written answer, which
 * is the state a retry wants.
 */
export async function chatTurn(
  chat: TextAgent,
  history: ChatHistory,
  userText: string,
  signal?: AbortSignal,
): Promise<string> {
  history.push({ role: "user", content: userText });
  const reply = await drainReply(streamTurn(chat, history, signal));
  history.push({ role: "assistant", content: reply });
  return reply;
}

/**
 * A turn with a system prompt of its own — a one-off instruction (summarize
 * this thread, answer as a title) that must not become the chat's default. The
 * agent's `system` is what every other turn uses.
 */
export function streamWithPreamble(
  chat: TextAgent,
  messages: ChatHistory,
  system: string,
): TextTurnResult {
  return chat.stream({ messages, system });
}
