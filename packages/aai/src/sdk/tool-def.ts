// Copyright 2026 the AAI authors. MIT license.
/**
 * What a TOOL is, as a type: its definition and the two helpers that read one.
 *
 * Split out of `types.ts` for the same reason `agent-defaults.ts` and
 * `tool-context.ts` were — that file is at the 500-line cap — and along the
 * seam an author already reads as one unit: a tool's shape, its input type and
 * its result type. Import them from `./types.ts` (which re-exports all three) or
 * from the package root, as before.
 *
 * `DefaultToolResult` deliberately stayed behind: `biome.json` turns
 * `noExplicitAny` off for `types.ts` by path, and moving the one `any` here
 * would need a second override or an escape hatch on the ratchet.
 */

import type { InferSchemaOutput, ToolInputSchema } from "./schema.ts";
import type { ToolContext } from "./tool-context.ts";
import type { ToolMessagesInput } from "./tool-messages.ts";
import type { ToolFailure } from "./utils.ts";

/**
 * What a tool does with an exception its `execute` threw — the shape of
 * {@link ToolDef.onError}.
 *
 * **Returning decides what the MODEL sees; throwing decides that it sees
 * nothing.** A returned {@link ToolFailure} or `string` is handed to the model
 * as that call's result, exactly as if `execute` had returned it — so the model
 * can apologise, ask again, or try another route. Throwing (including
 * re-throwing `err` unchanged) declares the failure UNRECOVERABLE: the runtime
 * reports it and the tool call ends in a rejection rather than a result, so the
 * model is never invited to retry a tool that cannot work.
 *
 * It is called with the same {@link ToolContext} `execute` was given, so a
 * handler can read `ctx.env` to tell a missing credential from a bad one, or
 * `ctx.signal.aborted` to tell a real fault from a cancelled turn.
 *
 * **Synchronous, deliberately.** It runs after the call's deadline has already
 * passed on the timeout path, so there is no budget left to await anything in;
 * the runtime refuses a thenable return and treats it as fatal, the same rule
 * `slot.updateTool` applies to a mutator body. Do the awaiting inside
 * `execute`, where the deadline still applies.
 *
 * @public
 */
export type ToolErrorHandler = (err: unknown, ctx: ToolContext) => ToolFailure | string;

/**
 * Definition of a custom tool that the agent can invoke.
 *
 * Tools are the primary way to extend agent capabilities. Each tool has a
 * description (shown to the LLM), an optional input schema, and an
 * `execute` function that runs inside the sandboxed worker.
 *
 * @typeParam P - The tool's input schema: any
 *   [Standard Schema](https://standardschema.dev) that can convert to JSON
 *   Schema — a Zod object schema (the documented default) or e.g. an
 *   ArkType type. Defaults to a permissive record schema so tools without
 *   inputs don't need an explicit type argument.
 *
 * @typeParam R - What `execute` returns, inferred at the {@link tool} call and
 *   read by {@link InferToolOutput}. Defaults to `unknown`, so `ToolDef<typeof
 *   schema>` still means "any result".
 *
 * @example
 * ```ts
 * import { tool } from "@alexkroman1/aai";
 * import { z } from "zod";
 *
 * const weatherTool = tool({
 *   description: "Get current weather for a city",
 *   inputSchema: z.object({
 *     city: z.string().describe("City name"),
 *   }),
 *   execute: async ({ city }) => {
 *     const res = await fetch(`https://wttr.in/${city}?format=j1`);
 *     return await res.json();
 *   },
 * });
 * ```
 *
 * @public
 */
export type ToolDef<P extends ToolInputSchema = ToolInputSchema, R = unknown> = {
  /** Human-readable description shown to the LLM. */
  description: string;
  /**
   * Schema for the tool's input, shown to the LLM and used to validate each
   * call's arguments before `execute` runs. Named after the Vercel AI SDK's
   * `tool({ inputSchema })`.
   */
  inputSchema?: P;
  /**
   * Function that executes the tool and returns a result, JSON-serialized for
   * the LLM and the client.
   *
   * **The model gets it WHOLE; only the client's copy is capped.**
   * `MAX_TOOL_RESULT_CHARS` (4000) bounds the `tool.completed` frame — a longer
   * result is trimmed there and ends with a `[truncated]` marker — and bounds
   * nothing on the provider side, where the full string is appended to the
   * conversation and re-sent on every later turn of the call. This doc used to
   * say the cap applied to both, which made an unshaped `await res.json()` look
   * free: it is the whole response, in the prompt, for the rest of the turn.
   * Return the fields the model needs. A result over the cap is warned about
   * once per tool (see `warnOversizedResult` in `aai-runtime`'s
   * `tool-executor.ts`).
   */
  execute(args: InferSchemaOutput<P>, ctx: ToolContext): R;
  /**
   * What to do when `execute` throws — and, by omission, the SDK's default.
   *
   * **Without it, every exception becomes an ordinary tool result.** The
   * runtime catches whatever `execute` threw and hands `errorMessage(err)` back
   * to the model as that call's result, which is the same channel a deliberate
   * {@link toolFailure} uses — so a stale credential, a `TypeError` in the
   * author's own code and "no such order" are one thing as far as the model can
   * tell, and it will keep calling a permanently broken tool until the reply's
   * `maxSteps` budget runs out. That default is unchanged and stays the default:
   * for the failures a model really can recover from it is the right answer, and
   * every tool written before this field existed depends on it.
   *
   * **With it, the author classifies.** Return a {@link ToolFailure} or a string
   * and that is what the model gets — the same outcome as the default, with a
   * sentence the author chose. Throw — `throw err` re-raises the original — and
   * the failure is FATAL to the call: the runtime logs it, reports it as a
   * session error (`code: "tool"`), and the tool call REJECTS instead of
   * answering, so nothing hands the model something to retry against.
   *
   * It sees only a THROW. A `ToolFailure` that `execute` RETURNED never reaches
   * it: that is already the author saying "expected, let the model recover", and
   * routing it through here would make the two channels one again.
   *
   * @example Fatal on a missing credential, recoverable on a bad lookup
   * ```ts
   * import { tool, toolFailure } from "@alexkroman1/aai";
   * import { z } from "zod";
   *
   * class MissingKeyError extends Error {}
   *
   * export default tool({
   *   description: "Look up an order",
   *   inputSchema: z.object({ id: z.string() }),
   *   execute: async ({ id }, ctx) => {
   *     if (!ctx.env.ORDERS_API_KEY) throw new MissingKeyError("ORDERS_API_KEY is unset");
   *     const res = await fetch(`https://api.example.com/orders/${id}`, {
   *       headers: { authorization: `Bearer ${ctx.env.ORDERS_API_KEY}` },
   *     });
   *     if (res.status === 404) return toolFailure(`No order ${id}.`);
   *     return await res.json();
   *   },
   *   // A credential the deploy is missing cannot be fixed by asking the model
   *   // to try again; a flaky upstream can.
   *   onError: (err) => {
   *     if (err instanceof MissingKeyError) throw err;
   *     return toolFailure("The orders service is unavailable right now.");
   *   },
   * });
   * ```
   */
  onError?: ToolErrorHandler;
  /**
   * What the agent SAYS while this tool runs, and what it says when it lands.
   *
   * Four kinds — `start`, `delayed`, `complete`, `failed` — documented on
   * {@link ToolMessagesInput}. Two of them change the shape of the turn rather
   * than just filling it:
   *
   * - **`delayed` is a LADDER when the timings differ and VARIANTS when they
   *   match.** Two entries at `afterMs: 3000` are two phrasings of one rung,
   *   one of which is drawn; entries at 3000 and 8000 are two rungs.
   * - **A `complete`/`failed` entry with `role: "assistant"` is spoken verbatim
   *   and the model is NOT CALLED.** For a deterministic outcome that removes a
   *   whole LLM round-trip from the turn. `role: "system"` is the other arm:
   *   the content rides back as a hint and the model writes the sentence.
   *
   * `start` and `delayed` are filler — they are heard, and they are never
   * recorded into `ctx.messages`, the model's view or the committed transcript,
   * and never count as the agent having spoken (so a caller talking over one
   * does not interrupt the reply being generated behind it). `complete` and
   * `failed` with `role: "assistant"` are the opposite on every count: that IS
   * the agent's answer.
   *
   * @example A hold line, a two-rung ladder, and an error the model phrases
   * ```ts
   * import { tool } from "@alexkroman1/aai";
   * import { z } from "zod";
   *
   * export default tool({
   *   description: "Look up an order",
   *   inputSchema: z.object({ orderId: z.string() }),
   *   messages: {
   *     start: ["Let me pull that up.", "One second while I check."],
   *     delayed: [
   *       { afterMs: 3000, content: "Still looking." },
   *       { afterMs: 9000, content: "Sorry, the order system is slow today." },
   *     ],
   *     failed: [{ role: "system", content: "Order lookup failed. Apologize and offer a callback." }],
   *   },
   *   execute: async ({ orderId }) => ({ orderId, status: "shipped" }),
   * });
   * ```
   */
  messages?: ToolMessagesInput;
};

/**
 * The validated input type a tool's `execute` receives — inferred from the
 * tool's `inputSchema`. The Vercel AI SDK's `InferToolInput` pattern, so a
 * client (or another tool) can share the exact argument shape without
 * re-declaring it.
 *
 * ```ts
 * import { type InferToolInput, tool } from "@alexkroman1/aai";
 * import { z } from "zod";
 *
 * const add = tool({
 *   description: "Add an item",
 *   inputSchema: z.object({ item: z.string() }),
 *   execute: ({ item }) => item,
 * });
 * type AddInput = InferToolInput<typeof add>; // { item: string }
 * ```
 *
 * @public
 */
export type InferToolInput<T extends ToolDef<ToolInputSchema>> = Parameters<T["execute"]>[0];

/**
 * The result type a tool's `execute` returns (awaited, so a sync and an `async`
 * body infer alike). Pair with `useToolResult<InferToolOutput<typeof myTool>>(...)`
 * in a custom client so the rendered shape has a single source of truth.
 *
 * @public
 */
export type InferToolOutput<T extends ToolDef<ToolInputSchema>> = Awaited<ReturnType<T["execute"]>>;

/**
 * How the LLM should select tools. Mirrors the Vercel AI SDK's `toolChoice`.
 *
 * **It is resolved PER REQUEST, and one value can arrive from four different
 * scopes**, which is why none of the arms below can be described as a property
 * of "the session". Every LLM request carries whichever of these is set, each
 * one overriding the ones above it:
 *
 * 1. **The agent** — `agent({ toolChoice })` is the standing default for every
 *    request the agent makes, and what an unset field falls back to. A
 *    DEMANDING value is put back to `"auto"` after the reply's first step
 *    unless `resetToolChoice: false` says otherwise — see the `"required"`
 *    arm below.
 * 2. **The turn** — in text mode a caller may override it for one turn
 *    (`stream({ toolChoice })`). A voice session has no such caller.
 * 3. **The dialog state** — a `dialog()` state may carry `toolChoice`, read
 *    deepest-active-state-first, so a state that must not act overrides the
 *    two above for exactly as long as the conversation is in it, one step at a
 *    time.
 * 4. **The step** — the runtime forces `"none"` on the reply's LAST step
 *    (`forceFinalAnswer`), so a reply that ran out of tool-calling budget still
 *    ends in an answer instead of silence. That override wins over all three,
 *    including an agent-level `"required"`, which would otherwise demand a tool
 *    call on the one step where tools are switched off.
 *
 * So the same value means "for every reply", "for this turn", "while in this
 * state" or "on this one step" depending on where it was written. The arms:
 *
 * - `"auto"` — the model decides whether to call a tool on this request
 *   (the default, and what an unset field resolves to).
 * - `"required"` — the model must call at least one tool on this request.
 *   **By default it lasts ONE step, not the whole reply.** Each step is its own
 *   request, so a demand left standing re-obliges the model to call a tool after
 *   it already has, and again after that, until the reply has spent its whole
 *   `maxSteps` budget and the forced final step rescues it — bounded, but the
 *   caller waits through every round trip it had no use for. What `"required"`
 *   almost always means is "start by calling something", which is exactly one
 *   step, so `agent({ resetToolChoice })` — `true` unless you set it, the same
 *   default as OpenAI's Agents SDK ships as `reset_tool_choice` — puts the
 *   choice back to `"auto"` from the second step on. `resetToolChoice: false`
 *   is how an agent that really does want a tool call on every step says so,
 *   and it is the only way to get that behaviour. The reset applies to the
 *   demand resolved from scope 1 or 2; a dialog state's `toolChoice` (scope 3)
 *   is re-read on every step and holds for as long as the conversation is in
 *   that state, and scope 4 still wins over both.
 * - `"none"` — the model may not call a tool on this request. It is not a
 *   session-wide switch, and cannot be one: a later request in the same session
 *   is resolved again from whatever scope applies to it.
 * - `{ type: "tool", toolName }` — the model must call the named tool on this
 *   request.
 *
 * @public
 */
export type ToolChoice = "auto" | "required" | "none" | { type: "tool"; toolName: string };

/**
 * Default type of a tool result observed on the client (`useToolResult`) —
 * `any`, so untyped reads compile. Pass the shape —
 * `useToolResult<Quote>("get_quote", …)` — for real checking.
 *
 * @remarks
 * `any` because a tool result is the author's own return value
 * round-tripped through JSON — the client already knows its shape, and the
 * framework cannot. The strict default (`unknown`) made reading one field a
 * compile error in a client that runs correctly, which blocked publishing
 * once `aai build` type-checked.
 *
 * @public
 */
export type DefaultToolResult = any;

/**
 * What `ToolDef.messages` takes, re-exported from the module that declares
 * `ToolDef` itself.
 *
 * The same move `DefaultToolResult` made when `types.ts` hit the 500-line cap,
 * and for the same reason: these are tool-authoring types whose group was
 * already one re-export line below them there, and this module is the one that
 * NAMES them — `ToolMessagesInput` is the type of the field. A tool that
 * declares `messages` usually declares it inline, so these are for the author
 * who pulls a shared set of lines out into a constant, and because a type a
 * published signature names has to be importable (`check:api-nameable`).
 */
export type {
  ToolCompletionMessage,
  ToolConditionOperator,
  ToolDelayedMessage,
  ToolMessageCondition,
  ToolMessages,
  ToolMessagesInput,
  ToolStartMessage,
} from "./tool-messages.ts";
