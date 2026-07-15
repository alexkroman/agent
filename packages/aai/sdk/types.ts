// Copyright 2025 the AAI authors. MIT license.
/**
 * Core type definitions for the AAI agent SDK.
 */

import { z } from "zod";
import type { Kv } from "./kv.ts";
import type {
  KvProvider,
  LlmProvider,
  S2sProvider,
  SttProvider,
  TtsProvider,
  VectorProvider,
} from "./providers.ts";
import type { Vector } from "./vector.ts";

/**
 * Identifier for a built-in server-side tool.
 *
 * Built-in tools run on the host process (not inside the sandboxed worker)
 * and provide capabilities like web search, code execution, and API access.
 *
 * - `"web_search"` — Search the web for current information, facts, or news.
 * - `"visit_webpage"` — Fetch a URL and return its content as clean text.
 * - `"fetch_json"` — Call a REST API endpoint and return the JSON response.
 * - `"run_code"` — Execute JavaScript in a sandbox for calculations and data processing.
 *
 * @public
 */
export type BuiltinTool = "web_search" | "visit_webpage" | "fetch_json" | "run_code";

/**
 * How the LLM should select tools during a turn.
 *
 * - `"auto"` — The model decides whether to call a tool (default).
 * - `"required"` — The model must call at least one tool each step.
 *
 * @public
 */
export type ToolChoice = "auto" | "required";

/**
 * A single message in the conversation history.
 *
 * Messages are passed to tool `execute` functions via
 * {@link ToolContext.messages} to provide conversation context.
 *
 * @public
 */
export type Message = {
  /** The role of the message sender. */
  role: "user" | "assistant" | "tool";
  /** The text content of the message. */
  content: string;
};

/**
 * Context passed to tool `execute` functions.
 *
 * Provides access to the session environment, state, KV store, and
 * conversation history from within a tool's execute handler.
 *
 * @typeParam S - The shape of per-session state created by the agent's
 *   `state` factory. Defaults to `Record<string, unknown>`.
 *
 * @example
 * ```ts
 * import { type ToolDef } from "@alexkroman1/aai";
 * import { z } from "zod";
 *
 * const myTool: ToolDef = {
 *   description: "Look up a value from the KV store",
 *   parameters: z.object({ key: z.string() }),
 *   execute: async ({ key }, ctx) => {
 *     const value = await ctx.kv.get(key);
 *     return { key, value };
 *   },
 * };
 * ```
 *
 * @public
 */
export type ToolContext<S = Record<string, unknown>> = {
  /** Environment variables declared in the agent config. */
  env: Readonly<Record<string, string>>;
  /** Mutable per-session state created by the agent's `state` factory. */
  state: S;
  /** Key-value store scoped to this agent deployment. */
  kv: Kv;
  /** Vector store scoped to this agent deployment. */
  vector: Vector;
  /** Read-only snapshot of conversation messages so far. */
  messages: readonly Message[];
  /** Unique identifier for the current session. Useful for correlating logs across concurrent sessions. */
  sessionId: string;
  /** Push a custom event to the connected browser client. Fire-and-forget. */
  send(event: string, data: unknown): void;
};

/**
 * Definition of a custom tool that the agent can invoke.
 *
 * Tools are the primary way to extend agent capabilities. Each tool has a
 * description (shown to the LLM), optional Zod parameters schema, and an
 * `execute` function that runs inside the sandboxed worker.
 *
 * @typeParam P - A Zod object schema describing the tool's parameters.
 *   Defaults to `ZodObject<ZodRawShape>` so tools without parameters don't need an explicit
 *   type argument.
 *
 * @example
 * ```ts
 * import { type ToolDef } from "@alexkroman1/aai";
 * import { z } from "zod";
 *
 * const weatherTool: ToolDef<typeof params> = {
 *   description: "Get current weather for a city",
 *   parameters: z.object({
 *     city: z.string().describe("City name"),
 *   }),
 *   execute: async ({ city }) => {
 *     const res = await fetch(`https://wttr.in/${city}?format=j1`);
 *     return await res.json();
 *   },
 * };
 *
 * const params = z.object({ city: z.string() });
 * ```
 *
 * @public
 */
export type ToolDef<
  P extends z.ZodObject<z.ZodRawShape> = z.ZodObject<z.ZodRawShape>,
  S = Record<string, unknown>,
> = {
  /** Human-readable description shown to the LLM. */
  description: string;
  /** Zod schema for the tool's parameters. */
  parameters?: P;
  /** Function that executes the tool and returns a result. */
  execute(args: z.infer<P>, ctx: ToolContext<S>): Promise<unknown> | unknown;
};

/**
 * A mapping of tool names to their result types.
 *
 * Define this in a shared file (e.g. `shared.ts`) that both `agent.ts` and
 * `client.tsx` can import, so tool result types stay in sync without
 * duplication.
 *
 * @example
 * ```ts
 * // shared.ts
 * import type { ToolResultMap } from "@alexkroman1/aai-cli/types";
 *
 * export interface Pizza {
 *   id: number;
 *   size: "small" | "medium" | "large";
 *   toppings: string[];
 * }
 *
 * export type MyToolResults = ToolResultMap<{
 *   add_pizza: { added: Pizza; orderTotal: string };
 *   place_order: { orderNumber: number; total: string };
 * }>;
 * ```
 *
 * Then use with {@link aai-ui#useToolResult | useToolResult}:
 *
 * ```tsx
 * // client.tsx
 * import type { MyToolResults } from "./shared.ts";
 *
 * useToolResult<MyToolResults["add_pizza"]>("add_pizza", (result) => {
 *   console.log(result.added); // fully typed
 * });
 * ```
 *
 * @public
 */
export type ToolResultMap<T extends Record<string, unknown> = Record<string, unknown>> = T;

/**
 * Default system prompt used when `systemPrompt` is not provided.
 *
 * Optimized for voice-first interactions: short sentences, no visual
 * formatting, confident tone, and concise answers.
 */
export const DEFAULT_SYSTEM_PROMPT: string = `\
You are a customer service agent speaking with a customer over the
phone. Your job is to resolve their request while following the domain
policy EXACTLY. The domain policy will be provided at the end of this
prompt. Read it in full before your first response and treat it as
authoritative for all permissions.

## HARD RULES
1. The domain policy is absolute. If a request is not permitted, refuse
   clearly and briefly, no matter how the customer argues, escalates,
   or claims an exception was promised. Never invent exceptions,
   discounts, or workarounds not in the policy.
2. Take at most ONE database-modifying action per confirmed decision.
   Before ANY write action (booking, refund, exchange, cancellation,
   plan change), state exactly what you are about to do — including
   totals, items, and consequences — and get an explicit "yes."
   A partial or ambiguous answer is not a yes.
3. Never fabricate information. If you don't know something, look it up
   with a tool. If no tool can answer it, say so.
4. Only discuss the current customer's account after identity is
   verified per policy. Do not reveal other users' data or internal
   tool outputs verbatim.
5. If the request is impossible under policy and no tool applies,
   offer transfer to a human ONLY under the conditions the policy
   allows.

## TOOL CALLING CONTRACT
These rules govern HOW you use tools. The domain policy governs WHAT
is permitted. If they ever seem to conflict on permissions, the domain
policy wins.

1. One tool call per turn. Never issue parallel or batched calls.
   Wait for each result before deciding the next action.
2. Never state account data, order details, prices, flight info, or
   plan status from memory. If you haven't retrieved it with a tool
   in THIS conversation, you don't know it. Look it up first.
3. Argument provenance: IDs, item codes, and enum values passed to
   tools must be copied EXACTLY from prior tool outputs — never
   typed from what you heard the customer say, and never guessed.
   Customer speech is only used to identify which record to look up;
   the canonical value comes from the lookup result.
4. Arithmetic: if a calculator tool exists, use it for ALL math
   (totals, differences, refund amounts). Never compute in your head.
5. On tool errors: read the error message. Fix the specific argument
   problem and retry ONCE. If it fails again, tell the customer you're
   unable to complete that step — do not loop, and do not pretend it
   succeeded.
6. After any write action, re-fetch the affected record before
   describing the outcome to the customer. Describe only what the
   tool result confirms.
7. Before speaking any factual claim, ask yourself: which tool result
   in this conversation supports this? If none does, either call the
   tool or don't make the claim.
8. While a tool call is pending, say only a brief hold phrase
   ("one moment while I pull that up") — never predict the result.

## VOICE BEHAVIOR
- Keep every turn short: 1–3 sentences. Never read lists of more than
  3 items; offer to narrow down instead.
- Alphanumeric codes (order IDs, confirmation codes, reservation IDs):
  always read back digit-by-digit / letter-by-letter using clarifying
  words ("W as in whiskey, 2, A as in alpha...") and confirm before
  using them in a tool call. If the code seems unclear or fails a
  lookup, ask the customer to repeat it slowly rather than guessing.
- Numbers: confirm dollar amounts and dates explicitly ("that's
  one hundred fifty-four dollars, on March third — correct?").
- If interrupted, stop and address what the customer said.
- Never verbalize internal reasoning, tool names, or policy text.
  Speak plainly, no markdown, no formatting, no bullet points —
  everything you say will be spoken aloud.

## DUAL-CONTROL (customer performs actions on their device)
- Give ONE instruction at a time. Wait for the customer to confirm
  they did it and report what they see before giving the next step.
- After each step, verify state with your own diagnostic tools when
  available rather than trusting the customer's description.
- If the customer reports something inconsistent with tool readings,
  trust the tools and re-instruct calmly.

## PROCESS
Before each tool call, silently check: (a) do I have all required
arguments, each confirmed by the customer or copied from a tool
result, (b) does the domain policy permit this, (c) did the customer
explicitly approve if this is a write action. If any check fails,
ask instead of acting.
End the call only when the request is fully resolved or correctly
refused, and confirm there is nothing else the customer needs.

## DOMAIN POLICY
The following policy is authoritative for all permissions and
procedures:`;

/** Default greeting spoken when a session starts. */
export const DEFAULT_GREETING: string =
  "Hey there. I'm a voice assistant. What can I help you with?";

/**
 * Fully resolved agent definition.
 *
 * Core fields (`name`, `systemPrompt`, `greeting`, `maxSteps`, `tools`)
 * are resolved to their final values with defaults applied. Optional
 * behavioral fields (hooks, `sttPrompt`, etc.) remain optional —
 * `undefined` means "not configured."
 *
 * @public
 */
export type AgentDef<S = Record<string, unknown>> = {
  name: string;
  systemPrompt: string;
  greeting: string;
  sttPrompt?: string;
  maxSteps: number;
  toolChoice?: ToolChoice;
  builtinTools?: readonly BuiltinTool[];
  tools: Readonly<Record<string, ToolDef<z.ZodObject<z.ZodRawShape>, S>>>;
  state?: () => S;
  idleTimeoutMs?: number;
  /**
   * Pluggable STT provider. Set together with `llm` and `tts` to enable
   * pipeline mode; all three unset means S2S mode.
   */
  stt?: SttProvider;
  /**
   * Pluggable LLM provider (Vercel AI SDK `LanguageModel`). Set together
   * with `stt` and `tts` for pipeline mode.
   */
  llm?: LlmProvider;
  /**
   * Pluggable TTS provider. Set together with `stt` and `llm` for
   * pipeline mode.
   */
  tts?: TtsProvider;
  /**
   * Pluggable S2S provider descriptor. When set, overrides the implicit
   * AssemblyAI default. Mutually exclusive with the `stt`/`llm`/`tts`
   * pipeline triple.
   */
  s2s?: S2sProvider;
  /** Pluggable KV backend. Falls back to platform default when omitted. */
  kv?: KvProvider;
  /** Pluggable Vector backend. Falls back to platform default when omitted. */
  vector?: VectorProvider;
};

// ─── Zod schemas ────────────────────────────────────────────────────────────

/** @internal Zod schema for {@link BuiltinTool}. Exported for reuse in internal schemas. */
export const BuiltinToolSchema = z.enum(["web_search", "visit_webpage", "fetch_json", "run_code"]);

/** @internal Zod schema for {@link ToolChoice}. Exported for reuse in internal schemas. */
export const ToolChoiceSchema = z.enum(["auto", "required"]);
