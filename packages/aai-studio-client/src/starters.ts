// Copyright 2025 the AAI authors. MIT license.

/**
 * Starter prompts for the empty chat state. `label` is the button; `prompt`
 * is what the agent receives. Each starter references its aai-templates
 * template by name: the coding agent's `use_template` tool copies the
 * template's files into the workspace verbatim, so a pick lands the user on
 * a complete, working agent the platform is known to build well — instead of
 * the agent re-deriving (and retyping) the same shape from a prose spec.
 */
export type Starter = { label: string; prompt: string };

export const STARTERS: Starter[] = [
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
 * A random `count` starters without repeats — sampled once per page load so
 * the hero shows a rotating taste of the catalog instead of all of it.
 * `random` is injectable for deterministic tests.
 */
export function sampleStarters(count: number, random: () => number = Math.random): Starter[] {
  const pool = [...STARTERS];
  const picked: Starter[] = [];
  while (picked.length < count && pool.length > 0) {
    const [starter] = pool.splice(Math.floor(random() * pool.length), 1);
    if (starter) picked.push(starter);
  }
  return picked;
}
