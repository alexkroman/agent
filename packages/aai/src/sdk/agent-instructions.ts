// Copyright 2026 the AAI authors. MIT license.
/**
 * A system prompt that is computed per request rather than fixed for the call.
 *
 * `AgentDef.systemPrompt` was typed `string`, and the transports had supported
 * a per-request resolver the whole time — `SystemPromptOption` in
 * `@alexkroman1/aai-runtime` has been `string | (() => string)`, re-resolved at
 * request-assembly time on every path (pipeline, speculation, OpenAI Realtime,
 * the runtime transport). The capability was built and simply unreachable from
 * an `agent.ts`. This is the type that exposes it.
 *
 * **The resolver takes the session**, which the runtime-internal thunk did not.
 * A nullary resolver can vary the prompt by wall-clock time and nothing else —
 * it cannot read a slot, so it cannot say "this caller is already
 * authenticated" or "the cart has three items", which is most of the reason to
 * want one. Every peer SDK passes run context here (OpenAI's
 * `(runContext, agent)`, Pydantic's `RunContext[Deps]`, Mastra's
 * `{ runtimeContext }`), and {@link AgentSessionContext} is this SDK's answer:
 * the session id, the agent env, and the session's slots.
 *
 * ## Where the resolved text LANDS
 *
 * Exactly where a static `systemPrompt` lands: appended under the
 * "Agent-specific instructions (these override the defaults above where they
 * conflict)" header, after the framework's own voice sections. A resolver does
 * not REPLACE the framework prompt any more than a string does — see
 * `buildSystemPrompt` and `DEFAULT_SYSTEM_PROMPT`.
 *
 * The framework half stays cached per calendar day; only the resolver's own
 * output is recomputed. So a resolver is on the per-turn path and should behave
 * like one: synchronous by contract (there is nowhere to await — the request is
 * being assembled), and cheap.
 *
 * ## When it is called
 *
 * Once per model request, which is once per STEP in a tool-calling reply, not
 * once per turn. A resolver whose answer changes between two steps of the same
 * reply changes the instructions mid-reply, which is legal and occasionally
 * what you want (a dialog phase advanced by the tool that just ran) but is not
 * what most authors picture.
 *
 * **S2S re-resolves on RECONNECT, and only then.** The OpenAI Realtime
 * transport sends `session.update` with the freshly resolved instructions when
 * a link is re-established (`openai-realtime-transport.ts`), and the AssemblyAI
 * Voice Agent API takes its instructions once at handshake. So on an S2S agent
 * a resolver is a per-CONNECTION prompt, not a per-turn one — it is honoured,
 * it is just coarser, and an agent that needs per-turn instructions is a
 * pipeline agent.
 */

import type { AgentSessionContext } from "./agent-session-context.ts";

/**
 * What `agent({ systemPrompt })` accepts: the text, or a function that answers
 * it per request from the live {@link AgentSessionContext}.
 *
 * The function is SYNCHRONOUS: the request is being built, and there is no
 * point at which a promise could be awaited without putting a round trip in
 * front of every turn. Work that needs awaiting belongs in a tool, whose result
 * the next request carries.
 *
 * A plain string is not called or wrapped; it reaches `buildSystemPrompt`
 * as written.
 *
 * ## With a `system-prompt.md`
 *
 * Almost every real agent keeps its prose in a file beside `agent.ts`, and a
 * resolver composes against that file by IMPORTING it — the same
 * `?raw` import the composed-string case takes, closed over by the function:
 *
 * ```ts no-check
 * import { agent } from "@alexkroman1/aai";
 * import prompt from "./system-prompt.md?raw";
 * import { gameSlot, statusBlock } from "./shared.ts";
 *
 * export default agent({
 *   name: "Cavern Adventure",
 *   systemPrompt: (ctx) => `${prompt}\n\n${statusBlock(gameSlot.get(ctx))}`,
 * });
 * ```
 *
 * The generated bundle entry still discovers the file and hands it to
 * `withSystemPrompt` (`sdk/system-prompt-file.ts`), which leaves a resolver
 * exactly as written — an author who declared a function has taken over
 * composing the prompt. That module's header owns the argument, including why
 * the file is not passed to the resolver as a second argument.
 *
 * @public
 */
export type AgentSystemPrompt = string | ((ctx: AgentSessionContext) => string);

/**
 * The static half of an {@link AgentSystemPrompt}, or `undefined` for a
 * resolver.
 *
 * The one place the narrowing is written down. A resolver cannot be serialized,
 * so `toAgentConfig` puts nothing on the wire for it and the runtime asks the
 * function instead — and a config layer that read `systemPrompt` as a string
 * without this would hand `buildSystemPrompt` a function and get the resolver's
 * SOURCE TEXT into the model's instructions, which neither the AI SDK nor
 * OpenAI Realtime rejects.
 *
 * **Takes the union, not `unknown`.** Every caller has an
 * `AgentDef["systemPrompt"]` in hand, and `unknown` accepted every other field
 * on the same object too — so a call site reaching for the wrong one compiled
 * and answered `undefined`, which is exactly the silent shape this pair exists
 * to prevent one level down. The runtime check is unchanged: a raw
 * `export default {...}` still crosses this boundary carrying anything at all,
 * and a `typeof` test is what handles it either way.
 *
 * @internal
 */
export function staticSystemPrompt(prompt: AgentSystemPrompt | undefined): string | undefined {
  return typeof prompt === "string" ? prompt : undefined;
}

/**
 * The resolver half, or `undefined` for a plain string.
 *
 * Narrowed for the reason above, and here it also retires this module's only
 * cast: with the union as the parameter, `typeof prompt === "function"` IS the
 * narrowing to the function half of {@link AgentSystemPrompt}.
 *
 * @internal
 */
export function systemPromptResolver(
  prompt: AgentSystemPrompt | undefined,
): Exclude<AgentSystemPrompt, string> | undefined {
  return typeof prompt === "function" ? prompt : undefined;
}

/**
 * What `agent({ promptContext })` accepts: text APPENDED under the agent's
 * own instructions, or a function that answers it per session.
 *
 * The field exists because a `system-prompt.md` is the right home for a
 * prompt and the wrong home for a value: an author with a file AND a line of
 * context to add ("Today's specials: …", "The caller's account tier") had to
 * import the file with `?raw` and compose a full {@link AgentSystemPrompt}
 * resolver — at which point `withSystemPrompt` could no longer check that the
 * file was read, and the file was declared twice. `promptContext` is the
 * sentence on its own: the file stays undeclared and discovered, the override
 * form of `systemPrompt` is reserved for an author taking over the whole
 * prompt, and the context lands under whichever of the two is in force,
 * separated by a blank line.
 *
 * A string is serialized into the agent's config like `systemPrompt` is, so a
 * listing or a build sees it; a function is resolved per session exactly as a
 * `systemPrompt` resolver is — synchronous, from the same
 * {@link AgentSessionContext}, re-asked per model request on the pipeline and
 * per connection on S2S.
 *
 * ```ts
 * import { agent, sessionSlot } from "@alexkroman1/aai";
 *
 * const caller = sessionSlot("caller", () => ({ tier: "standard" }));
 *
 * export default agent({
 *   name: "Concierge",
 *   // `system-prompt.md` beside this file stays the prompt; this is appended.
 *   promptContext: (ctx) => `The caller is on the ${caller.get(ctx).tier} tier.`,
 * });
 * ```
 *
 * @public
 */
export type AgentPromptContext = string | ((ctx: AgentSessionContext) => string);

/**
 * The field group `promptContext` is declared in — one field, its own
 * interface for the reason every group has one: `AgentDeclaration` extends
 * it, and the rule it carries (appended under the prompt, static half on the
 * wire, function half resolved per session) is this module's.
 *
 * @input
 * @public
 */
export interface AgentInstructions {
  /**
   * Context appended under the agent's instructions — the discovered
   * `system-prompt.md`, or a `systemPrompt` override — separated by a blank
   * line. See {@link AgentPromptContext} for the two forms and when each is
   * resolved. A workflow app refuses it: nothing there reads a prompt.
   */
  promptContext?: AgentPromptContext;
}

/**
 * The static half of an {@link AgentPromptContext}, or `undefined` for a
 * resolver — the narrowing `staticSystemPrompt` makes, for the same wire.
 *
 * @internal
 */
export function staticPromptContext(context: AgentPromptContext | undefined): string | undefined {
  return typeof context === "string" ? context : undefined;
}

/**
 * The resolver half of an {@link AgentPromptContext}, or `undefined` for a
 * plain string.
 *
 * @internal
 */
export function promptContextResolver(
  context: AgentPromptContext | undefined,
): Exclude<AgentPromptContext, string> | undefined {
  return typeof context === "function" ? context : undefined;
}

/**
 * The agent's instructions with its context appended under them — the ONE
 * spelling of "separated by a blank line", shared by `buildSystemPrompt` (the
 * static pair) and the runtime's per-session resolver (either half dynamic).
 * Blank text on either side contributes nothing, not even the separator, so
 * an agent with no context produces the byte-identical prompt it did before
 * the field existed; both blank answers `undefined`.
 *
 * @internal
 */
export function appendPromptContext(
  instructions: string | undefined,
  context: string | undefined,
): string | undefined {
  const own = instructions?.trim() === "" ? undefined : instructions;
  const extra = context?.trim() === "" ? undefined : context;
  if (own === undefined) return extra;
  if (extra === undefined) return own;
  return `${own}\n\n${extra}`;
}
