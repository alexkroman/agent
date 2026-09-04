// Copyright 2026 the AAI authors. MIT license.
/**
 * The `ctx.delegate` capability contract — hand a bounded, context-isolated
 * task to a SUBAGENT from inside a tool's `execute`.
 *
 * A subagent is a second tool loop: its own systemPrompt, its own model, its
 * own tools, and — the whole point — its own context window. The parent's
 * conversation never sees the subagent's steps, only what it returns. That is
 * the Vercel AI SDK's subagent pattern (`ToolLoopAgent` invoked from a tool),
 * expressed as a runtime capability like {@link GenerateFn} rather than as a
 * class an author instantiates: the model, the credential and the tool
 * executor are the RUNTIME's to own, and an author who reaches for
 * `new ToolLoopAgent(...)` in a tool body has to re-derive all three — which
 * is how a tool ends up reading `process.env` on a platform where every key
 * is user-provided.
 *
 * **`ctx.generate` is the one-shot; this is the loop.** Reach for `generate`
 * when one prompt answers the question. Reach for `delegate` when answering it
 * takes an unknown number of tool calls whose intermediate results the parent
 * has no reason to carry — a search-read-search-read pass that spends tens of
 * thousands of tokens and is worth one paragraph to the caller.
 *
 * ```ts
 * import { subagent, tool } from "@alexkroman1/aai";
 * import { z } from "zod";
 *
 * const researcher = subagent({
 *   name: "researcher",
 *   systemPrompt:
 *     "Research the task with the tools you have. When you are done, write a " +
 *     "short summary of what you found — that summary is all the caller sees.",
 *   builtinTools: ["web_search", "visit_webpage"],
 *   maxSteps: 6,
 * });
 *
 * export default tool({
 *   description: "Research a question in depth",
 *   inputSchema: z.object({ question: z.string() }),
 *   execute: async ({ question }, ctx) => {
 *     const { text, toolCalls } = await ctx.delegate(researcher, { task: question });
 *     return `${text} (${toolCalls.length} lookups)`;
 *   },
 * });
 * ```
 */

import type { LlmProvider } from "./providers.ts";
import type { BuiltinTool, ToolDef } from "./types.ts";

/**
 * A subagent definition — what {@link subagent} returns and
 * {@link DelegateFn} runs.
 *
 * Every field except `name` and `systemPrompt` is optional, and the defaults
 * are the parent agent's: the same LLM descriptor, no tools, and
 * the framework default (`DEFAULT_MAX_STEPS`) steps.
 *
 * @public
 */
export interface SubagentDef {
  /**
   * What this subagent is called. It reaches the model only as the id on the
   * subagent's own requests; its reader is a log line and a failure message
   * ("subagent \"researcher\" ran out of steps"), which is why it is required
   * and why an anonymous subagent is not expressible.
   */
  name: string;
  /**
   * The subagent's system prompt.
   *
   * **Tell it to summarize.** The parent gets {@link DelegateResult.text},
   * which is the subagent's FINAL message — so a subagent that ends its run by
   * saying "Done." has thrown away everything it learned, and no amount of
   * step budget recovers it. This is the single most common way a subagent
   * disappoints, and the remedy is one sentence in the systemPrompt.
   */
  systemPrompt: string;
  /**
   * LLM for this subagent: a descriptor from `@alexkroman1/aai/llm`, or a
   * model-id string — the same shorthand as `agent({ llm })` and
   * {@link GenerateOptions.llm}. Defaults to the parent agent's own LLM.
   *
   * Naming a cheaper model here is the usual reason to set it: a subagent
   * doing lookups is spending most of its tokens on tool results, not on
   * reasoning.
   */
  llm?: LlmProvider | string;
  /**
   * The tools this subagent may call, by the name the model calls them by.
   *
   * A MAP rather than the filesystem registration `agent()` uses, and the
   * difference is deliberate: `tools/` declares what the CALLER can reach, and
   * this declares the strictly narrower set one delegated task can reach. A
   * subagent with no entry here and no `builtinTools` is a pure reasoning
   * pass — legal, and occasionally what you want.
   */
  tools?: Readonly<Record<string, ToolDef>>;
  /**
   * Builtins this subagent may call, resolved exactly as `agent({
   * builtinTools })` resolves them. Independent of the parent's: a parent that
   * enables none can still delegate to a subagent that searches the web.
   */
  builtinTools?: readonly BuiltinTool[];
  /**
   * Tool-calling steps this subagent may take before it must answer. Defaults
   * to the framework's `DEFAULT_MAX_STEPS`.
   *
   * The budget is the mechanism: a subagent told to "keep looking until sure"
   * is a subagent whose cost nobody can quote. Past the cap it is asked for
   * its answer with tools withheld, so a capped run still returns prose rather
   * than stopping mid-chain.
   */
  maxSteps?: number;
  /** Sampling temperature passed through to the provider. */
  temperature?: number;
  /** Cap on generated tokens per step, passed through to the provider. */
  maxOutputTokens?: number;
}

/**
 * Define a subagent.
 *
 * An identity function, like {@link tool} — it exists for the type, for the
 * name to grep for, and so a subagent is declared at module scope rather than
 * rebuilt inside `execute` on every call.
 *
 * @public
 */
export function subagent(def: SubagentDef): SubagentDef {
  return def;
}

/** Per-call options for {@link DelegateFn}. @public */
export interface DelegateOptions {
  /**
   * The task, as the subagent's first user message. Write it as a complete
   * brief: the subagent's context is ISOLATED, so it has not read the
   * conversation and knows nothing the task does not say.
   */
  task: string;
  /**
   * Extra context appended after the subagent's own `systemPrompt` for this
   * call — the caller's name, what has already been ruled out, the format the
   * answer should take. Absent by default, because a subagent that needs the
   * conversation to make sense is one whose task was underspecified.
   */
  context?: string;
  /**
   * Override the subagent's step budget for this call.
   */
  maxSteps?: number;
}

/** One tool call a subagent made, as reported back to the caller. @public */
export interface SubagentToolCall {
  /** The tool's name, as the subagent's model called it. */
  name: string;
  /** The arguments it was called with. */
  input: unknown;
}

/**
 * What one delegated run returns.
 *
 * `text` is the answer; `steps` and `toolCalls` are what the run COST, which
 * is the half a voice agent needs in order to say something true about the
 * wait ("I checked four sources"). They are a report, not a transcript: the
 * tool RESULTS stay inside the subagent's context, which is the entire reason
 * to have delegated.
 *
 * @public
 */
export interface DelegateResult {
  /** The subagent's final message — see {@link SubagentDef.systemPrompt}. */
  text: string;
  /** How many steps the run took, including the final answering step. */
  steps: number;
  /** Every tool call the subagent made, in order. */
  toolCalls: readonly SubagentToolCall[];
}

/**
 * Run a subagent to completion — the signature of `ctx.delegate`.
 *
 * Rejects when the run cannot be started (no LLM configured or named, an
 * unknown builtin) and when the parent turn is cancelled. A subagent whose own
 * TOOL fails does not reject: the failure goes back to the subagent as a tool
 * result, exactly as it would in the parent loop, and the subagent gets to
 * recover from it.
 *
 * @public
 */
export type DelegateFn = (
  subagent: SubagentDef,
  options: DelegateOptions,
) => Promise<DelegateResult>;
