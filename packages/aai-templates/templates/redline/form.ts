/**
 * The submitted form as the workflow's input — the one part of the page a spec
 * can drive.
 *
 * `client.tsx` mounts on import, so nothing in it is reachable from a test. This
 * mapping is exactly the part that should be: it is where the two HAND-WRITTEN
 * fields meet a schema that will refuse them server-side, and getting either
 * reshape wrong is a 400 at `start()` rather than a compile error. See that
 * file's module doc for why the form is half declared and half written.
 *
 * Everything imported here is a TYPE, so this module has no runtime dependency
 * on React, on the SDK, or on the agent — which is what lets `agent.test.ts`
 * import it in a plain Node spec.
 */

import type { WorkflowInputOf } from "@alexkroman1/aai/workflow-api";
import type { FileValue, FormValues } from "@alexkroman1/aai-ui";
import type { redline } from "./agent.ts";

/** What the desk is asked for, derived from the declaration rather than restated. */
export type RedlineFormInput = WorkflowInputOf<typeof redline>;

/**
 * The submitted form as the workflow's input schema wants it.
 *
 * One function, because the two reshapes below are exactly the kind of thing
 * that otherwise gets half-done in the field, the submit handler and the
 * workflow. Blank lines go, so a trailing newline is not a requirement to cover
 * "".
 */
export function toInput(values: FormValues): RedlineFormInput {
  const raw = typeof values.mustCover === "string" ? values.mustCover : "";
  // The scalars ride through as the form collected them — strings from the DOM,
  // which the WORKFLOW's schema coerces and validates server-side. Only the two
  // NON-scalars are reshaped here, because they are exactly the two no generic
  // control renders. The assertion is on the scalars alone and is what
  // `submitForm` exists to avoid needing anywhere a page is not doing this
  // reshaping deliberately.
  const source = attachedDraft(values.source);
  return {
    ...(values as Omit<RedlineFormInput, "mustCover" | "source">),
    mustCover: raw
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
    // Spread rather than `source`, because the schema's `.optional()` means
    // ABSENT: an explicit `undefined` is a different thing to a validator, and
    // to `exactOptionalPropertyTypes`.
    ...(source ? { source } : {}),
  };
}

/**
 * The chosen file as the schema's `source`, or nothing at all.
 *
 * `<FileField read="text">` contributes a {@link FileValue} — the file's
 * metadata plus its text, read in the BROWSER — and contributes no key at all
 * when nothing was chosen, which is why this takes `unknown` and why the absent
 * case is the ordinary one rather than an error. Nothing is uploaded: a draft is
 * a few kilobytes of prose that belongs in the run's input, where it is
 * journaled and replayed with everything else. A RECORDING is the other case,
 * and `transcription-workflow` is where it is answered.
 */
export function attachedDraft(value: unknown): { name: string; text: string } | undefined {
  const file = value as FileValue | undefined;
  if (file === undefined || typeof file.content !== "string") return undefined;
  // Passed through UNTRIMMED, deliberately: a file somebody chose is a file they
  // meant to redline, so an empty one has to come back as the schema refusing it
  // by name rather than as a draft written from scratch that they did not ask
  // for. It is the same layering as `brief` — the schema counts CHARACTERS, and
  // `acceptDraft` catches the whitespace that gets past it.
  return { name: file.name, text: file.content };
}
