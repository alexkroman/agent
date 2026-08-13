// Copyright 2025 the AAI authors. MIT license.
import { expectTypeOf, test } from "vitest";
import { z } from "zod";
import { type AgentParams, agent, tool, type workflowApp } from "./define.ts";
import type { LlmProvider, S2sProvider, SttProvider, TtsProvider } from "./providers.ts";
import type { AgentDef, DefaultSessionState, ToolContext, ToolDef } from "./types.ts";

/**
 * Every `AgentDef` field must be declarable through `agent()`.
 *
 * `AgentParams` is now *derived* from `AgentDef` (Omit + Partial<Pick>), so
 * this holds by construction — the test stays as a regression lock against
 * anyone reintroducing an inline re-declaration, which is how `state` once
 * shipped as a runtime-working but excess-property-error field (the CLI and
 * studio bundlers don't typecheck user code, so nothing caught it).
 */
test("agent() accepts every AgentDef field", () => {
  type MissingFromParam = Exclude<keyof AgentDef, keyof Parameters<typeof agent>[0]>;
  expectTypeOf<MissingFromParam>().toEqualTypeOf<never>();
});

test("agent() infers the state shape from the state factory", () => {
  const def = agent({
    name: "t",
    state: () => ({ count: 0 }),
  });
  // Inferred, not widened to Record<string, unknown> — this is what makes
  // `ctx.state.count` a number in tools rather than `unknown`.
  expectTypeOf(def.state).toEqualTypeOf<(() => { count: number }) | undefined>();
});

test("agent() without a state factory falls back to the permissive default", () => {
  // `any`, so the ordinary unannotated `ctx.state.foo` compiles rather than
  // failing the build gate on correct code. See DefaultSessionState.
  const def = agent({ name: "t" });
  expectTypeOf(def.state).toEqualTypeOf<(() => DefaultSessionState) | undefined>();
});

test("an unannotated tool can read state without a type error", () => {
  // The regression this whole change exists for: `ctx.state.cart` used to be
  // `unknown`, which failed `aai build`'s typecheck on a working agent.
  const add = tool({
    description: "add",
    inputSchema: z.object({ item: z.string() }),
    execute: ({ item }, ctx) => {
      expectTypeOf(ctx.state).toEqualTypeOf<DefaultSessionState>();
      ctx.state.cart.push(item); // the exact line that used to be TS18046
      return ctx.state.cart.length;
    },
  });
  expectTypeOf(add.description).toEqualTypeOf<string>();
});

test("tool() types ctx.state from an annotated context", () => {
  type Cart = { items: string[] };
  const add = tool({
    description: "add",
    inputSchema: z.object({ item: z.string() }),
    execute: ({ item }, ctx: ToolContext<Cart>) => {
      expectTypeOf(ctx.state).toEqualTypeOf<Cart>();
      expectTypeOf(item).toEqualTypeOf<string>();
      return ctx.state.items.length;
    },
  });
  expectTypeOf(add).toMatchObjectType<ToolDef<z.ZodObject<{ item: z.ZodString }>, Cart>>();
});

test("a tool expecting a different state shape is not an accepted tool", () => {
  // Asserted as non-assignability rather than as a suppressed type error, so
  // the escape-hatch ratchet stays at its baseline.
  type Cart = { items: string[] };
  type Slot = ToolDef<z.ZodObject<z.ZodRawShape>, Cart>;
  type Mismatched = ToolDef<z.ZodObject<z.ZodRawShape>, { totallyDifferent: number }>;
  expectTypeOf<Mismatched>().not.toExtend<Slot>();
  // ...while a tool that ignores state entirely still fits.
  expectTypeOf<ToolDef<z.ZodObject<z.ZodRawShape>>>().toExtend<Slot>();
});

test("an unannotated tool still composes into a stateful agent", () => {
  // `execute` is declared method-style (bivariant), so a tool written without
  // the state type is not a hard error inside a typed agent — it just sees
  // untyped state. Locking this keeps the generic from becoming viral.
  type Cart = { items: string[] };
  const ping = tool({ description: "p", execute: () => "pong" });
  const def = agent({
    name: "t",
    state: (): Cart => ({ items: [] }),
    tools: { ping },
  });
  expectTypeOf(def.state).toEqualTypeOf<(() => Cart) | undefined>();
});

test("agent() accepts stt/llm/tts optional fields", () => {
  const stt = {} as SttProvider;
  const llm = {} as LlmProvider;
  const tts = {} as TtsProvider;
  const def = agent({ name: "t", systemPrompt: "p", stt, llm, tts });
  expectTypeOf(def.stt).toEqualTypeOf<SttProvider | undefined>();
  expectTypeOf(def.llm).toEqualTypeOf<LlmProvider | undefined>();
  expectTypeOf(def.tts).toEqualTypeOf<TtsProvider | undefined>();
});

test("agent() without stt/llm/tts is still legal (s2s mode)", () => {
  const def = agent({ name: "t", systemPrompt: "p" });
  expectTypeOf(def.stt).toEqualTypeOf<SttProvider | undefined>();
  expectTypeOf(def.llm).toEqualTypeOf<LlmProvider | undefined>();
  expectTypeOf(def.tts).toEqualTypeOf<TtsProvider | undefined>();
});

test("any subset of the provider triple is an accepted AgentParams", () => {
  // Unset stages are filled from the default all-AssemblyAI pipeline at
  // parse time, so a partial triple is a valid declaration, not an error.
  expectTypeOf<{ name: string; stt: SttProvider }>().toExtend<AgentParams>();
  expectTypeOf<{ name: string; stt: SttProvider; llm: LlmProvider }>().toExtend<AgentParams>();
  expectTypeOf<{ name: string; tts: TtsProvider }>().toExtend<AgentParams>();
  // A bare model-id string is accepted for `llm`.
  expectTypeOf<{ name: string; llm: string }>().toExtend<AgentParams>();
  expectTypeOf<{
    name: string;
    stt: SttProvider;
    llm: LlmProvider;
    tts: TtsProvider;
  }>().toExtend<AgentParams>();
  expectTypeOf<{ name: string }>().toExtend<AgentParams>();
});

test("voice picks the default pipeline's TTS voice, never a descriptor's or S2S's", () => {
  // The shorthand for the golden path…
  expectTypeOf<{ name: string; voice: "michael" }>().toExtend<AgentParams>();
  expectTypeOf<{ name: string; voice: string; llm: LlmProvider }>().toExtend<AgentParams>();
  // …is rejected when an explicit `tts` descriptor owns the voice…
  expectTypeOf<{ name: string; tts: TtsProvider; voice: "michael" }>().not.toExtend<AgentParams>();
  // …and in S2S mode, where the `s2s` descriptor owns it.
  expectTypeOf<{ name: string; s2s: S2sProvider; voice: "michael" }>().not.toExtend<AgentParams>();
});

test("s2s cannot be combined with pipeline providers or pipeline-only tuning", () => {
  expectTypeOf<{ name: string; s2s: S2sProvider }>().toExtend<AgentParams>();
  expectTypeOf<{ name: string; s2s: S2sProvider; tts: TtsProvider }>().not.toExtend<AgentParams>();
  expectTypeOf<{
    name: string;
    s2s: S2sProvider;
    deadAirCoverMs: number;
  }>().not.toExtend<AgentParams>();
  expectTypeOf<{
    name: string;
    s2s: S2sProvider;
    silenceTimeoutMs: number;
  }>().not.toExtend<AgentParams>();
  // `PipelineOnlyField` derives its voice-UX half from `PipelineVoiceTuning`,
  // so this holds for a field added to that interface without touching
  // define.ts — which is the point of deriving it.
  expectTypeOf<{
    name: string;
    s2s: S2sProvider;
    preemptiveGeneration: boolean;
  }>().not.toExtend<AgentParams>();
  // Shared fields stay declarable on an s2s agent.
  expectTypeOf<{ name: string; s2s: S2sProvider; idleTimeoutMs: number }>().toExtend<AgentParams>();
});

test("sttPrompt is declarable in BOTH modes", () => {
  // It is not pipeline-only and must never go back to being typed that way.
  // S2S forwards it as `input.transcription_prompt` and `AgentDef.sttPrompt`
  // documents it as honoured in both modes, but `PipelineOnlyField` listed it
  // anyway — so `agent()` rejected a field the runtime honoured, and the only
  // way to reach the measured win (a spelled first name going from 1 of 6
  // attempts correct to 6 of 6) was to skip `agent()` for a raw config object.
  expectTypeOf<{ name: string; s2s: S2sProvider; sttPrompt: string }>().toExtend<AgentParams>();
  expectTypeOf<{ name: string; sttPrompt: string }>().toExtend<AgentParams>();
});

/**
 * `ctx.signal` is REQUIRED, and `ctx.generate`'s schema overload returns a
 * REQUIRED `object`.
 *
 * Both were optional until they were checked against what the runtime does.
 * The executor builds a per-call `AbortController` on every path, and
 * `host/generate.ts` returns `{ text, object }` unconditionally whenever a
 * schema was passed — so the two `?`s only ever bought authors a `?.` and an
 * `if` on values that are always there. Tightening either back to optional is a
 * silent ergonomic regression, which is why this pins both.
 */
test("ToolContext.signal and a schema generate's object are non-optional", () => {
  expectTypeOf<ToolContext>().toHaveProperty("signal").toEqualTypeOf<AbortSignal>();

  const ctx = {} as ToolContext;
  const withSchema = ctx.generate({ prompt: "p", schema: z.object({ n: z.number() }) });
  expectTypeOf(withSchema).resolves.toEqualTypeOf<{ text: string; object: { n: number } }>();

  // Without a Standard Schema the caller must still narrow: a plain JSON Schema
  // produces an object the framework cannot type.
  const noSchema = ctx.generate({ prompt: "p" });
  expectTypeOf(noSchema).resolves.toEqualTypeOf<{ text: string; object?: unknown }>();
});

/**
 * Text mode is a third arm of the {@link AgentParams} union, and the fields
 * belonging to the other two are typed as MESSAGES rather than left absent.
 *
 * The difference matters at the point an author moves a voice agent to text:
 * an excess-property error names the field and stops, while the message names
 * the rule ("a text agent has no audio to synthesize") and the remedy.
 */
test("text mode accepts only the fields a text agent has", () => {
  expectTypeOf<{ name: string; text: true }>().toExtend<AgentParams>();
  expectTypeOf<{ name: string; text: true; systemPrompt: string }>().toExtend<AgentParams>();
  // The one provider stage it has, in both spellings.
  expectTypeOf<{ name: string; text: true; llm: LlmProvider }>().toExtend<AgentParams>();
  expectTypeOf<{ name: string; text: true; llm: string }>().toExtend<AgentParams>();
  // Shared, mode-agnostic fields stay declarable.
  expectTypeOf<{ name: string; text: true; maxSteps: number }>().toExtend<AgentParams>();
  expectTypeOf<{
    name: string;
    text: true;
    builtinTools: readonly ["web_search"];
  }>().toExtend<AgentParams>();

  // Everything downstream of speech is refused.
  expectTypeOf<{ name: string; text: true; stt: SttProvider }>().not.toExtend<AgentParams>();
  expectTypeOf<{ name: string; text: true; tts: TtsProvider }>().not.toExtend<AgentParams>();
  expectTypeOf<{ name: string; text: true; s2s: S2sProvider }>().not.toExtend<AgentParams>();
  expectTypeOf<{ name: string; text: true; voice: "jane" }>().not.toExtend<AgentParams>();
  expectTypeOf<{ name: string; text: true; sttPrompt: string }>().not.toExtend<AgentParams>();
  // Derived from PipelineVoiceTuning, so a knob added there is refused here
  // without anyone remembering to list it.
  expectTypeOf<{ name: string; text: true; deadAirCoverMs: number }>().not.toExtend<AgentParams>();
  expectTypeOf<{
    name: string;
    text: true;
    silenceTimeoutMs: number;
  }>().not.toExtend<AgentParams>();

  // And the two voice modes refuse `text` from their side.
  expectTypeOf<{ name: string; s2s: S2sProvider; text: true }>().not.toExtend<AgentParams>();
  expectTypeOf<{ name: string; stt: SttProvider; text: true }>().not.toExtend<AgentParams>();
});

/**
 * The workflow-app arm — the fourth, and the only one keyed on the FRONT DOOR
 * rather than on a session mode.
 *
 * It exists because every field it refuses used to be accepted and inert: a
 * `page: "static"` agent has no session and no LLM loop, so a `systemPrompt`
 * on one addresses a model that never runs. The `link-digest` template shipped
 * exactly that, under a comment claiming `GET /client-config` served it.
 */
test("a workflow app accepts only the fields a workflow app has", () => {
  type Workflows = NonNullable<AgentDef["workflows"]>;

  // The whole legal surface: what a page renders, what it starts, what a
  // `"use step"` body reads.
  expectTypeOf<{ name: string; page: "static"; workflows: Workflows }>().toExtend<AgentParams>();
  expectTypeOf<{
    name: string;
    page: "static";
    workflows: Workflows;
    greeting: string;
    requiredEnv: readonly string[];
  }>().toExtend<AgentParams>();

  // `workflows` is the product, so an app declaring none is refused — the page
  // would serve a form whose every submit is a 400.
  expectTypeOf<{ name: string; page: "static" }>().not.toExtend<AgentParams>();

  // Nothing runs a model.
  expectTypeOf<{
    name: string;
    page: "static";
    workflows: Workflows;
    systemPrompt: string;
  }>().not.toExtend<AgentParams>();
  expectTypeOf<{
    name: string;
    page: "static";
    workflows: Workflows;
    tools: Record<string, never>;
  }>().not.toExtend<AgentParams>();
  expectTypeOf<{
    name: string;
    page: "static";
    workflows: Workflows;
    llm: LlmProvider;
  }>().not.toExtend<AgentParams>();
  expectTypeOf<{
    name: string;
    page: "static";
    workflows: Workflows;
    maxSteps: number;
  }>().not.toExtend<AgentParams>();

  // Nothing opens a session, so per-session state and its projection are out.
  expectTypeOf<{
    name: string;
    page: "static";
    workflows: Workflows;
    state: () => { n: number };
  }>().not.toExtend<AgentParams>();
  expectTypeOf<{
    name: string;
    page: "static";
    workflows: Workflows;
    syncState: (s: unknown) => unknown;
  }>().not.toExtend<AgentParams>();

  // Derived from the two existing lists, so a new provider stage or voice knob
  // is refused here without anyone remembering to list it.
  expectTypeOf<{
    name: string;
    page: "static";
    workflows: Workflows;
    s2s: S2sProvider;
  }>().not.toExtend<AgentParams>();
  expectTypeOf<{
    name: string;
    page: "static";
    workflows: Workflows;
    deadAirCoverMs: number;
  }>().not.toExtend<AgentParams>();

  // And the voice arms refuse the front door from their side: without this the
  // arm never bites, because a pipeline agent would match `page: "static"` too
  // and go on accepting every field above.
  expectTypeOf<{ name: string; voice: "jane"; page: "static" }>().not.toExtend<AgentParams>();
  expectTypeOf<{
    name: string;
    s2s: S2sProvider;
    page: "static";
  }>().not.toExtend<AgentParams>();
  expectTypeOf<{ name: string; text: true; page: "static" }>().not.toExtend<AgentParams>();
  // A voice agent may still say so explicitly, and may still declare workflows
  // — `page` is about the front door, not about what the agent may own.
  expectTypeOf<{ name: string; page: "voice"; workflows: Workflows }>().toExtend<AgentParams>();
});

/**
 * `workflowApp()` is `agent()` with the discriminant set — same definition
 * type out, so nothing downstream (config, deploy, the guest harness) learns a
 * second shape.
 */
test("workflowApp() returns an AgentDef and takes no page field", () => {
  expectTypeOf<ReturnType<typeof workflowApp>>().toEqualTypeOf<AgentDef>();
  expectTypeOf<Parameters<typeof workflowApp>[0]>().not.toHaveProperty("page");
  expectTypeOf<Parameters<typeof workflowApp>[0]>().toHaveProperty("workflows");
});
