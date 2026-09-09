// Copyright 2026 the AAI authors. MIT license.
/**
 * The two sentences said about a `systemPrompt` that carries its own copy of
 * `DEFAULT_SYSTEM_PROMPT`.
 *
 * Split out of `system-prompt.ts` at the 500-line cap, along the seam that file
 * already has: everything else in it ASSEMBLES the prompt, and this only
 * reports on one. The constant's LENGTH is passed in rather than imported, so
 * the dependency runs one way — `system-prompt.ts` owns the text and this owns
 * what is said about a duplicate of it, with no cycle between them.
 *
 * `_`-prefixed: nothing outside this package's prompt assembly has any business
 * calling it. It is the same shape as `_dialog-refusal.ts` — one sentence, one
 * home, so the two readers of it cannot drift.
 */

/**
 * Prompts already reported on, so an agent is told once rather than on every
 * build.
 *
 * Keyed by the prompt TEXT rather than latched with a boolean: the warning is
 * then a function of the input instead of of call order — which is what makes it
 * assertable — and an agent has exactly one `systemPrompt`, so the set holds one
 * entry for the life of the process. `createSystemPromptResolver` rebuilds the
 * prompt once a calendar day, and a test rebuilds it per case; neither should
 * reprint the line.
 */
const warnedPrompts = new Set<string>();

/**
 * Say that a prompt carries its own copy of the default.
 *
 * Two different sentences, because the two shapes have different consequences.
 * A LEADING copy is repaired by `stripDefaultPrefix`, and saying so is what
 * stops the repair from teaching the premise it exists to undo. A copy anywhere
 * ELSE is NOT repaired: it is sent, in full, on top of the sections
 * `buildSystemPrompt` always emits — two ~10,000-character copies under two
 * precedence headers arguing with each other, on every turn, and until this line
 * existed nothing reported it at any layer.
 *
 * `console.warn` through `globalThis`, like `stepReport`'s fallback channel:
 * this module is in `sdk/`, which must run in a browser and in Deno, so it may
 * not reach for a Node logger, and `buildSystemPrompt` has no channel threaded
 * to it. A prompt is assembled at session start on the server, so the line
 * lands wherever that server's output goes.
 *
 * @param systemPrompt - The author's prompt, which is also the dedupe key.
 * @param options - `leading` distinguishes the repaired case from the sent one;
 *   `defaultLength` is `DEFAULT_SYSTEM_PROMPT.length`, quoted in the sentence so
 *   the reader sees what the duplication costs.
 */
export function warnDuplicatedDefaultPrompt(
  systemPrompt: string,
  options: { leading: boolean; defaultLength: number },
): void {
  if (warnedPrompts.has(systemPrompt)) return;
  warnedPrompts.add(systemPrompt);
  const line = options.leading
    ? "systemPrompt begins with a verbatim copy of DEFAULT_SYSTEM_PROMPT, which has been dropped. " +
      "`agent({ systemPrompt })` is APPENDED to the default voice sections, never a replacement — " +
      "write only your own domain rules."
    : `systemPrompt contains a verbatim copy of DEFAULT_SYSTEM_PROMPT (${options.defaultLength} characters) ` +
      "somewhere other than the start, so the voice rules are being sent TWICE — once by the " +
      "framework and once by you, under two precedence headers — on every turn. Only a LEADING " +
      "copy is dropped automatically. `agent({ systemPrompt })` is appended to the defaults, " +
      "never a replacement: remove the interpolation and keep your own rules.";
  (globalThis as { console?: { warn?: (...args: unknown[]) => void } }).console?.warn?.(
    `[aai] ${line}`,
  );
}
