// Copyright 2025 the AAI authors. MIT license.
/**
 * Frozen authoring example: `agent` epoch 2.
 *
 * Epoch 2 added `TextAgentParams` — a third arm of `AgentParams` for an agent
 * with no audio path at all. Everything epoch 1 could express still compiles
 * (see `./v1.ts`, which is retained for exactly that reason); this file covers
 * only what epoch 2 added, so the two together are the whole contract.
 *
 * See `./v1.ts` for what "frozen" obliges and why the imports are relative.
 */

import { agent, type TextAgentParams, tool } from "../../../index.ts";

type DeskState = { answered: number };

/** A text-mode agent: an LLM, a prompt and tools, with no transport. */
export const textAgent = agent<DeskState>({
  name: "Contract Fixture (text)",
  text: true,
  systemPrompt: "You are a fixture.",
  greeting: "Hello.",
  maxSteps: 4,
  llm: "qwen3-next-80b-a3b",
  state: () => ({ answered: 0 }),
  tools: {
    answer: tool({
      description: "Record an answer.",
      execute(_args, ctx) {
        ctx.state.answered += 1;
        return { answered: ctx.state.answered };
      },
    }),
  },
});

/** The model may be a descriptor as well as the gateway id shorthand. */
export const minimalTextAgent = agent({
  name: "Contract Fixture (text, minimal)",
  text: true,
  tools: {},
});

/** The new union arm is nameable, the way the other two already were. */
export type FixtureTextParams = TextAgentParams<DeskState>;

export const isText: true | undefined = textAgent.text;
