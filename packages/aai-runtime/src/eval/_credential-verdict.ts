// Copyright 2026 the AAI authors. MIT license.
/**
 * The verdict half of an {@link EvalCredentials}, shared by the two functions
 * that produce one.
 *
 * `evalCredentials` and `evalWorkflowCredentials` answer DIFFERENT questions —
 * which names an agent needs is the whole difference between them, and each
 * one's doc argues its own answer — but what they do with the answer is one
 * thing: a `ready` flag and, when it is false, a sentence phrased as the fix.
 * Both carried a verbatim copy of that sentence, including its singular/plural
 * agreement, so a skip could come to explain itself one way from a session
 * suite and another from a workflow suite about the same missing key.
 */

/** `missing` plus the two fields derived from it. */
export type CredentialVerdict = {
  readonly missing: readonly string[];
  readonly ready: boolean;
  readonly reason: string | undefined;
};

/**
 * Turn the missing names into the verdict an eval suite skips on.
 *
 * Phrased as the fix rather than the fault: the reader is a developer whose
 * suite just skipped, and what they need is the command that un-skips it.
 */
export function credentialVerdict(missing: readonly string[]): CredentialVerdict {
  return {
    missing,
    ready: missing.length === 0,
    reason:
      missing.length === 0
        ? undefined
        : `${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not set — ` +
          "export it, or put it in the project's .env and run `aai eval`",
  };
}
