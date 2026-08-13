// Copyright 2025 the AAI authors. MIT license.
/**
 * Frozen authoring example: `agent` epoch 1.
 *
 * How an agent was declared when this epoch shipped. It is FROZEN — editing it
 * to make a compile error go away defeats the point, because the error IS the
 * finding: an agent written against epoch 1 no longer builds. Either keep the
 * change backward-compatible, or classify the break with
 * `node scripts/api-contracts.mjs --bump agent --drop "<reason>"`.
 *
 * Imports resolve to source rather than to `@alexkroman1/aai` so this compiles
 * in the ordinary `pnpm typecheck` run. Resolution through the package
 * specifier — the other half of what a real project does — is what
 * `check:template-types` covers, against the published types.
 */

import { agent, assemblyAIPipeline, type InferAgentState, tool } from "../../../index.ts";
import { assemblyAIS2s } from "../../../sdk/providers/s2s-barrel.ts";

type CallState = { greeted: boolean };

/** The shape every field of `agent()` was reachable through at epoch 1. */
export const pipelineAgent = agent<CallState>({
  name: "Contract Fixture",
  systemPrompt: "You are a fixture.",
  greeting: "Hello.",
  maxSteps: 4,
  state: () => ({ greeted: false }),
  syncState: (state) => ({ greeted: state.greeted }),
  idleTimeoutMs: 60_000,
  silenceTimeoutMs: 8000,
  silencePrompt: "Ask whether they are still there.",
  sttPrompt: "fixture, epoch",
  toolChoice: "auto",
  builtinTools: ["think", "calculate"],
  requiredEnv: ["ASSEMBLYAI_API_KEY"],
  page: "voice",
  // Pipeline-only voice tuning: every field of PipelineVoiceTuning.
  deadAirCoverMs: 5000,
  errorPhrase: "Sorry, could you say that again?",
  interruptionMinDurationMs: 500,
  minBargeInWords: 2,
  preemptiveGeneration: false,
  resumeFalseInterruption: true,
  startFailurePhrase: "I could not start.",
  ...assemblyAIPipeline({ voice: "jane" }),
  tools: {
    note: tool({
      description: "Record that the caller was greeted.",
      execute(_args, ctx) {
        ctx.state.greeted = true;
        return { ok: true };
      },
    }),
  },
});

/** The `voice` convenience, which desugars to an AssemblyAI TTS descriptor. */
export const voiceAgent = agent({
  name: "Contract Fixture (voice shorthand)",
  voice: "jane",
  tools: {},
});

/** `system` as an alias of `systemPrompt`. */
export const aliasAgent = agent({
  name: "Contract Fixture (system alias)",
  system: "You are a fixture.",
  tools: {},
});

/** S2S mode is reached only by an explicit descriptor. */
export const s2sAgent = agent({
  name: "Contract Fixture (s2s)",
  s2s: assemblyAIS2s({ voice: "jane", languages: ["en"], keyterms: ["fixture"] }),
  tools: {},
});

/** State is recoverable from a declaration. */
export type FixtureState = InferAgentState<typeof pipelineAgent>;

export const declaredName: string = pipelineAgent.name;
export const declaredSteps: number = pipelineAgent.maxSteps;
