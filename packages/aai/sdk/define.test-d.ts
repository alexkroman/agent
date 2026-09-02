// Copyright 2025 the AAI authors. MIT license.
import { expectTypeOf, test } from "vitest";
import { z } from "zod";
// `InlineToolsMisuse` is off the public barrel (it is the implementation of a
// compile error, not authoring API), so this spec names it at its own module.
import type { InlineToolsMisuse } from "./agent-params.ts";
import {
  type AgentParams,
  agent,
  type SharedAgentParams,
  tool,
  type workflowApp,
} from "./define.ts";
import type { LlmProvider, S2sProvider, SttProvider, TtsProvider } from "./providers.ts";
import { sessionSlot } from "./session-slot.ts";
import type { StateProjection } from "./session-state.ts";
import { withTools } from "./tool-registry.ts";
import type { AgentDef, InferToolInput, InferToolOutput, ToolContext, ToolDef } from "./types.ts";

/**
 * Every `AgentDef` field must be declarable through `agent()`.
 *
 * `AgentParams` is now *derived* from `AgentDef` (Omit + Partial<Pick>), so
 * this holds by construction — the test stays as a regression lock against
 * anyone reintroducing an inline re-declaration, which is how `state` once
 * shipped as a runtime-working but excess-property-error field (the CLI and
 * studio bundlers don't typecheck user code, so nothing caught it).
 *
 * `tools` is the one deliberate exception and still satisfies this, because it
 * is present as a KEY typed as a message rather than absent — which is what makes
 * `agent({ tools })` fail with the file to create instead of with a bare excess
 * property. The test below pins that it really is the message.
 */
test("agent() accepts every AgentDef field", () => {
  type MissingFromParam = Exclude<keyof AgentDef, keyof Parameters<typeof agent>[0]>;
  expectTypeOf<MissingFromParam>().toEqualTypeOf<never>();
});

test("agent() takes no state factory, and AgentDef holds none", () => {
  // Both halves of the removal. `state` was the ONLY thing the agent's `S` was
  // inferred from, and `S` existed only so `ctx.state` could be typed — a slot
  // types its own value in the module that declares it, so the factory, the
  // generic and the bag all went together.
  expectTypeOf<"state" extends keyof AgentDef ? true : false>().toEqualTypeOf<false>();
  expectTypeOf<
    "state" extends keyof Parameters<typeof agent>[0] ? true : false
  >().toEqualTypeOf<false>();
});

test("a tool context carries a slot store, not a state bag", () => {
  // Asserted because re-adding the bag is the shape a regression here would
  // take: every module in a multi-file agent would have to restate the state
  // annotation again, which is what a slot exists to stop. Written as pure type
  // assertions rather than over a fabricated context value: laundering `null`
  // into a `ToolContext` would spend an escape hatch on the ratchet for a value
  // nothing reads.
  expectTypeOf<ToolContext["slots"]["read"]>().toBeFunction();
  expectTypeOf<"state" extends keyof ToolContext ? true : false>().toEqualTypeOf<false>();
});

test("a tool reaches session state through a slot, with no annotation", () => {
  // The line this replaces was `execute: ({ item }, ctx: ToolContext<Cart>)`,
  // and the annotation is what a tool in its own FILE could not supply.
  const cartSlot = sessionSlot("cart", () => ({ items: [] as string[] }));
  const add = tool({
    description: "add",
    inputSchema: z.object({ item: z.string() }),
    execute: ({ item }, ctx) => {
      expectTypeOf(item).toEqualTypeOf<string>();
      expectTypeOf(cartSlot.get(ctx)).toEqualTypeOf<{ readonly items: readonly string[] }>();
      return cartSlot.update(ctx, (cart) => {
        cart.items.push(item);
        return cart.items.length;
      });
    },
  });
  // The second type argument is the RESULT, captured from the body — this line
  // used to pin the erased `Promise<unknown> | unknown` that made
  // `InferToolOutput` useless.
  expectTypeOf(add).toMatchObjectType<ToolDef<z.ZodObject<{ item: z.ZodString }>, number>>();
});

/**
 * Both inference helpers, pinned in both directions.
 *
 * `InferToolOutput` resolved to `unknown` for EVERY tool until `ToolDef` grew
 * its `R` parameter: `tool()` re-declared its argument inline and typed
 * `execute` as `Promise<unknown> | unknown`, so the body's real return type was
 * erased at the call. Nothing exercised the helper — no call site, no type test
 * — which is exactly why it could ship broken. These assertions are the lock.
 */
test("InferToolInput and InferToolOutput both resolve the real types", () => {
  const sync = tool({
    description: "count the characters of an item",
    inputSchema: z.object({ item: z.string() }),
    execute: ({ item }) => ({ count: item.length }),
  });
  expectTypeOf<InferToolInput<typeof sync>>().toEqualTypeOf<{ item: string }>();
  expectTypeOf<InferToolOutput<typeof sync>>().toEqualTypeOf<{ count: number }>();

  // An `async` body infers the same thing — the helper awaits.
  const asyncTool = tool({
    description: "look the item up",
    inputSchema: z.object({ item: z.string() }),
    execute: async ({ item }) => ({ found: item !== "" }),
  });
  expectTypeOf<InferToolOutput<typeof asyncTool>>().toEqualTypeOf<{ found: boolean }>();

  // A tool with no `inputSchema` still infers its result, and its input stays
  // the permissive default rather than collapsing to `never`.
  const noSchema = tool({ description: "the time", execute: () => Date.now() });
  expectTypeOf<InferToolOutput<typeof noSchema>>().toEqualTypeOf<number>();

  // `R` defaults to `unknown`, so the one-argument spelling keeps its meaning
  // and an annotation written before this parameter existed still holds.
  expectTypeOf<
    ToolDef<z.ZodObject<{ item: z.ZodString }>> extends ToolDef<
      z.ZodObject<{ item: z.ZodString }>,
      unknown
    >
      ? true
      : false
  >().toEqualTypeOf<true>();
});

test("what a slot READ returns is readonly ALL THE WAY DOWN", () => {
  const cartSlot = sessionSlot("cart", () => ({ items: [] as string[], total: 0 }));
  type Read = ReturnType<typeof cartSlot.get>;
  expectTypeOf<Read>().toEqualTypeOf<{
    readonly items: readonly string[];
    readonly total: number;
  }>();
  // DEEP, and the nested array is the half that matters: the store deep-freezes
  // every durable value, so `cart.items.push(x)` throws at runtime — and under
  // the old shallow `Readonly<T>` it compiled. Two shipped templates called such
  // a tool and threw on every invocation. A `readonly string[]` is NOT
  // assignable to `string[]`, which is what makes the read no longer silently
  // pass to a domain helper declared over the mutable shape.
  expectTypeOf<Read>().not.toExtend<{ items: string[]; total: number }>();
});

test("a discovered registry composes onto a slot-backed agent", () => {
  // A tool is a FILE, so this is the shape the build produces: an authored def
  // plus a resolved registry. It used to be where the state generic could go
  // wrong — a tool written without the state type competed with the def for the
  // inference and collapsed `S` to `never` — and there is no generic left to
  // collapse. What still has to hold is that the composition type-checks.
  const cartSlot = sessionSlot("cart", () => ({ items: [] as string[] }));
  const ping = cartSlot.tool({ description: "p", execute: (_args, cart) => cart.items.length });
  const def = withTools(agent({ name: "t" }), { ping });
  expectTypeOf(def.tools.ping).toExtend<ToolDef | undefined>();
});

test("a slot's projection is what syncState takes", () => {
  const cartSlot = sessionSlot("cart", () => ({ items: [] as string[] }));
  const def = agent({
    name: "t",
    syncState: cartSlot.projection((cart) => ({ count: cart.items.length })),
  });
  expectTypeOf(def.syncState).toExtend<StateProjection | readonly StateProjection[] | undefined>();
  // And it is callable with nothing, which is how a client derives its
  // pre-first-tool-call frame from the same function the server pushes.
  expectTypeOf(cartSlot.projection((cart) => cart.items.length)()).toEqualTypeOf<number>();
});

test("an agent may project more than one slot", () => {
  const a = sessionSlot("a", () => ({ x: 1 }));
  const b = sessionSlot("b", () => ({ y: 2 }));
  const def = agent({
    name: "t",
    syncState: [a.projection((v) => ({ x: v.x })), b.projection((v) => ({ y: v.y }))],
  });
  expectTypeOf(def.syncState).toExtend<StateProjection | readonly StateProjection[] | undefined>();
});

test("`tools` on the authoring params is the message, not a map", () => {
  // The compile half of "a tool is declared by its file". Pinned as a TYPE
  // because that is what an author meets first, and because widening it back to
  // a `ToolDef` record is precisely the regression that would make the rule
  // conventional again — `define.test.ts` pins the runtime throw underneath it.
  expectTypeOf<NonNullable<SharedAgentParams["tools"]>>().toEqualTypeOf<InlineToolsMisuse>();
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

test("the endpointing shorthand is pipeline-only and refuses an explicit stt", () => {
  // The whole point: one number on a default-pipeline agent, no descriptor.
  expectTypeOf<{ name: string; maxTurnSilenceMs: number }>().toExtend<AgentParams>();
  expectTypeOf<{ name: string; minTurnSilenceMs: number }>().toExtend<AgentParams>();
  // An explicit stt descriptor owns its own window, so the shorthand is typed
  // as the message naming where to set it.
  expectTypeOf<{
    name: string;
    stt: SttProvider;
    maxTurnSilenceMs: number;
  }>().not.toExtend<AgentParams>();
  // And it means nothing on the two modes with no pipeline STT stage.
  expectTypeOf<{
    name: string;
    s2s: S2sProvider;
    maxTurnSilenceMs: number;
  }>().not.toExtend<AgentParams>();
  expectTypeOf<{
    name: string;
    text: true;
    maxTurnSilenceMs: number;
  }>().not.toExtend<AgentParams>();
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

  // The whole legal surface: what a page renders, what it starts, what a step
  // reads.
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

  // Nothing opens a session, so the state projection is out.
  expectTypeOf<{
    name: string;
    page: "static";
    workflows: Workflows;
    syncState: StateProjection;
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

/**
 * The workflow-app diagnostics belong to `workflowApp()`, not to every
 * `agent()` call site.
 *
 * tsc prints the WHOLE union at every call site, so a message on the static arm
 * is a message on every diagnostic. Before the split, `agent({ maxSteps: "12"
 * })` — a plain voice agent, an ordinary one-character mistake — reported
 * `Type 'string' is not assignable to type 'number | "\`maxSteps\` has no effect
 * on a workflow app — \`page: "static"\` …"'`, telling an author about a front
 * door they had never heard of and burying `number`. It reports
 * `not assignable to type 'number'` now.
 *
 * The two halves below are what make that true AND keep the field rejected;
 * losing either one is a regression this file exists to catch.
 */
test("the static arm of AgentParams carries no message, and still rejects the field", () => {
  type StaticArm = Extract<AgentParams, { page: "static" }>;
  // `never`, so it is ABSORBED in the union tsc prints — this is the half that
  // cleans up the voice agent's diagnostic.
  expectTypeOf<StaticArm["maxSteps"]>().toEqualTypeOf<undefined>();
  expectTypeOf<StaticArm["systemPrompt"]>().toEqualTypeOf<undefined>();
  // …and the KEY is still present and un-satisfiable, which is the half that
  // keeps a workflow app from declaring a field it has no use for. An absent
  // field would be structurally fine and this object would extend the arm.
  expectTypeOf<{
    name: string;
    page: "static";
    workflows: NonNullable<AgentDef["workflows"]>;
    maxSteps: number;
  }>().not.toExtend<AgentParams>();
});

test('workflowApp() keeps the sentence — it is where `page: "static"` is not a surprise', () => {
  type AppParams = Parameters<typeof workflowApp>[0];
  expectTypeOf<AppParams["maxSteps"]>().toEqualTypeOf<
    | `\`maxSteps\` has no effect on a workflow app — \`page: "static"\` runs no model and opens no session; remove it, or remove \`page: "static"\` to make this a voice agent`
    | undefined
  >();
});
