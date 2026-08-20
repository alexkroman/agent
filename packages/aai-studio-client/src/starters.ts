// Copyright 2025 the AAI authors. MIT license.

/**
 * Starter prompts for the home hero, one catalog per project kind (the hero's
 * Agent/Workflow switcher picks which one it samples from).
 *
 * `label` is the button; `prompt` is what the agent receives. Each starter
 * references its aai-templates template by name: the coding agent's
 * `use_template` tool copies the template's files into the workspace verbatim,
 * so a pick lands the user on a complete, working agent the platform is known
 * to build well — instead of the agent re-deriving (and retyping) the same
 * shape from a prose spec.
 *
 * That is also why the two catalogs are separate lists rather than one list
 * with a tag: a starter is only offered under the kind whose prompt the project
 * will be created with, so a workflow-mode pick can never land a voice-agent
 * template in a project whose coding agent is being told not to write one.
 */

import type { ProjectKind } from "./api.ts";

export type Starter = { label: string; prompt: string };

/** Voice agents — `agent()`, a microphone, a session. */
export const AGENT_STARTERS: Starter[] = [
  {
    label: "A pizza-ordering agent with a real cart",
    prompt: "Use the pizza-ordering template.",
  },
  {
    label: "An agent that solves problems by writing code",
    prompt: "Use the code-interpreter template.",
  },
  {
    label: "A math tutor that never does arithmetic in its head",
    prompt: "Use the math-buddy template.",
  },
  {
    label: "A personal finance helper with live prices",
    prompt: "Use the personal-finance template.",
  },
  {
    label: "A web researcher that cites its sources",
    prompt: "Use the web-researcher template.",
  },
  {
    label: "An FAQ bot over an embedded knowledge base",
    prompt: "Use the embedded-assets template.",
  },
  {
    label: "A drug-interaction checker on openFDA",
    prompt: "Use the health-assistant template.",
  },
  {
    label: "A 911-style dispatch command center",
    prompt: "Use the dispatch-center template.",
  },
  {
    label: "A retail support agent that manages real orders",
    prompt: "Use the retail template.",
  },
  {
    label: "A text adventure in the style of Infocom",
    prompt: "Use the infocom-adventure template.",
  },
  {
    label: "A solo RPG with dice and a story oracle",
    prompt: "Use the solo-rpg template.",
  },
  {
    label: "A late-night movie, music, and book picker",
    prompt: "Use the night-owl template.",
  },
];

/**
 * Workflow apps — `workflowApp()`, a form, durable runs, no session.
 *
 * The three template-backed entries come first because they are the shape the
 * mode's system prompt tells the agent to start from; `transcription-workflow` is
 * the fuller of them (an upload, a webhook resume, a fan-out), `link-digest` the
 * same thing at its smallest, and `spoken-summary` the one whose ANSWER is a
 * file — a step speaks and stores, and the page plays what the run made. The
 * prose entries below them
 * are jobs of the same shape with no template to copy — a form in, a durable
 * run, a result to come back to.
 */
export const WORKFLOW_STARTERS: Starter[] = [
  {
    label: "A transcription desk with an upload form",
    prompt: "Use the transcription-workflow template.",
  },
  {
    label: "A link digest that summarizes a URL",
    prompt: "Use the link-digest template.",
  },
  {
    label: "A recording summarized, and read back aloud",
    prompt: "Use the spoken-summary template.",
  },
  {
    label: "A batch job that enriches a list of companies",
    prompt:
      "Build a workflow app: a form takes a list of company domains, the run enriches each one, and the page shows the finished table.",
  },
  {
    label: "An overnight report you submit and come back to",
    prompt:
      "Build a workflow app: a form starts a report for a date range, the run gathers and summarizes the data, and the page shows the report when it is ready.",
  },
  {
    label: "A document pipeline that waits on a callback",
    prompt:
      "Build a workflow app: a form submits a document for processing, the run parks on a webhook until the provider calls back, and the page shows the extracted fields.",
  },
];

/** Every catalog, by the kind whose projects it starts. */
export const STARTERS: Record<ProjectKind, Starter[]> = {
  agent: AGENT_STARTERS,
  workflow: WORKFLOW_STARTERS,
};

/**
 * A random `count` starters from `pool` without repeats — sampled once per
 * switcher position per page load, so the hero shows a rotating taste of the
 * catalog instead of all of it. A pool smaller than `count` is returned whole
 * rather than padded. `random` is injectable for deterministic tests.
 */
export function sampleStarters(
  pool: readonly Starter[],
  count: number,
  random: () => number = Math.random,
): Starter[] {
  const remaining = [...pool];
  const picked: Starter[] = [];
  while (picked.length < count && remaining.length > 0) {
    const [starter] = remaining.splice(Math.floor(random() * remaining.length), 1);
    if (starter) picked.push(starter);
  }
  return picked;
}
