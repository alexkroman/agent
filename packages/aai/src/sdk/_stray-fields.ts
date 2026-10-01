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

import { nearestNames } from "./_nearest-names.ts";

/**
 * Throw when `src` carries a key that is neither a serializable config field
 * nor a host-only one. The message names every stray key and, for each, the
 * nearest known name within edit distance 3 — which is what makes a
 * transposition or a case slip (`maxsteps`) self-correcting.
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
    // Distance 3, one name: a field is longer than a voice id, and a refusal
    // offers one correction. Uncapped, the nearest name to an invented field is
    // whichever short field is least unlike it — a confident wrong answer.
    const [near] = nearestNames(key, known, { maxDistance: 3, maxNames: 1 });
    return near === undefined ? `\`${key}\`` : `\`${key}\` (did you mean \`${near}\`?)`;
  });
  const subject = stray.length === 1 ? "a field" : `${stray.length} fields`;
  throw new Error(
    `This agent declares ${subject} the SDK does not know, and would silently drop: ` +
      `${named.join(", ")}. Every field \`agent()\` carries is declared; if the value is ` +
      "yours to keep, hold it in a module constant rather than on the agent.",
  );
}

/** `group.field` — a field that moved into one of the `PipelineTuning` groups. */
const inGroup = (group: string, field: string): string => `${group}.${field}`;

/**
 * The flat pipeline knobs that kept their NAME and moved into a group, keyed
 * group → field. Written as keys rather than strings so each is an identifier
 * the compiler and the editor see, and so the table cannot drift from itself —
 * and because a literal `"deadAirCoverMs"` trips Biome's `noSecrets` entropy
 * check, which a key does not.
 */
const MOVED_UNRENAMED = {
  turnTaking: { userTurnLimit: 0, preemptiveGeneration: 0, startSpeakingFloorMs: 0 },
  interruption: { resumeFalseInterruption: 0 },
  silence: { deadAirCoverMs: 0 },
} as const;

const movedUnrenamed: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(MOVED_UNRENAMED).flatMap(([group, fields]) =>
    Object.keys(fields).map((field) => [field, inGroup(group, field)]),
  ),
);

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
  // The mode flags `mode` replaced.
  text: 'mode: "text"',
  page: 'mode: "workflow-app"',
  // The TTS voice shorthand: the voice is the descriptor's option.
  voice: "tts: assemblyAITts({ voice })",
  // The flat pipeline knobs the three `PipelineTuning` groups replaced.
  ...movedUnrenamed,
  turnDetection: inGroup("turnTaking", "detection"),
  minTurnSilenceMs: inGroup("turnTaking", "minSilenceMs"),
  maxTurnSilenceMs: inGroup("turnTaking", "maxSilenceMs"),
  minBargeInWords: inGroup("interruption", "minWords"),
  interruptionMinDurationMs: inGroup("interruption", "minDurationMs"),
  interruptionBackoffMs: inGroup("interruption", "backoffMs"),
  silenceTimeoutMs: inGroup("silence", "nudge.afterMs"),
  silencePrompt: inGroup("silence", "nudge.prompt"),
};
