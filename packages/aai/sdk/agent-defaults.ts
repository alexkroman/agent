// Copyright 2026 the AAI authors. MIT license.
/**
 * Default agent greeting.
 *
 * Split out of `types.ts` purely for file-length hygiene. Inside this package
 * import it from HERE — `types.ts` no longer re-exports it, because the root
 * barrel's `export *` is how it reached an agent author's autocomplete in the
 * first place. Its published home is `@alexkroman1/aai/internal`, whose readers
 * are the ones that genuinely need the sentence: a client rendering the opening
 * line before a socket exists, and a test asserting the shipped value.
 * `DEFAULT_SYSTEM_PROMPT` used to live here and now sits next to the rest of
 * the standing prompt text in `./system-prompt.ts` — it is still on the root,
 * because an author composes against it.
 */

/**
 * Default greeting spoken when a session starts.
 *
 * Deliberately UNANNOTATED, so a reader gets the sentence rather than
 * `string`. This is the one thing every caller hears before they say anything,
 * and the source is not in the tarball.
 */
export const DEFAULT_GREETING = "Hey there! I'm an AI voice assistant. What can I help you with?";
