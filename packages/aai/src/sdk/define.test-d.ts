// Copyright 2025 the AAI authors. MIT license.
import { expectTypeOf, test } from "vitest";
import { z } from "zod";
import type { AgentAccepts } from "./_test-utils.ts";
// `InlineToolsMisuse` is off the public barrel (it is the implementation of a
// compile error, not authoring API), so this spec names it at its own module.
import type { InlineToolsMisuse } from "./agent-params.ts";
import type { TurnDetectionMode } from "./agent-tuning.ts";
import { type AgentParams, agent, type SharedAgentParams, tool } from "./define.ts";
import type { AssemblyAIGatewayModel } from "./providers/llm/llm.ts";
import type { LlmProvider, S2sProvider, SttProvider, TtsProvider } from "./providers.ts";
import type { SessionEventType } from "./session-event-map.ts";
import { sessionSlot } from "./session-slot.ts";
import type { StateProjection } from "./session-state.ts";
import { type SpeakerDef, speaker } from "./speaker.ts";
import type { StandardSchemaV1 } from "./standard-schema.ts";
import type { TELEPHONY_CARRIERS, TelephonyCarrier } from "./telephony-config.ts";
import { withTools } from "./tool-registry.ts";
import type { AgentDef, InferToolInput, InferToolOutput, ToolContext, ToolDef } from "./types.ts";
import type { VoicePresetName } from "./voice-presets.ts";

/** Every key ANY member of a union has — `keyof` of a union is only the shared ones. */
type KeysOf<T> = T extends unknown ? keyof T : never;

/**
 * Every `AgentDef` field must be declarable through `agent()` — on SOME member.
 *
 * Each member of `AgentParams` is *cut* from `AgentDef` (Omit + Pick), so this
 * holds by construction — the test stays as a regression lock against anyone
 * reintroducing an inline re-declaration, which is how `state` once shipped as
 * a runtime-working but excess-property-error field (the CLI and studio
 * bundlers don't typecheck user code, so nothing caught it). Over the union,
 * because a pipeline knob is a key of the pipeline member alone.
 *
 * `tools` is the one deliberate exception and still satisfies this, because it
 * is present as a KEY typed as a message rather than absent — which is what makes
 * `agent({ tools })` fail with the file to create instead of with a bare excess
 * property. The test below pins that it really is the message.
 *
 * `toolsets` is the one field that is NOT a parameter: it is RESOLVED —
 * `agent()` mints the roster's, `withMcpTools` appends an MCP server's.
 */
test("agent() accepts every AgentDef field but the resolved `toolsets`", () => {
  type MissingFromParam = Exclude<keyof AgentDef, KeysOf<AgentParams>>;
  expectTypeOf<MissingFromParam>().toEqualTypeOf<"toolsets">();
});

test("agent() takes no state factory, and AgentDef holds none", () => {
  // Both halves of the removal. `state` was the ONLY thing the agent's `S` was
  // inferred from, and `S` existed only so `ctx.state` could be typed — a slot
  // types its own value in the module that declares it, so the factory, the
  // generic and the bag all went together.
  expectTypeOf<"state" extends keyof AgentDef ? true : false>().toEqualTypeOf<false>();
  expectTypeOf<"state" extends KeysOf<AgentParams> ? true : false>().toEqualTypeOf<false>();
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
  // The second type argument is the RESULT, captured from the body — this pair
  // pins the erased `Promise<unknown> | unknown` that made `InferToolOutput`
  // useless.
  //
  // Two assertions rather than the one `toMatchObjectType<ToolDef<…, number>>`
  // that stood here, because that matcher cannot see a `ToolDef` at all any
  // more: `ToolDef.messages` is an optional OBJECT-typed property, and
  // `toMatchObjectType`'s deep brand answers `never` for one — measured, on a
  // property as small as `{ start?: string[] }`, so it is the SHAPE and not the
  // size. `toExtend` pins assignability and `InferToolOutput` pins the R the
  // matcher was here for, which is the half that could regress.
  //
  // **It is a repo-wide trap, not a fact about `ToolDef`** — a degraded matcher
  // reads as coverage and pins nothing, so before reaching for
  // `toMatchObjectType` on any type here, read "`toMatchObjectType` silently degrades on a
  // type with an optional OBJECT-typed property" in `.agents/testing.md`.
  expectTypeOf(add).toExtend<ToolDef<z.ZodObject<{ item: z.ZodString }>, number>>();
  expectTypeOf<InferToolOutput<typeof add>>().toEqualTypeOf<number>();
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

test("syncState is a record of slot projections keyed by slot name", () => {
  const cartSlot = sessionSlot("cart", () => ({ items: [] as string[] }));
  const def = agent({
    name: "t",
    syncState: { cart: cartSlot.projection((cart) => ({ count: cart.items.length })) },
  });
  expectTypeOf(def.syncState).toEqualTypeOf<
    Readonly<Record<string, StateProjection>> | undefined
  >();
  // And it is callable with nothing, which is how a client derives its
  // pre-first-tool-call frame from the same function the server pushes.
  expectTypeOf(cartSlot.projection((cart) => cart.items.length)()).toEqualTypeOf<number>();
});

test("an agent projects more than one slot as more than one key", () => {
  const a = sessionSlot("a", () => ({ x: 1 }));
  const b = sessionSlot("b", () => ({ y: 2 }));
  expectTypeOf<
    AgentAccepts<{ name: string; syncState: { a: typeof a.projected; b: typeof b.projected } }>
  >().toEqualTypeOf<true>();
  // The two forms the record replaced: a bare projection and an array.
  expectTypeOf<
    AgentAccepts<{ name: string; syncState: typeof a.projected }>
  >().toEqualTypeOf<false>();
  expectTypeOf<
    AgentAccepts<{ name: string; syncState: readonly StateProjection[] }>
  >().toEqualTypeOf<false>();
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
  expectTypeOf<AgentAccepts<{ name: string; stt: SttProvider }>>().toEqualTypeOf<true>();
  expectTypeOf<
    AgentAccepts<{ name: string; stt: SttProvider; llm: LlmProvider }>
  >().toEqualTypeOf<true>();
  expectTypeOf<AgentAccepts<{ name: string; tts: TtsProvider }>>().toEqualTypeOf<true>();
  // A bare model-id string is accepted for `llm`.
  expectTypeOf<AgentAccepts<{ name: string; llm: string }>>().toEqualTypeOf<true>();
  expectTypeOf<
    AgentAccepts<{
      name: string;
      stt: SttProvider;
      llm: LlmProvider;
      tts: TtsProvider;
    }>
  >().toEqualTypeOf<true>();
  expectTypeOf<AgentAccepts<{ name: string }>>().toEqualTypeOf<true>();
});

/**
 * `llm`'s string shorthand is a WIDENING of the gateway union, not a narrowing.
 *
 * The field used to be `LlmProvider | string`, so the documented spelling
 * (`llm: "claude-sonnet-4-6"`) had no autocomplete and a typo became a gateway
 * 400 at the first live session — while `llm({ provider: "assemblyai", model })`, which this
 * field desugars into, was typed against the generated union all along. These
 * cases are the two halves of that: the union has to be VISIBLE, and every
 * string that compiled before has to keep compiling.
 */
test("llm accepts a generated gateway id, an aggregator id, and any other string", () => {
  // The union is visible, which is the point — this is what autocompletes.
  expectTypeOf<AgentAccepts<{ name: string; llm: "claude-sonnet-4-6" }>>().toEqualTypeOf<true>();
  expectTypeOf<AgentAccepts<{ name: string; llm: AssemblyAIGatewayModel }>>().toEqualTypeOf<true>();
  // `"creator/model"` routes through the Vercel AI Gateway.
  expectTypeOf<
    AgentAccepts<{ name: string; llm: "anthropic/claude-sonnet-4-5" }>
  >().toEqualTypeOf<true>();
  // And it stays a widening: a model shipped after this release, and a bare
  // `string` from a computed value, both still compile.
  expectTypeOf<
    AgentAccepts<{ name: string; llm: "model-shipped-last-week" }>
  >().toEqualTypeOf<true>();
  expectTypeOf<AgentAccepts<{ name: string; llm: string }>>().toEqualTypeOf<true>();
  // Text mode is the same field and must not diverge.
  expectTypeOf<
    AgentAccepts<{ name: string; mode: "text"; llm: "gpt-5.5" }>
  >().toEqualTypeOf<true>();
  expectTypeOf<AgentAccepts<{ name: string; mode: "text"; llm: string }>>().toEqualTypeOf<true>();
  // A descriptor is still accepted, and a non-string is still refused.
  expectTypeOf<AgentAccepts<{ name: string; llm: LlmProvider }>>().toEqualTypeOf<true>();
  expectTypeOf<AgentAccepts<{ name: string; llm: 7 }>>().toEqualTypeOf<false>();
});

test("a voice is the TTS descriptor's option — there is no agent-level `voice`", () => {
  expectTypeOf<AgentAccepts<{ name: string; tts: TtsProvider }>>().toEqualTypeOf<true>();
  expectTypeOf<AgentAccepts<{ name: string; voice: "michael" }>>().toEqualTypeOf<false>();
  expectTypeOf<
    AgentAccepts<{ name: string; tts: TtsProvider; voice: "michael" }>
  >().toEqualTypeOf<false>();
  expectTypeOf<
    AgentAccepts<{ name: string; mode: "s2s"; s2s: S2sProvider; voice: "michael" }>
  >().toEqualTypeOf<false>();
  expectTypeOf<
    AgentAccepts<{ name: string; mode: "text"; voice: "michael" }>
  >().toEqualTypeOf<false>();
});

test("s2s cannot be combined with pipeline providers or pipeline-only tuning", () => {
  expectTypeOf<
    AgentAccepts<{ name: string; mode: "s2s"; s2s: S2sProvider }>
  >().toEqualTypeOf<true>();
  expectTypeOf<
    AgentAccepts<{ name: string; mode: "s2s"; s2s: S2sProvider; tts: TtsProvider }>
  >().toEqualTypeOf<false>();
  expectTypeOf<
    AgentAccepts<{
      name: string;
      mode: "s2s";
      s2s: S2sProvider;
      silence: { deadAirCoverMs: number };
    }>
  >().toEqualTypeOf<false>();
  expectTypeOf<
    AgentAccepts<{
      name: string;
      mode: "s2s";
      s2s: S2sProvider;
      silence: { nudge: { afterMs: number } };
    }>
  >().toEqualTypeOf<false>();
  // `PipelineOnlyField` derives its voice-UX half from `PipelineTuning`,
  // so this holds for a field added to that interface without touching
  // define.ts — which is the point of deriving it.
  expectTypeOf<
    AgentAccepts<{
      name: string;
      mode: "s2s";
      s2s: S2sProvider;
      turnTaking: { preemptiveGeneration: boolean };
    }>
  >().toEqualTypeOf<false>();
  // Shared fields stay declarable on an s2s agent.
  expectTypeOf<
    AgentAccepts<{ name: string; mode: "s2s"; s2s: S2sProvider; idleTimeoutMs: number }>
  >().toEqualTypeOf<true>();
});

test("the endpointing shorthand is pipeline-only and refuses an explicit stt", () => {
  // The whole point: one number on a default-pipeline agent, no descriptor.
  expectTypeOf<
    AgentAccepts<{ name: string; turnTaking: { maxSilenceMs: number } }>
  >().toEqualTypeOf<true>();
  expectTypeOf<
    AgentAccepts<{ name: string; turnTaking: { minSilenceMs: number } }>
  >().toEqualTypeOf<true>();
  // An explicit stt descriptor owns its own window, so the shorthand is typed
  // as the message naming where to set it.
  expectTypeOf<
    AgentAccepts<{
      name: string;
      stt: SttProvider;
      turnTaking: { maxSilenceMs: number };
    }>
  >().toEqualTypeOf<false>();
  // And it means nothing on the two modes with no pipeline STT stage.
  expectTypeOf<
    AgentAccepts<{
      name: string;
      mode: "s2s";
      s2s: S2sProvider;
      turnTaking: { maxSilenceMs: number };
    }>
  >().toEqualTypeOf<false>();
  expectTypeOf<
    AgentAccepts<{
      name: string;
      mode: "text";
      turnTaking: { maxSilenceMs: number };
    }>
  >().toEqualTypeOf<false>();
});

test("sttPrompt is declarable in BOTH modes", () => {
  // It is not pipeline-only and must never go back to being typed that way.
  // S2S forwards it as `input.transcription_prompt` and `AgentDef.sttPrompt`
  // documents it as honoured in both modes, but `PipelineOnlyField` listed it
  // anyway — so `agent()` rejected a field the runtime honoured, and the only
  // way to reach the measured win (a spelled first name going from 1 of 6
  // attempts correct to 6 of 6) was to skip `agent()` for a raw config object.
  expectTypeOf<
    AgentAccepts<{ name: string; mode: "s2s"; s2s: S2sProvider; sttPrompt: string }>
  >().toEqualTypeOf<true>();
  expectTypeOf<AgentAccepts<{ name: string; sttPrompt: string }>>().toEqualTypeOf<true>();
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
  expectTypeOf<AgentAccepts<{ name: string; mode: "text" }>>().toEqualTypeOf<true>();
  expectTypeOf<
    AgentAccepts<{ name: string; mode: "text"; systemPrompt: string }>
  >().toEqualTypeOf<true>();
  // The one provider stage it has, in both spellings.
  expectTypeOf<
    AgentAccepts<{ name: string; mode: "text"; llm: LlmProvider }>
  >().toEqualTypeOf<true>();
  expectTypeOf<AgentAccepts<{ name: string; mode: "text"; llm: string }>>().toEqualTypeOf<true>();
  // Shared, mode-agnostic fields stay declarable.
  expectTypeOf<
    AgentAccepts<{ name: string; mode: "text"; maxSteps: number }>
  >().toEqualTypeOf<true>();
  expectTypeOf<
    AgentAccepts<{
      name: string;
      mode: "text";
      builtinTools: readonly ["web_search"];
    }>
  >().toEqualTypeOf<true>();

  // Everything downstream of speech is refused.
  expectTypeOf<
    AgentAccepts<{ name: string; mode: "text"; stt: SttProvider }>
  >().toEqualTypeOf<false>();
  expectTypeOf<
    AgentAccepts<{ name: string; mode: "text"; tts: TtsProvider }>
  >().toEqualTypeOf<false>();
  expectTypeOf<
    AgentAccepts<{ name: string; mode: "text"; s2s: S2sProvider }>
  >().toEqualTypeOf<false>();
  expectTypeOf<
    AgentAccepts<{ name: string; mode: "text"; voice: "jane" }>
  >().toEqualTypeOf<false>();
  expectTypeOf<
    AgentAccepts<{ name: string; mode: "text"; sttPrompt: string }>
  >().toEqualTypeOf<false>();
  // Derived from PipelineVoiceTuning, so a knob added there is refused here
  // without anyone remembering to list it.
  expectTypeOf<
    AgentAccepts<{ name: string; mode: "text"; silence: { deadAirCoverMs: number } }>
  >().toEqualTypeOf<false>();
  expectTypeOf<
    AgentAccepts<{
      name: string;
      mode: "text";
      turnTaking: { userTurnLimit: { maxWords: number } };
    }>
  >().toEqualTypeOf<false>();
  expectTypeOf<
    AgentAccepts<{
      name: string;
      mode: "text";
      silence: { nudge: { afterMs: number } };
    }>
  >().toEqualTypeOf<false>();

  // And the two voice modes refuse `text` from their side.
  expectTypeOf<
    AgentAccepts<{ name: string; s2s: S2sProvider; mode: "text" }>
  >().toEqualTypeOf<false>();
  expectTypeOf<
    AgentAccepts<{ name: string; stt: SttProvider; mode: "text" }>
  >().toEqualTypeOf<false>();
});

/**
 * The phone declaration, on the three arms that can and the two that cannot.
 *
 * It is what MOUNTS `WS /phone`, so the type is the first thing that decides
 * whether an agent can have the surface at all — and the two refusals are the
 * agents with no audio path to put on a call.
 */
test("telephony is declarable on a voice agent and refused where there is no call", () => {
  expectTypeOf<AgentAccepts<{ name: string; telephony: true }>>().toEqualTypeOf<true>();
  expectTypeOf<AgentAccepts<{ name: string; telephony: false }>>().toEqualTypeOf<true>();
  expectTypeOf<
    AgentAccepts<{ name: string; telephony: readonly ["twilio"] }>
  >().toEqualTypeOf<true>();
  expectTypeOf<
    AgentAccepts<{
      name: string;
      telephony: readonly ["twilio", "telnyx"];
    }>
  >().toEqualTypeOf<true>();
  // An S2S agent takes calls like any other voice agent — the bridge is below
  // the session, so the mode it runs in never reaches it.
  expectTypeOf<
    AgentAccepts<{ name: string; mode: "s2s"; s2s: S2sProvider; telephony: true }>
  >().toEqualTypeOf<true>();

  // The known half written inline in the OPEN vocabulary and the list the
  // runtime resolves a declaration through are the same set. `TELEPHONY_CARRIERS`
  // is written out rather than derived from the type (see its own doc), so
  // nothing but this stops a carrier being added to one and not the other.
  expectTypeOf<
    (typeof TELEPHONY_CARRIERS)[number] | (string & {})
  >().toEqualTypeOf<TelephonyCarrier>();
  expectTypeOf<(typeof TELEPHONY_CARRIERS)[number]>().toEqualTypeOf<"twilio" | "telnyx">();

  // A carrier this build ships no codec for COMPILES — the vocabulary is open,
  // so a declaration written for a newer SDK builds on this one; the runtime
  // drops it and `agentConfigWarnings` says so.
  expectTypeOf<
    AgentAccepts<{ name: string; telephony: readonly ["vonage"] }>
  >().toEqualTypeOf<true>();
  // A text agent has no audio path, so a phone call has nothing to reach.
  expectTypeOf<
    AgentAccepts<{ name: string; mode: "text"; telephony: true }>
  >().toEqualTypeOf<false>();
});

/**
 * `SpeakerDef` REFUSES `maxRetries`. That name was the guardrail's revision
 * budget before the knobs were unified, and on `ModelTuning` it means provider
 * retries — so accepting it would keep `speaker({ guardrail, maxRetries: 3 })`
 * compiling while silently changing what the 3 bounds. The error is the point:
 * the field is typed as a message naming `maxRevisions`, so it says the fix.
 */
test("speaker() rejects maxRetries and takes maxRevisions", () => {
  const guardrail = () => true as const;
  speaker({ name: "r", systemPrompt: "S.", guardrail, maxRevisions: 3 });
  // Structural, not only excess-property: `maxRetries` is typed as the rename
  // message, so a def carrying a NUMBER there is not a `SpeakerDef` at all —
  // whether written inline or built elsewhere and passed in.
  type OldSpelling = { name: string; systemPrompt: string; guardrail: () => true; maxRetries: 3 };
  expectTypeOf<OldSpelling>().not.toExtend<Parameters<typeof speaker>[0]>();
  expectTypeOf<OldSpelling>().not.toExtend<SpeakerDef>();
  // The schema overload refuses it too.
  expectTypeOf<
    Omit<OldSpelling, "guardrail"> & { schema: StandardSchemaV1<unknown, { a: string }> }
  >().not.toExtend<SpeakerDef & { schema: StandardSchemaV1 }>();
  // The tuning knobs a subagent does take are still there.
  expectTypeOf<SpeakerDef>().toHaveProperty("temperature");
  expectTypeOf<SpeakerDef>().toHaveProperty("maxOutputTokens");
});

/**
 * The OPEN vocabularies — `Known | (string & {})` — must stay open without
 * collapsing to `string`. A plain `| string` absorbs the known half, and with
 * it the autocomplete the union exists for; the `& {}` is what keeps both.
 */
test("open unions admit any string and keep their known half", () => {
  expectTypeOf<TurnDetectionMode>().not.toEqualTypeOf<string>();
  expectTypeOf<VoicePresetName>().not.toEqualTypeOf<string>();
  expectTypeOf<AssemblyAIGatewayModel>().not.toEqualTypeOf<string>();
  expectTypeOf<"auto">().toExtend<TurnDetectionMode>();
  expectTypeOf<"semantic-v2">().toExtend<TurnDetectionMode>();
  expectTypeOf<"a-preset-from-later">().toExtend<VoicePresetName>();
  expectTypeOf<"a-model-from-later">().toExtend<AssemblyAIGatewayModel>();
});

test("SessionEventType is closed: a misspelled event is not one", () => {
  expectTypeOf<"tool.called">().toExtend<SessionEventType>();
  expectTypeOf<"tool.call">().not.toExtend<SessionEventType>();
  expectTypeOf<"reply.complete">().not.toExtend<SessionEventType>();
  expectTypeOf<string>().not.toExtend<SessionEventType>();
});
