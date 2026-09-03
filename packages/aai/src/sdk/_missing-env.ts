// Copyright 2026 the AAI authors. MIT license.
/**
 * The one sentence a missing agent-env key fails with.
 *
 * Its own module because `requireEnv` and `requireStepEnv` are deliberately two
 * functions — one reads {@link ToolContext.env}, the other the step slot — and
 * each carried its own verbatim copy of the message. That message is the whole
 * user-facing content of both failures: it names the key and both ways to set
 * it, so a copy that drifts teaches one caller a remedy the other has stopped
 * offering. The functions stay split; the sentence does not.
 */

/**
 * "Missing `NAME` in the agent env" plus the two ways to set it.
 *
 * Phrased as the fix rather than the fault: an absent credential is not
 * transient, and the caller who sees this string (a tool's failure text, a
 * step's throw) is the one who can set the key.
 */
export function missingEnvMessage(name: string): string {
  return (
    `Missing ${name} in the agent env. Add it to .env for \`aai dev\`, or run \`aai secret put ${name}\`, ` +
    "and list it in `requiredEnv` so a deploy checks it."
  );
}
