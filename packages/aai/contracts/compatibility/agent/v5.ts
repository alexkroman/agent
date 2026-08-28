// Copyright 2026 the AAI authors. MIT license.
/**
 * FROZEN authoring example — `aai:agent`, epoch 5.
 *
 * Epoch 6 split the static arm of `AgentParams`: the arm `agent()` resolves
 * against types the workflow-app-only fields `never` instead of as compile-error
 * messages, so tsc's printed union stops telling a voice author about
 * `page: "static"`. Epoch 5 is RETAINED because every way an agent was actually
 * declared still compiles — which is what this file tests. Do not edit it to
 * make a compile error go away; the error IS the finding.
 */

import {
  type AgentDef,
  type AgentParams,
  agent,
  assemblyAIPipeline,
  type BuiltinTool,
  type SessionEventHandlers,
  type ToolChoice,
  workflowApp,
} from "../../../index.ts";

/** The plain voice agent — the overwhelmingly common shape. */
export const voice: AgentDef = agent({
  name: "Support Line",
  greeting: "Support, how can I help?",
  systemPrompt: "Be brief and concrete.",
  maxSteps: 6,
  toolChoice: "auto" satisfies ToolChoice,
  builtinTools: ["web_search"] as BuiltinTool[],
  maxTurnSilenceMs: 1600,
  requiredEnv: ["NOTES_API_KEY"],
});

/** Declaring stages explicitly, and through the preset. */
export const staged: AgentDef = agent({
  name: "EU Line",
  ...assemblyAIPipeline({ region: "eu" }),
});

/** A text agent — epoch 5 shipped `text: true`, whatever the guide said. */
export const textOnly: AgentDef = agent({ name: "Docs", text: true });

/** Session observation. */
const events: SessionEventHandlers = { "tool.called": (event) => void event };
export const watched: AgentDef = agent({ name: "Watched", events });

/** The workflow app, through its own front door — and it keeps the messages. */
export const app: AgentDef = workflowApp({ name: "Digest", workflows: {} });

/** Annotating params as the union, which is the shape a helper takes. */
export function withDefaults(params: AgentParams): AgentDef {
  return agent(params);
}
