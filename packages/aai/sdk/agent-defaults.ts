// Copyright 2026 the AAI authors. MIT license.
/**
 * Default agent greeting.
 *
 * Split out of `types.ts` purely for file-length hygiene; import it from
 * `./types.ts` (which re-exports it) or the package root as before.
 * `DEFAULT_SYSTEM_PROMPT` used to live here and now sits next to the rest of
 * the standing prompt text in `./system-prompt.ts`.
 */

/**
 * Default greeting spoken when a session starts.
 *
 * Deliberately UNANNOTATED, so the reference renders the sentence rather than
 * `string`. This is the one thing every caller hears before they say anything,
 * and the source is not in the tarball.
 */
export const DEFAULT_GREETING = "Hey there! I'm an AI voice assistant. What can I help you with?";
