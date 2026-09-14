// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:agent` epoch 8.
 *
 * Epoch 9 added a member to the `BuiltinTool` union — `"listen_for"`, which
 * biases the recognizer toward words a lookup just returned — and made it the
 * first entry of `DEFAULT_BUILTIN_TOOLS`, which was empty. Both halves are
 * additive for an author, and this file is the evidence.
 *
 * The union is the interesting half. A union gaining a member is a widening
 * for everyone who PASSES one — `builtinTools: ["think"]` below names the same
 * three strings it always named — and a narrowing only for code that EXHAUSTS
 * it, which an agent declaration cannot do: `builtinTools` is a list of
 * literals an author writes, never a switch they close over. That asymmetry is
 * the whole reason this is a retain.
 *
 * The DEFAULT is the half worth stating twice, because a default that arrives
 * silently is the kind of change that compiles and then surprises. Two
 * properties keep epoch 8 intact: `agent({ builtinTools })` is a LIST rather
 * than a patch, so the declaration below still resolves to exactly the three
 * tools it names and nothing is added behind it; and an agent that names none
 * has its `builtinTools` field left UNSET, so its stored config is unchanged
 * and round-trips as it did. What such an agent gets at RESOLUTION time is one
 * more tool — offered only in pipeline mode, where a recognizer exists to
 * steer — which is a runtime behaviour change rather than a compile-time one,
 * and is the part a changeset has to carry rather than a frozen example.
 *
 * The agent is written the way one was at epoch 8: the pipeline triple named
 * explicitly, the voice tuning an epoch-8 author had, a guardrail, an events
 * hook, and the builtins enumerated.
 *
 * That is the whole promise. If a later epoch REMOVES a `BuiltinTool` member,
 * makes `builtinTools` required, or changes the field from a list to a patch,
 * this file reddens — the signal to DROP the epoch rather than to edit it.
 *
 * @module
 */

import { z } from "zod";

import type { AgentDef, BuiltinTool } from "../../../index.ts";
import { agent } from "../../../index.ts";
import { assemblyAILlm } from "../../../sdk/providers/llm/assemblyai.ts";
import { assemblyAIStt } from "../../../sdk/providers/stt/assemblyai.ts";
import { assemblyAITts } from "../../../sdk/providers/tts/assemblyai.ts";

/** Named rather than inlined, which is what makes the union's shape load-bearing. */
const ENABLED: readonly BuiltinTool[] = ["think", "remember", "recall"];

export const supportAgent: AgentDef = agent({
  name: "support",
  systemPrompt: "Help the caller with their order. Confirm before changing anything.",
  greeting: "Support desk — how can I help?",
  stt: assemblyAIStt({ keyterms: ["gift card", "store credit"], minTurnSilenceMs: 1600 }),
  llm: assemblyAILlm(),
  tts: assemblyAITts({ voice: "jane" }),
  builtinTools: [...ENABLED],
  temperature: 0.2,
  maxSteps: 8,
  outputGuardrails: [(text) => (text.includes("guarantee") ? "Do not promise a guarantee." : true)],
  events: {
    "user-transcript.committed": (event) => {
      void event;
    },
  },
});

/** An epoch-8 author's own narrowing over the union, still exhaustive here. */
export function isCognitive(name: BuiltinTool): boolean {
  return name === "think" || name === "remember" || name === "recall";
}

/** Parameters an epoch-8 tool declared, unchanged by either half. */
export const refundParams = z.object({ orderId: z.string(), amount: z.number() });
