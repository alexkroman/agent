// Copyright 2025 the AAI authors. MIT license.
/**
 * The AAI voice-agent SDK — the AUTHORING surface, and only that.
 *
 * ## What you import from here
 *
 * | Declaring | Use |
 * | --- | --- |
 * | the agent | {@link agent} — one object; {@link AgentDef} documents every field and default, {@link AgentParams} which combinations are legal |
 * | a tool | {@link tool} — but a tool is a FILE: `tools/<name>.ts` default-exporting one IS the tool `<name>`, and `agent({ tools })` is a compile error |
 * | session state | {@link sessionSlot} — a typed named slot; `slot.tool()` reads it, `slot.updateTool()` writes it, `slot.projection()` shows it to the browser |
 * | conversation order | {@link dialog} — a tool declared `when` simply does not run outside those states |
 * | work that outlives the call | {@link workflow} — journaled, resumable; {@link workflowApp} for an agent whose front door is a form |
 * | a second tool loop | {@link subagent}, reached with `ctx.delegate` |
 * | the default pipeline, spelled out | {@link assemblyAIPipeline}; {@link assemblyAIS2s} opts into speech-to-speech instead |
 *
 * ```ts
 * import { agent, sessionSlot } from "@alexkroman1/aai";
 *
 * export const cart = sessionSlot("cart", () => ({ items: [] as string[] }));
 *
 * export default agent({
 *   name: "Storefront",
 *   systemPrompt: "You help callers order from the catalog.",
 *   voice: "michael",
 *   syncState: cart.projection((c) => ({ count: c.items.length })),
 * });
 * ```
 *
 * With no provider fields that runs the all-AssemblyAI STT → LLM → TTS
 * pipeline on one `ASSEMBLYAI_API_KEY`. Set any subset of `stt`, `llm`, `tts`
 * to swap a stage; the rest keep the default.
 *
 * **Three primitives here run a defined process, and they are not
 * interchangeable.** A {@link dialog} gates a CONVERSATION — what the agent may
 * say or do next, across turns. A {@link procedure} runs ONE UNIT OF WORK inside
 * a single tool call. A {@link workflow} runs DURABLY, outliving the session.
 *
 * ## Everything else is on a subpath, chosen by WHO READS IT
 *
 * | Subpath | Reach for it when |
 * | --- | --- |
 * | `@alexkroman1/aai/testing`, `/testing/vitest` | testing your own tools — `createToolContext`, `deployedAgent`, `runTool` |
 * | `@alexkroman1/aai/stt`, `/llm`, `/tts`, `/s2s` | picking a provider for a pipeline stage |
 * | `@alexkroman1/aai/step`, `/step-errors` | writing a step inside a workflow |
 * | `@alexkroman1/aai/workflow-api` | calling a deployed agent from a page, a script or a cron job |
 * | `@alexkroman1/aai/tools` | calling `fetchJson`/`webSearch`/`visitWebpage` from your own tool code |
 * | `@alexkroman1/aai/utils` | small helpers written inside a tool body |
 * | `@alexkroman1/aai/ffmpeg` | running ffmpeg from a step |
 * | `@alexkroman1/aai-runtime` | self-hosting the Node runtime |
 * | `@alexkroman1/aai/protocol`, `/manifest`, `/internal` | framework internals; not covered by semver |
 *
 * A `workflows/*.ts` body is the one file that reads from two of these: the
 * declaration and its `…Of<typeof def>` readings are here, the step vocabulary
 * is `/step`.
 *
 * @module
 */

// biome-ignore-all lint/performance/noReExportAll: barrel file by design

// By NAME: that module also declares `MAX_DB_RESULT_ROWS` and
// `STORAGE_DISABLED_MESSAGE`, two framework budgets on `@alexkroman1/aai/internal`
// — a tool body reads `ctx.db`, never the cap the driver enforces around it.
// `agent()` / `tool()` and the three-arm `AgentParams` union behind them.
export * from "./sdk/define.ts";
/**
 * The dialog statechart — next to `agent()`/`tool()` because it is how a guided
 * agent declares what it may do NEXT, which is authoring rather than an
 * optional utility. Its machine comes from `xstate`, which an author imports
 * directly; nothing here re-exports it.
 */
export * from "./sdk/dialog.ts";
export * from "./sdk/generate.ts";
/**
 * The other machine: one unit of WORK inside a tool call, where a flow is where
 * a CONVERSATION is. On the root beside it because an author reaching for one
 * needs to see the other to pick correctly.
 */
export * from "./sdk/procedure.ts";
// The one preset that belongs next to `agent()` rather than behind a provider
// subpath: it IS the recommended configuration, and requiring three more
// imports to reach it is what made the wrong mode the easy one.
export * from "./sdk/providers/assemblyai-pipeline.ts";
/**
 * S2S is opt-in now that the pipeline is the default mode, so the opt-in
 * descriptor lives next to `agent()` too.
 *
 * By NAME rather than `export *`: that module also exports
 * `ASSEMBLYAI_S2S_KIND` and `ASSEMBLYAI_S2S_API_KEY_ENV`, which an `agent.ts`
 * never writes — the descriptor sets the kind, and credentials resolve
 * server-side. Those two, and the seventeen `*_KIND`/`*_API_KEY_ENV` constants
 * of the other provider modules, are on `@alexkroman1/aai/host-internal` with
 * the `resolve*Settings` helpers that read them.
 */
export { type AssemblyAIS2sOptions, assemblyAIS2s } from "./sdk/providers/s2s/assemblyai.ts";
/**
 * The voice catalog and the type `agent({ voice })` is written against.
 *
 * Both were FORGOTTEN exports here — `AgentParams.voice` is typed
 * `AssemblyAITtsVoice`, and the catalog is the only place the ids are
 * checkable — so an author reaching for the field this barrel documents had to
 * import from `@alexkroman1/aai/tts` to name either. The TTS subpath keeps
 * them too: it is where an explicit `assemblyAITts({ voice })` stage is
 * written.
 */
export {
  ASSEMBLYAI_TTS_VOICES,
  type AssemblyAITtsVoice,
} from "./sdk/providers/tts/assemblyai.ts";
/**
 * The four stage descriptor types and the base they narrow.
 *
 * `AgentDef` names all four in its own signature, so an author annotating a
 * stage — a helper that builds one, a config assembled across files — had to
 * import them from up to four provider subpaths to write down a type this
 * barrel already publishes the consumer of. They were FORGOTTEN exports here:
 * declared in the rollup because `AgentDef` references them, exported by
 * nothing, so the shipped authoring guide's own `agent()` signature block
 * named types no import path on this page could supply.
 *
 * The four stage types stay on their own subpaths too — that is where the
 * factory producing one lives — so each still BELONGS to its stage capability
 * under the rule that a name published on both `.` and a narrower subpath is
 * the narrower one's. `ProviderDescriptor` is the exception and left them: one
 * interface had four reference pages, and the base all four narrow spans every
 * stage, so the root is the narrowest thing that can own it.
 *
 * `ProviderCredentialOptions` is here for the same reason. Every provider
 * options interface on all four stages extends it, so no one stage owns it,
 * and the root is again the narrowest place it fits.
 */
export type {
  LlmProvider,
  ProviderCredentialOptions,
  ProviderDescriptor,
  S2sProvider,
  SttProvider,
  TtsProvider,
} from "./sdk/providers.ts";
/**
 * DECLARING a workflow, and the three types a DECLARATION is read back through.
 *
 * `workflow()` is on the root barrel because declaring one sits beside declaring
 * a tool: an author writes both in `agent.ts`. Everything about the RUN it
 * starts — the option bags, the snapshot union, its guard, the wait cap — is on
 * `@alexkroman1/aai/workflow-api`, whose reader is a page, a script, or a tool
 * annotating a result, and the barrel's membership test is exactly that.
 *
 * `WorkflowClient` stays because `ToolContext.workflows` names it.
 *
 * **{@link WorkflowInputOf} and {@link WorkflowRunOf} are on BOTH, and the root
 * is where an author meets them.** They were on `/workflow-api` alone, on the
 * reading that a body names the input, a page names the output, and neither is
 * `agent.ts`. The second half is right and the first is not: the membership
 * test is "would an `agent.ts`, a TOOL MODULE, or a `workflow()` name it", and
 * both of those clauses hit here. A body in `workflows/` is what `workflow()`
 * declares — the three shipped templates that have one (`call-audit`,
 * `podcast-digest`, `spoken-summary`) each annotate its parameter with
 * `WorkflowInputOf`, which is the ONE annotation that is not optional (see that
 * type's doc: a hand-written parameter is contravariant, so a body disagreeing
 * with its own schema compiles). `WorkflowRunOf` is what a `*_status` TOOL
 * holds, in two more. So an author reaching for the type the compiler is asking
 * them for had to find a subpath documented as the surface for a caller OUTSIDE
 * the agent.
 *
 * **`WorkflowOutputOf` deliberately did NOT come with them.** It is the third
 * of the same family and the temptation is to move all three together, but its
 * reader really is a page: it is what `useWorkflowRun<…>` is parameterized by,
 * and the two templates that name it are both a `client.tsx`. The template API
 * ratchet is what settled it — no author-side example exercises it, and an
 * export no example exercises is either missing its example or should not be
 * public here. A `*_status` tool does not need it either, because
 * `WorkflowRunOf` already composes it in.
 *
 * Both names stay on `/workflow-api` too — that is still where a page imports
 * them — and `workflow-api` still OWNS the capability, by the rule that a name
 * on both `.` and a narrower subpath belongs to the narrower one.
 *
 * What a BODY is written against joins it, because that is authoring too:
 * {@link WorkflowContext} (an author annotates a body's second parameter with it),
 * the three option bags its methods take, and {@link DEFAULT_STEP_MAX_ATTEMPTS}.
 * Those replaced the Workflow DevKit's `"use step"` /
 * `"use workflow"` directives and its `sleep`/`defineHook` imports — the engine
 * lives in this repo now, so the durability an author reaches for is a method on
 * `ctx` rather than a package this SDK had to track the surface of.
 */
/**
 * Reading a credential off `ctx.env`.
 *
 * On the root barrel rather than `/utils` because it takes a `ToolContext` and
 * is written inside a tool body, which is the root's own membership test — and
 * because the failure it exists to prevent (a `TypeError` on an undeclared
 * variable, serialized to the model, apologised for out loud) is one an author
 * should not have to find a subpath to avoid.
 */
export { requireEnv } from "./sdk/require-env.ts";
/**
 * Standard Schema acceptance — the two an author names.
 *
 * `StandardSchemaV1` and its result/issue types are the ecosystem SPEC that
 * `tool()` happens to accept, not something an agent declares; they stay in
 * `sdk/schema.ts` for the signatures that reference them.
 */
export type { InferSchemaOutput, ToolInputSchema } from "./sdk/schema.ts";
/**
 * The types an `agent({ events })` handler is written against.
 *
 * On the root by the barrel's own membership test — an `agent.ts` NAMES these the
 * moment a handler is extracted from the literal into a function of its own, which
 * is the first thing an author does once one grows past a line. `SessionEvent`
 * itself is not here: it is the wire union and lives on
 * `@alexkroman1/aai/protocol`, so a handler that needs to name one imports it
 * there, exactly as a client does.
 */
export type {
  SessionEventContext,
  SessionEventHandler,
  SessionEventHandlers,
  SessionEventType,
} from "./sdk/session-events.ts";
// Session state's typed seam — next to `agent()`/`tool()` because it is how a
// multi-file agent reads and writes its own state, not an optional utility.
export * from "./sdk/session-slot.ts";
/**
 * The two names a slot's own signatures mention, and only those.
 *
 * By NAME rather than `export *`: that module also holds the storability check
 * and the detached store, which are `@internal` — and an `@internal` name on a
 * public subpath is what `check:api-contracts` refuses, correctly, since it would
 * sit in an author's autocomplete beside `sessionSlot`.
 */
export type { SlotHolder, SlotStore, StateProjection } from "./sdk/session-state.ts";
// Resolving what a caller SAID to one of the things a tool holds — the
// never-guess contract, on the root barrel because it is written in a tool body
// beside `toolFailure`, which it returns.
export * from "./sdk/spoken.ts";
/**
 * `subagent()` and the `ctx.delegate` contract — the third machine, and the one
 * that spends a MODEL rather than a turn: a second tool loop with its own
 * context window, whose intermediate steps the caller never carries. Picking
 * between it and `generate` — one prompt, or a loop — is the whole decision.
 */
export * from "./sdk/subagent.ts";
export * from "./sdk/types.ts";
/**
 * The utilities written INSIDE a tool body — all fifteen of them, which is
 * `@alexkroman1/aai/utils` minus the five whose reader is not a tool body:
 * `decodeHtmlEntities` and the four narration formatters (`formatBytes`,
 * `formatDuration`, `countWords`, `plural`), which a step and a `client.tsx`
 * both reach for and which are therefore reachable ONLY on that subpath.
 *
 * **The rule is that the two lists agree for everything else**, because the
 * split they used to describe was not one anybody could apply: `safeJsonParse` was here and
 * `isRecord` — the guard you call on what it returns — was not, so a tool body
 * needing both wrote two import lines for one line of helpers, and templates
 * routed around it by taking the root's own names off `/utils` instead. That
 * subpath's membership is a BUILD property (zero-zod, so the CLI can import it
 * on every invocation), which is a fact about its graph rather than a statement
 * about who reads it; nothing on it fails this barrel's own membership test.
 *
 * The narrower subpath stays, because it is what the CLI and the platform
 * import — and because a tool body reaching for one helper should not have to
 * name the root. Neither the slug contract nor the framework's wire helpers are
 * involved either way: those left `sdk/utils.ts` for `@alexkroman1/aai/internal`.
 */
export {
  createKeyedLock,
  errorDetail,
  errorMessage,
  isRecord,
  isToolFailure,
  type KeyedLock,
  type KeyedLockOptions,
  KeyedLockTimeoutError,
  omitUndefined,
  pushCapped,
  responseErrorMessage,
  safeJsonParse,
  type ToolFailure,
  toolFailure,
  withLock,
} from "./sdk/utils.ts";
export {
  DEFAULT_STEP_MAX_ATTEMPTS,
  // There is deliberately no `isWorkflowSuspend` here any more. A body's `catch`
  // used to have to test it and re-throw, which is advice — and one shipped
  // template forgot, deleted the transcript its run was waiting for, and
  // journaled the deletion as successful. A wait now hands back a promise that
  // never settles, so a suspension cannot reach a `catch` at all and there is
  // nothing left for an author to remember. See
  // `aai-runtime/workflow-replay-suspend.ts`.
  type SleepOptions,
  type StepOptions,
  // The schema-bearing halves of the two option bags above. A type a public
  // signature names must be reachable from the barrel that publishes it, and
  // `ctx.step`/`ctx.waitFor` each take one in their validating overload.
  type StepSchemaOptions,
  type WaitForOptions,
  type WaitForSchemaOptions,
  type WorkflowClient,
  // What a workflow BODY is handed. An author annotates a body's second
  // parameter with it, which is the membership test this barrel applies.
  type WorkflowContext,
  type WorkflowDef,
  // Two of the three `…Of<typeof def>` readings of a declaration — see above.
  // Also on `/workflow-api`, which owns the capability; these are the copies a
  // `workflows/*.ts` body and a `*_status` tool reach for. `WorkflowOutputOf`
  // is the one that stayed there, its reader being a `client.tsx`.
  type WorkflowInputOf,
  type WorkflowRunOf,
  workflow,
} from "./sdk/workflow.ts";
