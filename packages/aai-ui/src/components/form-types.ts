// Copyright 2026 the AAI authors. MIT license.
/**
 * What a form's controls CONTRIBUTE — the three types both halves of the form
 * code share.
 *
 * Their own module because `form.tsx` (the components) and `_form-values.ts`
 * (the DOM read) both need them, and a type living in one of those would make
 * the pair import each other.
 */

/**
 * One submitted form, as a plain object keyed by field name.
 *
 * `unknown` values rather than `string`: see the module doc — a number field
 * yields a number and a file field yields a {@link FileValue}.
 *
 * @public
 */
export type FormValues = Record<string, unknown>;

/**
 * What a {@link FileField} contributes to {@link FormValues}.
 *
 * @public
 */
export type FileValue = {
  name: string;
  /** Size in bytes. */
  size: number;
  /** MIME type the browser reported, or `""` when it could not tell. */
  type: string;
  /** Last modified, as epoch ms. */
  lastModified: number;
  /**
   * The file's contents, present only when the field asked for them — see
   * {@link FileField}'s `read` prop. A `data:` URL for `"dataUrl"`, decoded text
   * for `"text"`.
   */
  content?: string;
};

/**
 * How much of a chosen file a {@link FileField} reads.
 *
 * `"upload"` is the odd one and the one a workflow input wants: the field
 * contributes the `File` ITSELF rather than a description of it, and
 * `useWorkflowSubmit` then stores it through `POST /workflows/uploads` and puts
 * the id in the run input. Bytes cannot travel in a run input — see
 * {@link FileField} — so this is how a form takes a file at all.
 *
 * @public
 */
export type FileRead = "none" | "text" | "dataUrl" | "upload";

/**
 * The props every field in `form.tsx` shares.
 *
 * Public because it is part of each field's own signature — a type reachable
 * from a documented one has to be reachable from the entry point too, which the
 * docs build enforces.
 *
 * @public
 */
export type FieldShell = {
  /** Key this field contributes to {@link FormValues}. */
  name: string;
  /** Visible label. Omitted leaves the control unlabelled — pass `aria-label` instead. */
  label?: string | undefined;
  /** One line of guidance under the control. */
  hint?: string | undefined;
  /**
   * Additional CSS class names for the field's WRAPPER (label + control +
   * hint), appended to its own layout classes. The control itself takes the
   * shared field styling; pass `style` or a `data-` hook through the native
   * attributes to reach it.
   */
  className?: string | undefined;
};
