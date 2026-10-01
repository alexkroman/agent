// Copyright 2026 the AAI authors. MIT license.
/**
 * Type-level tests for the `mode` discriminant `agent()` is overloaded over.
 *
 * Two kinds of assertion, because the union holds the rule two ways:
 *
 * - **A field is ABSENT from the members whose mode lacks it.** Pinned as key
 *   arithmetic over the same field lists the members are cut from, so a field
 *   added to a list is absent everywhere it should be without this file
 *   changing — and a regression that re-adds one to the wrong member fails
 *   here.
 * - **An object literal carrying one is REJECTED.** `Accepts` (`_test-utils.ts`)
 *   is the rule the compiler applies to an object literal argument —
 *   assignable, AND no key the member does not declare (the excess-property
 *   check) — and `AgentAccepts` is that rule over every overload. Spelled as a
 *   type rather than as an expect-error directive on real calls because every
 *   such directive is an escape hatch the ratchet counts, and because a
 *   directive passes on ANY error, including one unrelated to the field under
 *   test.
 *
 * Plain structural `toExtend` cannot say the second thing for the modern
 * members: a field that is absent is one an object may structurally carry —
 * which is exactly why the run-time twin in `_agent-modes.ts` exists for the
 * callers no excess-property check sees (a spread, a raw object, JSON).
 *
 * @module
 */

import { expectTypeOf, test } from "vitest";
import type { Accepts, AgentAccepts } from "./_test-utils.ts";
import type { AgentGuardrail } from "./agent-guardrails.ts";
import type { AgentMode } from "./agent-mode.ts";
import type { AgentModelTuning } from "./agent-model-tuning.ts";
import type {
  ModeAgentDef,
  PipelineOnlyField,
  TextOnlyExcludedField,
  WorkflowAppOnlyField,
} from "./agent-params.ts";
import type {
  agent,
  PipelineAgentParams,
  S2sAgentParams,
  StaticAgentParams,
  TextAgentParams,
  workflowApp,
} from "./define.ts";
import type { S2sProvider, SttProvider, TtsProvider } from "./providers.ts";
import type { AgentDef } from "./types.ts";

type Workflows = NonNullable<AgentDef["workflows"]>;

test("Accepts models the excess-property check it stands in for", () => {
  // Pinned so the helper the rest of this file leans on cannot silently answer
  // `true` for everything (or `false`).
  expectTypeOf<Accepts<{ a?: number }, { a: number }>>().toEqualTypeOf<true>();
  expectTypeOf<Accepts<{ a?: number }, { a: number; b: number }>>().toEqualTypeOf<false>();
  expectTypeOf<Accepts<{ a?: number }, { a: string }>>().toEqualTypeOf<false>();
});

test("each mode selects exactly one member, and each overload returns its mode", () => {
  expectTypeOf<PipelineAgentParams["mode"]>().toEqualTypeOf<"pipeline" | undefined>();
  expectTypeOf<S2sAgentParams["mode"]>().toEqualTypeOf<"s2s">();
  expectTypeOf<TextAgentParams["mode"]>().toEqualTypeOf<"text">();
  expectTypeOf<StaticAgentParams["mode"]>().toEqualTypeOf<"workflow-app">();
  expectTypeOf<NonNullable<AgentDef["mode"]>>().toEqualTypeOf<AgentMode>();
  expectTypeOf<ModeAgentDef<"s2s">["mode"]>().toEqualTypeOf<"s2s">();
  // Still the one definition type.
  expectTypeOf<ModeAgentDef<"text">>().toExtend<AgentDef>();
  expectTypeOf<ReturnType<typeof workflowApp>>().toEqualTypeOf<AgentDef>();
  expectTypeOf<ReturnType<typeof agent>>().toExtend<AgentDef>();
});

test("the fields a mode lacks are absent from its member", () => {
  // Derived from the field lists, not re-listed: a knob added to
  // `PipelineVoiceTuning` is absent from these three for free.
  expectTypeOf<Extract<PipelineOnlyField, keyof S2sAgentParams>>().toEqualTypeOf<never>();
  expectTypeOf<Extract<PipelineOnlyField, keyof TextAgentParams>>().toEqualTypeOf<never>();
  expectTypeOf<Extract<WorkflowAppOnlyField, keyof StaticAgentParams>>().toEqualTypeOf<never>();
  expectTypeOf<Extract<TextOnlyExcludedField, keyof TextAgentParams>>().toEqualTypeOf<never>();
  expectTypeOf<TextOnlyExcludedField>().toEqualTypeOf<"sttPrompt" | "telephony">();
  // S2S never has the model-request knobs: the service assembles the request.
  expectTypeOf<Extract<keyof AgentModelTuning, keyof S2sAgentParams>>().toEqualTypeOf<never>();
  expectTypeOf<"llm" extends keyof S2sAgentParams ? true : false>().toEqualTypeOf<false>();
  // The descriptor is the one S2S-specific field, and it is REQUIRED.
  expectTypeOf<S2sAgentParams["s2s"]>().toEqualTypeOf<S2sProvider>();
  // Text keeps its one stage and the model knobs.
  expectTypeOf<"llm" extends keyof TextAgentParams ? true : false>().toEqualTypeOf<true>();
  expectTypeOf<Extract<keyof AgentModelTuning, keyof TextAgentParams>>().toEqualTypeOf<
    keyof AgentModelTuning
  >();
  // A workflow app's product is required.
  expectTypeOf<StaticAgentParams["workflows"]>().toEqualTypeOf<Workflows>();
});

type S2s = { name: string; mode: "s2s"; s2s: S2sProvider };

test("an S2S agent cannot carry anything pipeline-shaped", () => {
  expectTypeOf<
    AgentAccepts<S2s & { idleTimeoutMs: number; sttPrompt: string }>
  >().toEqualTypeOf<true>();
  // A pipeline knob, the silence nudge, a stage, the voice and the shorthand.
  expectTypeOf<
    AgentAccepts<S2s & { silence: { deadAirCoverMs: number } }>
  >().toEqualTypeOf<false>();
  expectTypeOf<
    AgentAccepts<S2s & { silence: { nudge: { afterMs: number } } }>
  >().toEqualTypeOf<false>();
  expectTypeOf<AgentAccepts<S2s & { stt: SttProvider }>>().toEqualTypeOf<false>();
  expectTypeOf<AgentAccepts<S2s & { voice: "michael" }>>().toEqualTypeOf<false>();
  expectTypeOf<
    AgentAccepts<S2s & { turnTaking: { maxSilenceMs: number } }>
  >().toEqualTypeOf<false>();
  // The service assembles the request, so no sampling knob — and a guardrail
  // could only report on audio already heard.
  expectTypeOf<AgentAccepts<S2s & { temperature: number }>>().toEqualTypeOf<false>();
  expectTypeOf<
    AgentAccepts<S2s & { outputGuardrails: readonly AgentGuardrail[] }>
  >().toEqualTypeOf<false>();
  // `mode: "s2s"` needs its descriptor.
  expectTypeOf<AgentAccepts<{ name: string; mode: "s2s" }>>().toEqualTypeOf<false>();
});

type Text = { name: string; mode: "text" };

test("a text agent cannot carry anything from the audio half", () => {
  expectTypeOf<
    AgentAccepts<Text & { llm: "claude-sonnet-4-6"; temperature: number }>
  >().toEqualTypeOf<true>();
  expectTypeOf<AgentAccepts<Text & { stt: SttProvider }>>().toEqualTypeOf<false>();
  expectTypeOf<AgentAccepts<Text & { tts: TtsProvider }>>().toEqualTypeOf<false>();
  expectTypeOf<AgentAccepts<Text & { s2s: S2sProvider }>>().toEqualTypeOf<false>();
  expectTypeOf<AgentAccepts<Text & { voice: "jane" }>>().toEqualTypeOf<false>();
  expectTypeOf<AgentAccepts<Text & { sttPrompt: string }>>().toEqualTypeOf<false>();
  expectTypeOf<AgentAccepts<Text & { telephony: true }>>().toEqualTypeOf<false>();
  expectTypeOf<
    AgentAccepts<Text & { turnTaking: { userTurnLimit: { maxWords: number } } }>
  >().toEqualTypeOf<false>();
});

type App = { name: string; mode: "workflow-app"; workflows: Workflows };

test("a workflow app carries only what a page and a deploy read", () => {
  expectTypeOf<
    AgentAccepts<App & { greeting: string; description: string; requiredEnv: readonly string[] }>
  >().toEqualTypeOf<true>();
  expectTypeOf<AgentAccepts<App & { systemPrompt: string }>>().toEqualTypeOf<false>();
  expectTypeOf<AgentAccepts<App & { maxSteps: number }>>().toEqualTypeOf<false>();
  expectTypeOf<AgentAccepts<App & { llm: string }>>().toEqualTypeOf<false>();
  expectTypeOf<AgentAccepts<App & { telephony: true }>>().toEqualTypeOf<false>();
  // The workflows ARE the product.
  expectTypeOf<AgentAccepts<{ name: string; mode: "workflow-app" }>>().toEqualTypeOf<false>();
  // `workflowApp()` sets the mode itself.
  type AppParams = Parameters<typeof workflowApp>[0];
  expectTypeOf<"mode" extends keyof AppParams ? true : false>().toEqualTypeOf<false>();
  expectTypeOf<Accepts<AppParams, { name: string; workflows: Workflows }>>().toEqualTypeOf<true>();
});

test("a pipeline agent refuses the other modes' selectors and descriptors", () => {
  expectTypeOf<
    AgentAccepts<{
      name: string;
      mode: "pipeline";
      silence: { deadAirCoverMs: number };
      temperature: number;
    }>
  >().toEqualTypeOf<true>();
  expectTypeOf<
    AgentAccepts<{ name: string; tts: TtsProvider; turnTaking: { detection: "manual" } }>
  >().toEqualTypeOf<true>();
  // An s2s descriptor on a declared pipeline agent.
  expectTypeOf<
    AgentAccepts<{ name: string; mode: "pipeline"; s2s: S2sProvider }>
  >().toEqualTypeOf<false>();
  // The shorthands beside a descriptor that owns the value.
  expectTypeOf<
    AgentAccepts<{ name: string; tts: TtsProvider; voice: "michael" }>
  >().toEqualTypeOf<false>();
  expectTypeOf<
    AgentAccepts<{ name: string; stt: SttProvider; turnTaking: { maxSilenceMs: number } }>
  >().toEqualTypeOf<false>();
  // Not a mode.
  expectTypeOf<AgentAccepts<{ name: string; mode: "voice" }>>().toEqualTypeOf<false>();
});

test("the mode flags `mode` replaced are not fields at all", () => {
  // `s2s:` with no `mode` is a pipeline agent carrying an S2S descriptor — the
  // pipeline member types the key unsatisfiable, so it is refused rather than
  // absorbed as an extra property.
  expectTypeOf<AgentAccepts<{ name: string; s2s: S2sProvider }>>().toEqualTypeOf<false>();
  expectTypeOf<AgentAccepts<{ name: string; text: true }>>().toEqualTypeOf<false>();
  expectTypeOf<
    AgentAccepts<{ name: string; page: "static"; workflows: Workflows }>
  >().toEqualTypeOf<false>();
  expectTypeOf<
    AgentAccepts<{ name: string; mode: "text"; s2s: S2sProvider }>
  >().toEqualTypeOf<false>();
  expectTypeOf<"text" | "page" extends KeysOfAgentDef ? true : false>().toEqualTypeOf<false>();
});

type KeysOfAgentDef = keyof AgentDef;
