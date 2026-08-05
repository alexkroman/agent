// Copyright 2026 the AAI authors. MIT license.
/**
 * The generated world for one pipeline-fuzz run: what the client does
 * (`FuzzStep`), what the scripted LLM turns do (`ScriptTurn`), how tools behave,
 * and which LLM requests are refused outright.
 *
 * Split out of the spec so that file stays the ORACLES and the driver. The
 * weights here are not cosmetic — each one is a note about which state the run
 * has to reach for some oracle to mean anything, so they are documented at the
 * arbitrary rather than at the call site.
 *
 * @internal Test infrastructure, not part of any public API.
 */

import fc from "fast-check";

/** Scripted LLM steps available to a run; far more than any run consumes. */
export const SCRIPT_LENGTH = 2000;

/** The events a generated step can fire. */
export type ActionKind =
  | "sttPartial"
  | "sttFinal"
  | "ttsAudio"
  | "cancelReply"
  | "reset"
  | "sendUserAudio"
  | "armBargeInFromTool";

export const ACTION_KINDS: readonly ActionKind[] = [
  "sttPartial",
  "sttFinal",
  "ttsAudio",
  "cancelReply",
  "reset",
  "sendUserAudio",
  "armBargeInFromTool",
];

/** Utterance openers — "wait stop that" is the one that reads as a barge-in. */
export const OPENERS = [
  "please look it up",
  "tell me more",
  "wait stop that",
  "yes go on",
] as const;

/**
 * One step of a short session: the event to fire, the opener any utterance it
 * produces uses, and how long to pause afterwards (`null` = no pause). The
 * pause is generated because whether a reply completes before the next event
 * lands is exactly what decides which interleaving a step produces.
 */
export type FuzzStep = {
  action: ActionKind;
  opener: number;
  pauseMs: number | null;
};

export const stepArb: fc.Arbitrary<FuzzStep> = fc.record({
  action: fc.constantFrom(...ACTION_KINDS),
  opener: fc.nat({ max: OPENERS.length - 1 }),
  pauseMs: fc.option(fc.integer({ min: 0, max: 4 }), { nil: null, freq: 2 }),
});

/**
 * How one tool call behaves. Mirrors the roll this harness used before: mostly
 * immediate, sometimes slow, occasionally throwing. Consumed cyclically.
 */
export type ToolBehavior = { kind: "ok" } | { kind: "slow"; ms: number } | { kind: "throw" };

export const toolBehaviorArb: fc.Arbitrary<ToolBehavior> = fc.oneof(
  { weight: 6, arbitrary: fc.record({ kind: fc.constant("ok" as const) }) },
  {
    weight: 3,
    arbitrary: fc.record({
      kind: fc.constant("slow" as const),
      ms: fc.integer({ min: 0, max: 7 }),
    }),
  },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("throw" as const) }) },
);

/**
 * What each scripted LLM turn does; cycled over the script. `tool` is weighted
 * to ~40% to match the fixed probability this harness used before — a uniform
 * choice plus fast-check's bias toward "smaller" values left a good share of
 * runs with an all-text script, i.e. no tool calls at all, which is precisely
 * the state the tool-result oracles need.
 *
 * `fail` is a turn whose LLM stream emits an `error` part: the TURN is over, the
 * SESSION is not — the transport speaks `errorPhrase` and hands the conversation
 * back. Without it the fatality oracle in `createCallbacks` is decorative, since
 * nothing else here ever fails a turn.
 */
export type ScriptTurn = "text" | "tool" | "fail";

export const scriptPatternArb = fc.array(
  fc.oneof(
    { weight: 4, arbitrary: fc.constant("tool" as const) },
    { weight: 6, arbitrary: fc.constant("text" as const) },
    { weight: 1, arbitrary: fc.constant("fail" as const) },
  ),
  { minLength: 4, maxLength: 12 },
);

/** The generated world for one run. */
export type RunInput = {
  steps: readonly FuzzStep[];
  script: readonly ScriptTurn[];
  tools: readonly ToolBehavior[];
  /**
   * Which LLM requests are refused outright, cycled. A request that never
   * produces a stream is a DIFFERENT reporter from an `error` part mid-stream
   * (the catch in `consumeLlmStream`, not the stream-part handler), and both must
   * report the turn's failure non-fatally.
   */
  refusals: readonly boolean[];
};

export const shortRunArb: fc.Arbitrary<RunInput> = fc.record({
  // A floor on the step count, unusually for these harnesses: a run spends its
  // first steps getting the session past start(), so very short scripts finish
  // before a reply ever completes and contribute nothing to the floors below.
  // 6 is where coverage stops paying for the longer counterexamples.
  steps: fc.array(stepArb, { minLength: 6, maxLength: 40 }),
  script: scriptPatternArb,
  tools: fc.array(toolBehaviorArb, { minLength: 1, maxLength: 12 }),
  refusals: fc.array(
    fc.oneof(
      { weight: 1, arbitrary: fc.constant(true) },
      { weight: 12, arbitrary: fc.constant(false) },
    ),
    { minLength: 4, maxLength: 12 },
  ),
});
