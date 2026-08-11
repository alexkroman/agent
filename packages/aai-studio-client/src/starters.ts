// Copyright 2025 the AAI authors. MIT license.

/**
 * Starter prompts for the empty chat state, in two pools — one per project
 * KIND. `label` is the button; `prompt` is what the agent receives.
 *
 * Each starter references its aai-templates template by name: the coding agent's
 * `use_template` tool copies the template's files into the workspace verbatim, so
 * a pick lands the user on a complete, working project the platform is known to
 * build well — instead of the agent re-deriving (and retyping) the same shape
 * from a prose spec.
 *
 * The pools are separate because the two kinds produce different artifacts and
 * are given different system prompts (see `studio-prompt.ts`): offering a voice
 * agent's examples to someone who picked Workflows would start them in a project
 * whose coding agent has been told not to write voice agents.
 */
export type Starter = { label: string; prompt: string };

/** What a project builds. Mirrors the server's `CreateProjectSchema.kind`. */
export type ProjectKind = "agent" | "workflow";

/** Voice agents — a conversation, a microphone, tools called mid-turn. */
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
 * Workflows — a static page over durable, journaled server work.
 *
 * Only the first has a template today (`transcription-desk`, the worked
 * example). The rest are prose specs, which is the honest state: the coding
 * agent has the workflow addendum in its prompt and writes them from that. When
 * one of these becomes a template, change the prompt to name it — a template
 * copy beats a re-derivation every time.
 */
export const WORKFLOW_STARTERS: Starter[] = [
  {
    label: "Upload a recording and transcribe it",
    prompt: "Use the transcription-desk template.",
  },
  {
    label: "A page that summarizes a long document",
    prompt:
      "Build a workflow app: a page where I paste or upload a long document, and a workflow " +
      "that splits it into sections, summarizes each one as its own step, then combines them " +
      "into one summary I can copy.",
  },
  {
    label: "Batch-check a list of URLs and report what broke",
    prompt:
      "Build a workflow app: a page where I paste a list of URLs, and a workflow that checks " +
      "each one as its own step (status, redirect chain, response time) and shows me a table " +
      "of the results with the failures first.",
  },
  {
    label: "A nightly digest of a topic, saved to the database",
    prompt:
      "Build a workflow app: a page where I pick a topic and see past digests, and a workflow " +
      "that researches the topic, waits with a durable sleep, researches again, and stores " +
      "each digest in the database.",
  },
  {
    label: "Enrich a CSV of companies row by row",
    prompt:
      "Build a workflow app: a page where I upload a CSV of company names, and a workflow " +
      "that looks each one up as its own step and gives me an enriched CSV back to download.",
  },
];

/** The pool for a kind — one lookup, so a caller never branches on the union. */
export function startersFor(kind: ProjectKind): Starter[] {
  return kind === "workflow" ? WORKFLOW_STARTERS : AGENT_STARTERS;
}

/**
 * A random `count` starters without repeats, from `kind`'s pool — sampled once
 * per page load so the hero shows a rotating taste of the catalog instead of all
 * of it. `random` is injectable for deterministic tests.
 */
export function sampleStarters(
  kind: ProjectKind,
  count: number,
  random: () => number = Math.random,
): Starter[] {
  const pool = [...startersFor(kind)];
  const picked: Starter[] = [];
  while (picked.length < count && pool.length > 0) {
    const [starter] = pool.splice(Math.floor(random() * pool.length), 1);
    if (starter) picked.push(starter);
  }
  return picked;
}
