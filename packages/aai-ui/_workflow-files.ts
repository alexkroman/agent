// Copyright 2026 the AAI authors. MIT license.
/**
 * Which of a submitted form's values are FILES.
 *
 * Its own module because both submit hooks need the identical answer and then do
 * two different things with it — `useWorkflowSubmit` stores each file and passes
 * its id, `useWorkflowStream` cuts it into parts and passes the group they share.
 * A second copy of this predicate would be a form field that one hook treats as a
 * file and the other does not, which is invisible until the run reads the wrong
 * kind of string.
 */

import { isRecord } from "@alexkroman1/aai/utils";

/**
 * The files a submitted field carries, if that is what it carries.
 *
 * An array counts only when it is files ALL the way through — a mixed array is
 * some other field's value that happens to contain one, and turning half of it
 * into ids would corrupt it silently.
 */
export function filesOf(value: unknown): File[] {
  if (value instanceof File) return [value];
  if (!Array.isArray(value)) return [];
  const files = value.filter((one): one is File => one instanceof File);
  return files.length > 0 && files.length === value.length ? files : [];
}

/**
 * The input properties still carrying a `File` — i.e. the ones that CANNOT survive
 * being sent.
 *
 * A run input is JSON, and `JSON.stringify(new File(…))` is `{}` — no `toJSON`, no
 * own enumerable properties. So a File left in a payload does not fail to send: it
 * arrives as an empty object, and the workflow rejects it against whatever its own
 * schema says the property should be. Measured in production as
 * `Invalid input for workflow "transcribe": recording: Invalid input` — a message
 * about a type, on a form where the user had picked a perfectly good file.
 *
 * Exported beside {@link filesOf} because it is the same question asked at the
 * other end: that one decides which fields to UPLOAD, this one checks that none
 * were missed. Both hooks are the callers.
 */
export function fileFields(input: unknown): string[] {
  if (!isRecord(input)) return [];
  return Object.entries(input)
    .filter(([, value]) => filesOf(value).length > 0)
    .map(([key]) => key);
}
