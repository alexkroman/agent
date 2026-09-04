// Copyright 2026 the AAI authors. MIT license.
/**
 * The stray-field check under `toAgentConfig` — the net that turns a field the
 * SDK does not know from a SILENT DELETION into a sentence.
 *
 * `AgentConfigSchema` is a plain `z.object`, so Zod's default is STRIP: an
 * unknown key is dropped and the parse succeeds. That is the right behaviour
 * for the schema (a config off the wire must tolerate a field a newer SDK
 * added), and the wrong behaviour for an authored `agent({ … })`, where an
 * unknown key can only be a mistake. Both callers of `toAgentConfig` pass an
 * in-process `AgentDef` rather than a deserialized payload, so this file gets
 * to be strict where the schema cannot.
 *
 * What it costs to not have it, measured on a real project: an options bag
 * merged into `agent({ ...preset })` carrying `systemPromt`, `idleTimeouts`
 * and `maxTurnSilenceMS` built green, tested green, and deployed an agent
 * running the stock voice prompt with the stock endpointing window. TypeScript
 * cannot cover this — excess-property checking does not fire through a spread,
 * which is exactly the shape an options bag arrives in — and `aai dev` does not
 * typecheck at all, so nothing between the typo and the phone call looked at it.
 *
 * This is the rule `tool-registry.ts` already applies one layer down
 * ("silently ignoring a declared one is that failure with a new cause"),
 * generalized from `tools` to every field.
 *
 * An `_`-internal module: plumbing between `define.ts` and the config
 * boundary, not API.
 */

/**
 * Throw when `src` carries a key that is neither a serializable config field
 * nor a host-only one. The message names every stray key and, for each, the
 * nearest known name within edit distance 3 — which is what makes a
 * transposition or a case slip (`maxTurnSilenceMS`) self-correcting.
 */
export function assertNoStrayFields(
  src: Readonly<Record<string, unknown>>,
  known: ReadonlySet<string>,
): void {
  const stray = Object.keys(src).filter((key) => !known.has(key));
  if (stray.length === 0) return;
  const named = stray.map((key) => {
    const renamed = RENAMED_FIELDS[key];
    if (renamed !== undefined) return `\`${key}\` (renamed to \`${renamed}\`)`;
    const near = nearestName(key, known);
    return near === undefined ? `\`${key}\`` : `\`${key}\` (did you mean \`${near}\`?)`;
  });
  const subject = stray.length === 1 ? "a field" : `${stray.length} fields`;
  throw new Error(
    `This agent declares ${subject} the SDK does not know, and would silently drop: ` +
      `${named.join(", ")}. Every field \`agent()\` carries is declared; if the value is ` +
      "yours to keep, hold it in a module constant rather than on the agent.",
  );
}

/**
 * Fields this SDK has REMOVED, and what replaced them.
 *
 * Edit distance cannot find these — `system` to `systemPrompt` is six edits,
 * well past the cap a useful suggestion can afford — and they are exactly the
 * mistakes most worth catching, because the author did not typo anything: they
 * wrote a field that used to work. An entry costs one line and pays for itself
 * the first time somebody upgrades.
 */
const RENAMED_FIELDS: Readonly<Record<string, string>> = {
  system: "systemPrompt",
  instructions: "systemPrompt",
};

/**
 * The closest name in `known` within edit distance 3, or `undefined` when
 * nothing is that close.
 *
 * The cap matters more than the algorithm: with no cap, the nearest name to a
 * genuinely invented field is whichever short field happens to be least
 * unlike it, and a confidently wrong suggestion reads as the SDK having
 * misunderstood rather than the author having invented a field.
 */
function nearestName(key: string, known: ReadonlySet<string>): string | undefined {
  const lower = key.toLowerCase();
  let best: string | undefined;
  let bestDistance = 4;
  for (const candidate of known) {
    // A pure case difference is distance 0 here and the likeliest slip of all
    // (`maxTurnSilenceMS`), so it wins outright rather than competing.
    if (candidate.toLowerCase() === lower) return candidate;
    const distance = editDistance(key, candidate, bestDistance);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  return best;
}

/**
 * Levenshtein distance, abandoning once every cell of a row is at or past
 * `limit` — the answer is only ever compared against a small bound, so the
 * full matrix is work nobody reads.
 */
function editDistance(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) >= limit) return limit;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const substitution = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
      const deletion = (previous[j] ?? 0) + 1;
      const insertion = (current[j - 1] ?? 0) + 1;
      current.push(Math.min(substitution, deletion, insertion));
    }
    if (Math.min(...current) >= limit) return limit;
    previous = current;
  }
  return previous[b.length] ?? limit;
}
