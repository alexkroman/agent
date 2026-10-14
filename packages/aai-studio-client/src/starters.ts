// Copyright 2025 the AAI authors. MIT license.

/**
 * Starter prompts for the home hero.
 *
 * `label` is the button; `prompt` is what the agent receives. Each starter
 * references its aai-templates template by name: the coding agent's
 * `use_template` tool copies the template's files into the workspace verbatim,
 * so a pick lands the user on a complete, working agent the platform is known
 * to build well — instead of the agent re-deriving (and retyping) the same
 * shape from a prose spec.
 */

export type Starter = { label: string; prompt: string };

/** Voice agents — `agent()`, a microphone, a session. */
export const STARTERS: Starter[] = [
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
 * A random `count` starters from `pool` without repeats — sampled once per
 * page load, so the hero shows a rotating taste of the
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
