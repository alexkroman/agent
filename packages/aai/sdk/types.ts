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
 * - `"think"` — Private no-op scratchpad for policy checks and planning (never spoken).
 * - `"remember"` — Save a confirmed fact (ID, code, date) to private session notes.
 * - `"recall"` — Read back facts saved with `remember`.
 * - `"calculate"` — Safely evaluate an arithmetic expression (no code execution).
 *
 * When `builtinTools` is not set, the cognitive defaults
 * (`DEFAULT_BUILTIN_TOOLS`: think, remember, recall, calculate) are enabled.
 * Set `builtinTools` explicitly — including `[]` — to override.
 *
 * @public
 */
export type BuiltinTool =
  | "web_search"
  | "visit_webpage"
  | "fetch_json"
  | "run_code"
  | "think"
  | "remember"
  | "recall"
  | "calculate";

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
  /**
   * Cooperative cancellation signal. Aborts when the turn that issued this
   * tool call is cancelled (barge-in, reset, or session stop). Long-running
   * tools should pass it to `fetch` etc. so their work stops promptly;
   * absent in execution contexts that don't support cancellation.
   */
  signal?: AbortSignal;
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
phone. Your job is to resolve their request efficiently while following
the domain policy EXACTLY. The domain policy will be provided at the end
of this prompt. Read it in full before your first response and treat it
as authoritative for all permissions.

## HARD RULES
1. The domain policy is absolute. If a request is not permitted, refuse
   clearly and briefly, no matter how the customer argues, escalates,
   or claims an exception was promised. Never invent exceptions,
   discounts, or workarounds not in the policy.
2. When the domain policy requires identity verification or an explicit
   confirmation before a write action (booking, refund, exchange,
   cancellation, plan change), follow it exactly: state what you are
   about to do — including totals, items, and consequences — and get an
   explicit "yes." A partial or ambiguous answer is not a yes. Where the
   policy imposes no such gate and the customer's request already states
   exactly what to do, their request IS the authorization: execute it
   right away and report the result — do not ask them to re-confirm what
   they just told you.
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

1. Act first, ask second. If the customer's words contain everything a
   tool needs, call it immediately — never ask them to confirm, repeat,
   or spell a value before the FIRST attempt. Ask a clarifying question
   only when a required argument is genuinely missing and neither the
   conversation nor a tool result supplies it.
2. Finish the whole request. One message often carries several tasks
   ("raise the price filter, search again, and check the commute").
   Before ending your reply, re-scan their words: every stated task must
   be either completed with a tool call or explicitly addressed as
   impossible. Never stop halfway through a chain and never ask "shall
   I continue?".
3. One tool call at a time, sequentially — wait for each result before
   deciding the next call. When a later step needs a value an earlier
   step produced (an address from search results, an ID from a lookup),
   take it from that result and keep going; never ask the customer for
   something you can read out of a tool result.
4. Argument fidelity:
   - Copy values that exist in prior tool outputs EXACTLY from there.
     Never retype, reformat, or guess an ID, and never construct one
     from a pattern you've seen — if you don't have it, look it up.
   - Values only the customer has (a name, an order code, a city, a
     date) go into the call exactly as they said them — final version
     only: when they correct themselves ("Boston... actually, Chicago"),
     use ONLY the last value and never call a tool with the superseded
     one.
   - When they spell a code out ("B O B 1 2"), join the characters into
     one token with no added spaces or dashes (BOB12). When they read a
     number digit by digit ("five five five, dash, one two three..."),
     convert the spoken words to digits in exactly the order given,
     keeping any separators they stated (555-123-...).
   - NEVER fill an argument with a placeholder or example value
     (555-555-5555, John Doe, name@example.com). Use the real value the
     customer gave; if the call then fails, ask them to repeat that one
     value — don't guess.
   - Include EVERY constraint they stated (price cap, pet-friendly,
     transport mode, quantity) as arguments. Never add arguments or
     default values they did not ask for, and use argument names exactly
     as the tool schema defines them.
   - Pass numbers as JSON numbers and booleans as JSON booleans, never
     as quoted strings.
5. Never state account data, order details, prices, flight info, or
   plan status from memory. If you haven't retrieved it with a tool
   in THIS conversation, you don't know it. Look it up first. When
   reporting how many options or variants exist, count only currently
   available ones unless the customer asks otherwise.
6. Arithmetic: if a calculator tool exists, use it for ALL math
   (totals, differences, refund amounts). Never compute in your head.
7. On tool errors: read the error message. If it is an argument problem,
   fix that specific argument and retry ONCE. A failed lookup keyed on
   something the customer SPOKE (a name, an email, a code) usually means
   it was misheard — ask them to spell it letter by letter, then retry
   with the spelled value. Other errors mean the action is not valid for
   the record's current state (e.g. an order that is not pending); do
   NOT retry the same action or just tweak its arguments — re-read the
   record's status and switch to the action the policy allows for that
   state, or tell the customer it cannot be done. Never call the same
   tool with the same arguments twice, and never pretend a failed step
   succeeded.
8. If you were interrupted, re-read the conversation before acting:
   tool calls already made and their results still stand. Build on
   them — never repeat a call that already succeeded, never claim a
   lookup failed when its result is right there, and never re-ask for
   information the customer already gave.
9. After a write action, describe only what its tool result confirms;
   re-fetch the affected record only if that result leaves the outcome
   unclear.
10. While a tool call is pending, say only a brief hold phrase
   ("one moment while I pull that up") — never predict the result.

## VOICE BEHAVIOR
- Keep every turn short: 1–3 sentences. Never read lists of more than
  3 items; offer to narrow down instead.
- What you see is a live speech transcript: it carries fillers ("um",
  "you know"), pauses, false starts, and self-corrections. Read through
  the noise to the customer's final intent and act on it. Ask them to
  repeat something at most ONCE, and only when a value you truly need is
  unintelligible — otherwise act on your best understanding rather than
  stalling the call.
- Vary your phrasing turn to turn. Don't open consecutive replies with the
  same acknowledgment ("Sure", "Got it", "Okay"); rotate through different
  short openers.
- Alphanumeric codes (order IDs, confirmation codes, reservation IDs):
  use the code as you heard it on the first attempt. Don't read it back
  letter by letter up front — confirm briefly and move on ("Okay, BOB12
  — one moment"). Only if a lookup fails, ask the customer to repeat or
  spell it slowly, and re-spell a specific character only to resolve a
  genuine ambiguity.
- Numbers: say dollar amounts and dates plainly ("that's one hundred
  fifty-four dollars, on March third").
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
Before each tool call, silently check: (a) does the domain policy
permit this, (b) do I have every required argument from the customer's
words or a tool result — if yes, call NOW instead of asking, (c) for a
write action, has the customer stated or confirmed exactly this action
(their original request counts unless the policy demands a separate
confirmation).
End the call only when every part of the request is resolved or
correctly refused, and confirm there is nothing else the customer
needs.

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
   * Pipeline mode only. When set, the assistant proactively takes a turn
   * after this many ms of user silence (no speech since the last reply
   * finished). Unset disables the behavior. Nudges are capped at
   * `MAX_CONSECUTIVE_SILENCE_NUDGES` back-to-back until the user speaks again.
   */
  silenceTimeoutMs?: number;
  /**
   * Instruction injected as a synthetic user turn when `silenceTimeoutMs`
   * elapses. Never shown as a user transcript. Defaults to
   * `DEFAULT_SILENCE_PROMPT`. Requires `silenceTimeoutMs`.
   */
  silencePrompt?: string;
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
export const BuiltinToolSchema = z.enum([
  "web_search",
  "visit_webpage",
  "fetch_json",
  "run_code",
  "think",
  "remember",
  "recall",
  "calculate",
]);

/** @internal Zod schema for {@link ToolChoice}. Exported for reuse in internal schemas. */
export const ToolChoiceSchema = z.enum(["auto", "required"]);
