// Copyright 2025 the AAI authors. MIT license.

import type { AnyStateMachine } from "xstate";
import { normalizeAgentParams } from "./_author-conveniences.ts";
import { declaredPersonas } from "./_dialog-meta.ts";
import { assertNoStrayFields } from "./_stray-fields.ts";
import { KNOWN_AGENT_FIELDS } from "./agent-config.ts";
import { DEFAULT_GREETING } from "./agent-defaults.ts";
import type { AgentMode } from "./agent-mode.ts";
import type {
  AgentParams,
  DefaultedAgentField,
  ModeAgentDef,
  PipelineAgentParams,
  S2sAgentParams,
  TextAgentParams,
  WorkflowAppAgentParams,
} from "./agent-params.ts";
import { ASSEMBLYAI_API_KEY_ENV, DEFAULT_MAX_STEPS } from "./constants.ts";
import { isRecord } from "./is-record.ts";
import { omitUndefined } from "./omit-undefined.ts";
import { bindRosterDialogs, type Roster } from "./roster.ts";
import { rosterToolset } from "./roster-tools.ts";
import type { ToolInputSchema } from "./schema.ts";
import type { ResolvedAgentDef } from "./toolset.ts";
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
export function tool<P extends ToolInputSchema | undefined = ToolInputSchema, R = unknown>(
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
 * agent is a pipeline agent. {@link AgentDeclaration} documents what every
 * field means; the returned {@link AgentDef} is the resolved shape.
 *
 * **The `workflows` map is kept as DECLARED on the result** (its literal keys
 * and each def's own type — {@link AgentDefWith}), so a page can name a
 * workflow through the agent: `useWorkflowSubmit<typeof agentDef>("digest")`
 * types the name as the keys the agent declares and the output as that body's.
 * A def without `workflows` is the plain {@link ModeAgentDef}.
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
 * `syncState` takes that slot's projection, or a list of them — or nothing,
 * when the slots were declared `sync: true`: those are collected here by
 * default, and an explicit `syncState` replaces them.
 *
 * @example Default pipeline with another voice and a different LLM
 * ```ts
 * import { agent } from "@alexkroman1/aai";
 * import { assemblyAITts } from "@alexkroman1/aai/tts";
 *
 * export default agent({
 *   name: "My Agent",
 *   tts: assemblyAITts({ voice: "aai-michael" }),
 *   llm: "claude-sonnet-4-6",
 * });
 * ```
 *
 * @public
 */
export function agent<W extends WorkflowsMap = WorkflowsMap>(
  def: PipelineAgentParams & WithWorkflows<W>,
): AgentDefWith<"pipeline", W>;
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
export function agent<W extends WorkflowsMap = WorkflowsMap>(
  def: S2sAgentParams & WithWorkflows<W>,
): AgentDefWith<"s2s", W>;
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
export function agent<W extends WorkflowsMap = WorkflowsMap>(
  def: TextAgentParams & WithWorkflows<W>,
): AgentDefWith<"text", W>;
/**
 * Define a workflow app: `mode: "workflow-app"`. {@link workflowApp} is the
 * same member with the mode already set. See {@link WorkflowAppAgentParams}.
 *
 * @public
 */
export function agent<W extends WorkflowsMap = WorkflowsMap>(
  def: Omit<WorkflowAppAgentParams, "workflows"> & { workflows: W },
): AgentDefWith<"workflow-app", W>;
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
 * The workflows an agent may declare — `AgentDef["workflows"]` without the
 * `undefined`. The constraint every `W` is inferred under.
 *
 * @public
 */
export type WorkflowsMap = NonNullable<AgentDef["workflows"]>;

/**
 * The `workflows` an {@link agent} overload infers `W` from — optional, as the
 * declaration's is, and typed open so a literal map's keys and def types are
 * what `W` becomes.
 */
type WithWorkflows<W extends WorkflowsMap> = { workflows?: W };

/**
 * What `agent()` and `workflowApp()` return for a declaration in mode `M`
 * whose `workflows` map is `W`: {@link ModeAgentDef}, carrying `W` as declared
 * — its literal keys and each def's own type — when one was declared, and
 * nothing more when none was (`W` is then its constraint, the open map).
 *
 * The one place the declared map survives the lowering: `AgentDef` types
 * `workflows` as the open `Record<string, WorkflowDef>`, which is right for
 * every reader of a definition and wrong for a page naming one of its
 * workflows by key — `useWorkflowSubmit<typeof agentDef>("digets")` typed the
 * name `string` and the output `unknown`, so the app-typed hooks were
 * unreachable from a template.
 *
 * @sealed
 * @public
 */
export type AgentDefWith<M extends AgentMode, W extends WorkflowsMap> = string extends keyof W
  ? ModeAgentDef<M>
  : // `Omit` first: intersecting `W` onto the open map would leave `keyof`
    // reading `string | keyof W`, which is `string` — the widening this exists
    // to undo.
    Omit<ModeAgentDef<M>, "workflows"> & { readonly workflows: W };

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
  checkPins(params.roster, params.dialogs);
  // The two tables `agent()` fills itself, and neither is a parameter: `tools`
  // is filled by `withTools` from `tools/`, and a declared roster lowers into a
  // TOOLSET (`sdk/roster-tools.ts`) — schema'd, gated and executed by the same
  // paths a `tools/` file takes, on all three transports. The sandbox path needs
  // nothing: the guest holds the real definition, the only side that can hold a
  // `SpeakerDef`'s functions anyway.
  // Binding the dialogs is what lets a pin be read back through
  // `Roster.position` afterwards.
  if (params.roster) bindRosterDialogs(params.roster, params.dialogs ?? []);
  const toolsets = params.roster ? [rosterToolset(params.roster)] : [];
  const resolved: ResolvedAgentDef = {
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    greeting: DEFAULT_GREETING,
    maxSteps: DEFAULT_MAX_STEPS,
    ...params,
    // AFTER the spread, and they are the only things that may be — see above.
    tools: {},
    toolsets,
  };
  return resolved;
}

/**
 * Check every `persona` a dialog state pins against the roster — at the
 * declaration, where an author is standing, rather than on the first turn the
 * dialog reaches that state. A pin must name a SPEAKING entry, and a pin on an
 * agent with NO roster is a setting that silently does nothing — refused for
 * the same reason a stray field is.
 *
 * The roster is built at module scope, before `agent()` runs, so this is the
 * first moment the two can be compared.
 */
function checkPins(roster: Roster | undefined, dialogs: AgentDef["dialogs"]): void {
  const known = roster && new Set(roster.speaking.map((one) => one.name));
  for (const dialog of dialogs ?? []) {
    // Every `DialogMachine` is an XState machine (see its doc), which carries `states`.
    for (const name of declaredPersonas(dialog.machine as AnyStateMachine)) {
      if (known === undefined) {
        throw new Error(
          `The "${dialog.key}" dialog pins the speaker "${name}", but this agent declares no \`roster\`. Declare the roster, or drop the \`persona\` field from that state.`,
        );
      }
      if (known.has(name)) continue;
      throw new Error(
        `The "${dialog.key}" dialog pins a speaker called "${name}" that is not a speaking entry of this agent's roster. Speaking: ${[...known].join(", ") || "(none)"}.`,
      );
    }
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
 * `requiredEnv` defaults to {@link WORKFLOW_APP_REQUIRED_ENV} — the AssemblyAI
 * key every shipped workflow app reads; `requiredEnv: []` opts out. The
 * `workflows` map comes back AS DECLARED ({@link AgentDefWith}), which is what
 * lets a page write `useWorkflowSubmit<typeof app>("digest")`.
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
export function workflowApp<W extends WorkflowsMap>(
  def: Omit<WorkflowAppAgentParams, "mode" | "workflows"> & { workflows: W },
): AgentDefWith<"workflow-app", W> {
  // A destructuring default rather than a spread beneath `def`, so an explicit
  // `requiredEnv: undefined` takes the default too — the same rule `buildAgent`
  // applies to the other defaulted fields through `omitUndefined`.
  const { requiredEnv = WORKFLOW_APP_REQUIRED_ENV, ...rest } = def;
  // `buildAgent` answers the open `AgentDef`; the map it was handed is `W`.
  return buildAgent({ ...rest, requiredEnv, mode: "workflow-app" }) as AgentDefWith<
    "workflow-app",
    W
  >;
}

/**
 * What {@link workflowApp} declares as `requiredEnv` when the app names none:
 * the AssemblyAI key, `["ASSEMBLYAI_API_KEY"]`.
 *
 * A workflow app declares no providers, so nothing else in its config names a
 * credential — and every shipped workflow app transcribes, generates or speaks
 * through that one key (`stepTranscribe*`, `stepGenerate`, `stepSpeak` all read
 * it by default). A voice `agent()` keeps no such default: its providers already
 * declare theirs, and `requiredEnv` there is for what the TOOLS need. An app
 * that genuinely needs no key — one whose steps only fetch — opts out with
 * `requiredEnv: []`, and one that names its own list replaces this rather than
 * extending it.
 *
 * @public
 */
export const WORKFLOW_APP_REQUIRED_ENV: readonly string[] = [ASSEMBLYAI_API_KEY_ENV];

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
  TextAgentParams,
  WorkflowAppAgentParams,
} from "./agent-params.ts";
