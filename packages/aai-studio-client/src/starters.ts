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
    label: "A pizza counter that keeps a real cart",
    prompt: "Use the pizza-ordering-agent template.",
  },
  {
    label: "A problem solver that writes and runs code",
    prompt: "Use the code-interpreter-agent template.",
  },
  {
    label: "A web researcher that cites its sources",
    prompt: "Use the web-research-agent template.",
  },
  {
    label: "A drug-interaction checker that queries openFDA",
    prompt: "Use the medication-safety-agent template.",
  },
  {
    label: "A dispatch desk that runs a live incident board",
    prompt: "Use the emergency-dispatch-agent template.",
  },
  {
    label: "A retail support line that manages real orders",
    prompt: "Use the retail-orders-agent template.",
  },
  {
    label: "A text adventure narrator in the style of Infocom",
    prompt: "Use the text-adventure-agent template.",
  },
  {
    label: "A tabletop RPG narrator with dice and a story oracle",
    prompt: "Use the tabletop-rpg-agent template.",
  },
  {
    label: "A late-night picker for movies, music, and books",
    prompt: "Use the entertainment-picks-agent template.",
  },
];

/**
 * Workflow apps — `workflowApp()`, a form, durable runs, no session.
 *
 * The three template-backed entries come first because they are the shape the
 * mode's system prompt tells the agent to start from; `transcription-workflow` is
 * the fuller of them (an upload, a webhook resume, a fan-out), `link-digest-workflow` the
 * same thing at its smallest, and `spoken-summary-workflow` the one whose ANSWER is a
 * file — a step speaks and stores, and the page plays what the run made. The
 * prose entries below them
 * are jobs of the same shape with no template to copy — a form in, a durable
 * run, a result to come back to.
 */
export const WORKFLOW_STARTERS: Starter[] = [
  {
    label: "A transcription desk that takes an uploaded recording",
    prompt: "Use the transcription-workflow template.",
  },
  {
    label: "A link digest that summarizes any URL",
    prompt: "Use the link-digest-workflow template.",
  },
  {
    label: "A recording summarizer that reads its answer back aloud",
    prompt: "Use the spoken-summary-workflow template.",
  },
  {
    label: "A batch enricher that works through a list of companies",
    prompt:
      "Build a workflow app: a form takes a list of company domains, the run enriches each one, and the page shows the finished table.",
  },
  {
    label: "An overnight reporter you submit to and come back to",
    prompt:
      "Build a workflow app: a form starts a report for a date range, the run gathers and summarizes the data, and the page shows the report when it is ready.",
  },
  {
    label: "A document pipeline that parks on a provider callback",
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
