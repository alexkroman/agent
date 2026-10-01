// Copyright 2025 the AAI authors. MIT license.

import { normalizeAgentParams } from "./_author-conveniences.ts";
import { declaredPersonas } from "./_dialog-meta.ts";
import { assertNoStrayFields } from "./_stray-fields.ts";
import { KNOWN_AGENT_FIELDS } from "./agent-config.ts";
import { DEFAULT_GREETING } from "./agent-defaults.ts";
import type {
  AgentParams,
  DefaultedAgentField,
  ModeAgentDef,
  PipelineAgentParams,
  S2sAgentParams,
  StaticAgentParams,
  TextAgentParams,
} from "./agent-params.ts";
import { DEFAULT_MAX_STEPS } from "./constants.ts";
import { isRecord } from "./is-record.ts";
import { omitUndefined } from "./omit-undefined.ts";
import { bindPersonaDialogs, type Personas } from "./persona.ts";
import { personaTools } from "./persona-roster.ts";
import type { ToolInputSchema } from "./schema.ts";
import { DELEGATE_TOOL_NAME, rosterTool } from "./subagent-roster.ts";
import { type AgentDef, DEFAULT_SYSTEM_PROMPT, type ToolContext, type ToolDef } from "./types.ts";

/**
 * Define a tool with a typed input schema and execute function.
 *
 * Identity function for type inference — returns the input unchanged.
 * Follows the Vercel AI SDK `tool()` pattern (`inputSchema` names the same
 * field it does there). The schema is any Standard Schema that converts to
 * JSON Schema; Zod is the documented default.
 *
 * @example
 * ```ts
 * import { tool } from "@alexkroman1/aai";
 * import { z } from "zod";
 *
 * const greet = tool({
 *   description: "Greet someone by name",
 *   inputSchema: z.object({ name: z.string() }),
 *   execute: ({ name }) => `Hello, ${name}!`,
 * });
 * ```
 *
 * @example Reading and writing session state
 * ```ts
 * import { sessionSlot, tool } from "@alexkroman1/aai";
 * import { z } from "zod";
 *
 * const cartSlot = sessionSlot("cart", () => ({ items: [] as string[] }));
 *
 * const add = tool({
 *   description: "Add an item to the cart",
 *   inputSchema: z.object({ item: z.string() }),
 *   execute: ({ item }, ctx) =>
 *     cartSlot.update(ctx, (cart) => {
 *       cart.items.push(item);
 *       return cart.items.length;
 *     }),
 * });
 * ```
 *
 * @remarks
 * It takes no state type parameter, and neither does {@link ToolContext}. A
 * tool reaches session state through a {@link sessionSlot}, which types the
 * value in the module that declares it — so a tool in its own file needs
 * neither an annotated context nor a cast.
 *
 * @public
 */
export function tool<P extends ToolInputSchema = ToolInputSchema, R = unknown>(
  def: ToolDef<P, R>,
): ToolDef<P, R> {
  return def;
}

/**
 * Define an agent: its system prompt, its providers, and its configuration.
 *
 * Applies sensible defaults for omitted fields. Export as the default
 * export of your `agent.ts` file.
 *
 * Overloaded over {@link AgentMode}, one signature per member of
 * {@link AgentParams}: `mode` picks the member, and a field that member does
 * not have is a compile error naming it — `silence` is a pipeline group,
 * so it does not exist on {@link S2sAgentParams} at all. With no `mode` the
 * agent is a pipeline agent. {@link AgentDef} documents what every field means.
 *
 * **Tools are not declared here** — a tool is a FILE. `tools/echo.ts` that
 * default-exports `tool({ … })` is the tool `echo`, registered by existing, and
 * `agent({ tools })` is a compile error naming the file to create
 * (`InlineToolsMisuse`).
 *
 * @example
 * ```ts
 * import { agent } from "@alexkroman1/aai";
 *
 * export default agent({
 *   name: "Echo Agent",
 *   greeting: "Say something and I'll say it back.",
 * });
 * ```
 *
 * **Session state is not declared here either** — a {@link sessionSlot} owns its
 * own default and its own storage, so there is no `state` factory to remember.
 * `syncState` takes that slot's projection, keyed by the slot's name.
 *
 * @example Default pipeline with a voice and a different LLM
 * ```ts
 * import { agent } from "@alexkroman1/aai";
 *
 * export default agent({
 *   name: "My Agent",
 *   voice: "michael",
 *   llm: "claude-sonnet-4-6",
 * });
 * ```
 *
 * @public
 */
export function agent(def: PipelineAgentParams): ModeAgentDef<"pipeline">;
/**
 * Define a speech-to-speech agent: `mode: "s2s"` and its `s2s` descriptor. See
 * {@link S2sAgentParams}.
 *
 * @example
 * ```ts
 * import { agent, assemblyAIS2s } from "@alexkroman1/aai";
 *
 * export default agent({ name: "Concierge", mode: "s2s", s2s: assemblyAIS2s() });
 * ```
 *
 * @public
 */
export function agent(def: S2sAgentParams): ModeAgentDef<"s2s">;
/**
 * Define a text agent: `mode: "text"`, driven over a message list by
 * `createTextAgent` rather than by a session socket. See {@link TextAgentParams}.
 *
 * @example
 * ```ts
 * import { agent } from "@alexkroman1/aai";
 *
 * export default agent({
 *   name: "Docs Assistant",
 *   mode: "text",
 *   systemPrompt: "Answer questions about the docs.",
 * });
 * ```
 *
 * @public
 */
export function agent(def: TextAgentParams): ModeAgentDef<"text">;
/**
 * Define a workflow app: `mode: "workflow-app"`. {@link workflowApp} is the
 * same member with the mode already set. See {@link StaticAgentParams}.
 *
 * @public
 */
export function agent(def: StaticAgentParams): ModeAgentDef<"workflow-app">;
/**
 * Any member of {@link AgentParams} — the signature a value typed as the whole
 * union resolves against (an options bag assembled elsewhere, a wrapper that
 * forwards its argument).
 *
 * @public
 */
export function agent(def: AgentParams): AgentDef;
export function agent(def: AgentParams): AgentDef {
  return buildAgent(def);
}

/**
 * The shared body of {@link agent} and {@link workflowApp}.
 */
function buildAgent(def: object): AgentDef {
  assertNoInlineTools(def);
  // Mode, field legality, the mode mirrors and the conveniences — in that
  // order; see `_author-conveniences.ts`.
  const normalized = normalizeAgentParams(def) as Record<string, unknown>;
  // The same net `toAgentConfig` holds, one layer earlier. `agent()` is where
  // an author is standing, so a field the SDK does not know should fail here
  // rather than at `aai build` — and a raw `export default {...}` that skips
  // this function still meets the check at the config boundary.
  assertNoStrayFields(normalized, KNOWN_AGENT_FIELDS);
  /**
   * `omitUndefined` because a spread lets an own key whose value is
   * `undefined` WIN over the default beneath it — `agent({ name, ...opts })`
   * with `opts` declared `{ greeting?: string }` returned an agent whose
   * required `greeting`, `systemPrompt` and `maxSteps` were `undefined`.
   * Making absent and present-and-undefined mean the same thing is what those
   * fields' docs ("Defaults to …") already promise.
   */
  const params = omitUndefined(normalized as AgentParamsCore) as AgentParamsCore;
  assertNoOrphanPins(params);
  // The one table `agent()` fills itself: `tools` is the field it refuses an
  // argument for, so there is nothing in `params` to overwrite. A declared
  // roster becomes an ordinary entry here — see `sdk/subagent-roster.ts` — so it
  // is schema'd, dispatched and executed by the same paths a `tools/` file
  // takes. A roster of PERSONAS lowers the same way — every persona's gated
  // tools plus the minted `handoff` — see `sdk/persona-roster.ts`.
  const tools: Record<string, ToolDef> = {};
  if (params.subagents) tools[DELEGATE_TOOL_NAME] = rosterTool(params.subagents);
  if (params.personas) {
    Object.assign(tools, personaTools(bindPersonas(params.personas, params.dialogs)));
  }
  return {
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    greeting: DEFAULT_GREETING,
    maxSteps: DEFAULT_MAX_STEPS,
    ...params,
    // AFTER the spread, and it is the one thing that may be — see above.
    tools,
  };
}

/**
 * Bind the dialogs to the roster, and check every `persona` a dialog state pins
 * is one the roster carries — at the declaration, where an author is standing,
 * rather than on the first turn the dialog reaches that state.
 *
 * The roster is built at module scope, before `agent()` runs, so this is the
 * first moment the two can be compared; `bindPersonaDialogs` is what lets a
 * pin be read back through `Personas.position` afterwards.
 */
function bindPersonas(roster: Personas, dialogs: AgentDef["dialogs"]): Personas {
  const known = new Set(roster.list.map((one) => one.name));
  for (const dialog of dialogs ?? []) {
    for (const name of declaredPersonas(dialog.machine)) {
      if (known.has(name)) continue;
      throw new Error(
        `The "${dialog.key}" dialog pins a persona called "${name}" that is not on this agent's roster. Declared: ${[...known].join(", ")}.`,
      );
    }
  }
  bindPersonaDialogs(roster, dialogs ?? []);
  return roster;
}

/**
 * A dialog state that pins a persona on an agent with NO roster is a setting
 * that silently does nothing — refused for the same reason a stray field is.
 */
function assertNoOrphanPins(params: { personas?: Personas; dialogs?: AgentDef["dialogs"] }): void {
  if (params.personas) return;
  for (const dialog of params.dialogs ?? []) {
    const pinned = [...declaredPersonas(dialog.machine)];
    if (pinned.length === 0) continue;
    throw new Error(
      `The "${dialog.key}" dialog pins the persona "${pinned[0]}", but this agent declares no \`personas\`. Declare the roster, or drop the \`persona\` field from that state.`,
    );
  }
}

/**
 * Refuse a `tools` key at RUN TIME as well as in the type.
 *
 * {@link InlineToolsMisuse} is the compile error, and on its own it leaves the
 * rule conventional: neither bundler type-checks user code, so a `tools` map
 * that reached here would work — and "a tool is only ever a file" would be true
 * of the templates and of nothing else. It is also exactly the shape an options
 * bag reaches `agent()` in, where the excess-property check does not fire.
 *
 * Thrown rather than dropped, on the rule this whole mechanism exists for: the
 * failure being replaced was a tool that silently never reached the model, and
 * silently ignoring a declared one is that failure with a new cause.
 */
function assertNoInlineTools(def: unknown): void {
  if (!(isRecord(def) && "tools" in def)) return;
  throw new Error(
    "agent({ tools }) is not how a tool is declared: a tool IS a file. Move each entry to " +
      "tools/<the name the model calls>.ts as `export default tool({ … })` — the build enumerates " +
      "that directory, so nothing lists them anywhere. In a spec, reach the same set with " +
      '`import agentDef from "virtual:aai/agent"` under vitest, or `deployedAgent` from ' +
      "@alexkroman1/aai/testing under any other runner.",
  );
}

/**
 * Define a WORKFLOW APP — an agent whose front door is a form rather than a
 * microphone, and whose work happens in `workflows`.
 *
 * `agent({ mode: "workflow-app", … })` with the discriminant already set, so
 * the mode is the CALL rather than a field to remember, and the fields a
 * workflow app has no use for are absent from the parameter type. Returns the
 * same {@link AgentDef} `agent()` does — there is one definition type, one
 * config, one deploy path.
 *
 * It mirrors the split `@alexkroman1/aai-ui` already makes in the browser:
 * `mountPage()` mounts a workflow app's UI and `mountClient()` mounts a voice
 * one.
 *
 * @example
 * ```ts
 * import { workflow, workflowApp } from "@alexkroman1/aai";
 * import { z } from "zod";
 *
 * export const digest = workflow({
 *   description: "Summarize a link",
 *   input: z.object({ url: z.url() }),
 *   run: async ({ url }) => ({ url }),
 * });
 *
 * export default workflowApp({
 *   name: "Link Digest",
 *   workflows: { digest },
 * });
 * ```
 *
 * @public
 */
export function workflowApp(def: Omit<StaticAgentParams, "mode">): AgentDef {
  return buildAgent({ ...def, mode: "workflow-app" });
}

/**
 * `AgentParams` with the author-only conveniences normalized away — what
 * {@link normalizeAgentParams} returns and `agent()` spreads over the
 * defaults.
 */
type AgentParamsCore = Omit<AgentDef, DefaultedAgentField> &
  Partial<Pick<AgentDef, DefaultedAgentField>>;

/**
 * The parameter shape lives in its own module (see its header); the members
 * and their union are re-exported here so `agent()` and its params stay one
 * import for an author. The FIELD-LIST types behind them are deliberately not —
 * they are how a member is cut, not something an `agent.ts` names.
 */
export type {
  AgentParams,
  ModeAgentDef,
  PipelineAgentParams,
  S2sAgentParams,
  SharedAgentParams,
  StaticAgentParams,
  TextAgentParams,
} from "./agent-params.ts";
