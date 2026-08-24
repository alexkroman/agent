// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:subagent` epoch 1.
 *
 * The shape this capability was introduced with: a subagent declared at module
 * scope, delegated to from a tool body, and read for both halves of what a run
 * answers — the text, and what it cost. The parallel fan-out is here too,
 * because "several runs are ordinary promises" is part of the promise: a change
 * that made `ctx.delegate` anything other than a plain async call would break
 * every caller written this way, and this file is where that would surface.
 *
 * See `../agent/v3.ts` for what "frozen" obliges and why the imports are
 * relative.
 */

import { z } from "zod";

import {
  type DelegateOptions,
  type DelegateResult,
  type SubagentDef,
  type SubagentToolCall,
  subagent,
  tool,
} from "../../../index.ts";

/** Declared at module scope, with a model, a builtin surface and a budget. */
const researcher: SubagentDef = subagent({
  name: "researcher",
  instructions: "Research the task. Finish with a summary — it is all the caller sees.",
  llm: "gemini-2.5-flash",
  builtinTools: ["web_search", "visit_webpage"],
  maxSteps: 6,
  temperature: 0.2,
  maxOutputTokens: 800,
});

/** A subagent whose tools are the author's own, and which names no model. */
const summarizer = subagent({
  name: "summarizer",
  instructions: "Summarize what you are given.",
  tools: {
    word_count: tool({
      description: "Count the words in a string",
      inputSchema: z.object({ text: z.string() }),
      execute: ({ text }) => text.split(/\s+/).length,
    }),
  },
});

/** The brief is a value, so it can be built somewhere other than the call. */
const brief = (angle: string): DelegateOptions => ({
  task: angle,
  context: "This angle belongs to a briefing.",
  maxSteps: 4,
});

function describe(calls: readonly SubagentToolCall[]): string {
  return calls.map((call) => `${call.name}(${JSON.stringify(call.input)})`).join(", ");
}

export const research = tool({
  description: "Research a topic across several angles at once.",
  inputSchema: z.object({ angles: z.array(z.string()) }),
  execute: async ({ angles }, ctx) => {
    const runs: DelegateResult[] = await Promise.all(
      angles.map((angle) => ctx.delegate(researcher, brief(angle))),
    );
    const digest = await ctx.delegate(summarizer, {
      task: runs.map((run) => run.text).join("\n\n"),
    });
    return {
      digest: digest.text,
      steps: runs.reduce((total, run) => total + run.steps, 0),
      work: runs.map((run) => describe(run.toolCalls)),
    };
  },
});
