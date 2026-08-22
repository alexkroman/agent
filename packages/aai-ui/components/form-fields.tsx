// Copyright 2026 the AAI authors. MIT license.

/** @jsxImportSource react */

/**
 * The controls a form is made of — the shell, the six fields, and the styling
 * they share.
 *
 * Split out of `form.tsx` when that file crossed the repo's source-file line
 * cap; `form.tsx` re-exports every name here, so it stays the one import path
 * for everything a form needs and nothing a caller writes changed.
 *
 * ## Every field takes its element's own attributes
 *
 * Each control is `FieldShell & Omit<…HTMLAttributes, "name" | "className">`,
 * so `required`, `placeholder`, `accept`, `min`/`max`, `aria-*` and the rest
 * pass straight through to the element. `name` and `className` are owned here:
 * `name` is the key the field contributes to {@link FormValues} and is put on
 * the control itself, and `className` styles the field's WRAPPER, the control
 * taking the shared styling below.
 *
 * Note this means the per-property doc comments on the intersections do not
 * reach the published reference — see "A memoized component must NAME its
 * props type" in `packages/aai-ui/CLAUDE.md` — which is why each component's
 * own description carries what a caller needs.
 */

import clsx from "clsx";
import type {
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from "react";
import { useId } from "react";
import { useTheme } from "../context.ts";
import type { FieldShell, FileRead, FileValue, FormValues } from "./form-types.ts";

/**
 * Label + control + hint, in the layout every field here uses.
 *
 * Exported so a caller's own control gets the same shell rather than an
 * approximation of it.
 *
 * @example
 * ```tsx
 * import { Field, Form } from "@alexkroman1/aai-ui";
 *
 * function ColorForm() {
 *   return (
 *     <Form onSubmit={() => undefined}>
 *       <Field label="Accent" hint="Any CSS color." htmlFor="accent">
 *         <input id="accent" name="accent" type="color" />
 *       </Field>
 *     </Form>
 *   );
 * }
 * ```
 *
 * @param props - Field-shell props.
 *
 * @public
 */
export function Field({
  label,
  hint,
  htmlFor,
  className,
  children,
}: {
  /** Visible label. Omitted leaves the control unlabelled. */
  label?: string | undefined;
  /** One line of guidance under the control. */
  hint?: string | undefined;
  /** Id of the control this labels. */
  htmlFor?: string | undefined;
  /** Additional CSS class names for the wrapper, appended to its own. */
  className?: string | undefined;
  /** The control itself. */
  children: ReactNode;
}) {
  const theme = useTheme();
  return (
    <div className={clsx("flex flex-col gap-1.5", className)}>
      {label !== undefined && (
        <label
          htmlFor={htmlFor}
          className="text-[11px] font-medium uppercase tracking-[1.2px]"
          style={{ color: theme.text }}
        >
          {label}
        </label>
      )}
      {children}
      {hint !== undefined && (
        <p className="text-xs opacity-60" style={{ color: theme.text }}>
          {hint}
        </p>
      )}
    </div>
  );
}

/** The shared control styling — one place, so the fields cannot drift apart. */
function useControlProps(): { className: string; style: React.CSSProperties } {
  const theme = useTheme();
  return {
    className: clsx(
      "w-full rounded-aai border px-3 py-2 text-sm font-aai",
      "outline-none focus-visible:[outline:2px_solid] focus-visible:[outline-offset:2px]",
      "disabled:cursor-not-allowed disabled:opacity-50",
    ),
    style: {
      background: theme.surface,
      color: theme.text,
      borderColor: theme.border,
      outlineColor: theme.primary,
    },
  };
}

/**
 * The control styling for a file input.
 *
 * A file input is the one control whose BUTTON the browser draws, and every
 * engine draws it differently: left to the user agent it inherits the field's
 * own colours and can come out as invisible text on the surface it sits on —
 * which is what "the Choose file button doesn't display" is. So the button is
 * styled explicitly through `::file-selector-button` (Tailwind's `file:`
 * variant) in the theme's own colours, and the field's vertical padding is
 * reduced to the button's, since the button is what sets the row's height.
 *
 * The colours reach the variant as CSS CUSTOM PROPERTIES, because a Tailwind
 * class cannot read a JavaScript theme object and a pseudo-element cannot be
 * reached by a React `style` prop.
 */
function useFileControlProps(): { className: string; style: React.CSSProperties } {
  const theme = useTheme();
  const control = useControlProps();
  return {
    className: clsx(
      control.className,
      "cursor-pointer py-1.5 pl-1.5",
      "file:mr-3 file:cursor-pointer file:rounded-aai file:border-0 file:px-3 file:py-1.5",
      "file:text-sm file:font-medium file:font-aai",
      "file:[background:var(--aai-file-button-bg)] file:[color:var(--aai-file-button-fg)]",
    ),
    style: {
      ...control.style,
      "--aai-file-button-bg": theme.primary,
      "--aai-file-button-fg": theme.surface,
    } as React.CSSProperties,
  };
}

/**
 * A single-line text input.
 *
 * Accepts every `<input>` attribute except `name` and `className`, which this
 * component owns, plus the shared {@link FieldShell} props.
 *
 * @param props - {@link FieldShell} props plus `<input>` attributes.
 *
 * @public
 */
export function TextField({
  name,
  label,
  hint,
  className,
  ...rest
}: FieldShell & Omit<InputHTMLAttributes<HTMLInputElement>, "name" | "className">) {
  const id = useId();
  const control = useControlProps();
  return (
    <Field label={label} hint={hint} htmlFor={id} className={className}>
      <input id={id} name={name} type="text" {...control} {...rest} />
    </Field>
  );
}

/**
 * A number input. Contributes a NUMBER to {@link FormValues}, or nothing when
 * left empty.
 *
 * Accepts every `<input>` attribute except `name`, `className` and `type`,
 * plus the shared {@link FieldShell} props — so `min`, `max` and `step` are
 * passed straight through.
 *
 * @param props - {@link FieldShell} props plus `<input>` attributes.
 *
 * @public
 */
export function NumberField({
  name,
  label,
  hint,
  className,
  ...rest
}: FieldShell & Omit<InputHTMLAttributes<HTMLInputElement>, "name" | "className" | "type">) {
  const id = useId();
  const control = useControlProps();
  return (
    <Field label={label} hint={hint} htmlFor={id} className={className}>
      <input id={id} name={name} type="number" {...control} {...rest} />
    </Field>
  );
}

/**
 * A multi-line text input.
 *
 * Accepts every `<textarea>` attribute except `name` and `className`, plus the
 * shared {@link FieldShell} props. `rows` defaults to 4.
 *
 * @param props - {@link FieldShell} props plus `<textarea>` attributes.
 *
 * @public
 */
export function TextAreaField({
  name,
  label,
  hint,
  className,
  rows = 4,
  ...rest
}: FieldShell & Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "name" | "className">) {
  const id = useId();
  const control = useControlProps();
  return (
    <Field label={label} hint={hint} htmlFor={id} className={className}>
      <textarea id={id} name={name} rows={rows} {...control} {...rest} />
    </Field>
  );
}

/**
 * A dropdown.
 *
 * `options` is the short form — a list of strings, or of
 * `{ value, label }` pairs when the two differ. Pass `children` instead for
 * full control over the `<option>` elements; `children` wins when both are
 * given.
 *
 * Otherwise accepts every `<select>` attribute except `name` and `className`,
 * plus the shared {@link FieldShell} props. Note `multiple` works and
 * contributes an ARRAY (`[]` when nothing is chosen).
 *
 * @param props - {@link FieldShell} props, `options`, and `<select>`
 * attributes.
 *
 * @public
 */
export function SelectField({
  name,
  label,
  hint,
  className,
  options,
  children,
  ...rest
}: FieldShell & {
  options?: readonly (string | { value: string; label: string })[];
} & Omit<SelectHTMLAttributes<HTMLSelectElement>, "name" | "className">) {
  const id = useId();
  const control = useControlProps();
  return (
    <Field label={label} hint={hint} htmlFor={id} className={className}>
      <select id={id} name={name} {...control} {...rest}>
        {children ??
          options?.map((option) => {
            const value = typeof option === "string" ? option : option.value;
            const text = typeof option === "string" ? option : option.label;
            return (
              <option key={value} value={value}>
                {text}
              </option>
            );
          })}
      </select>
    </Field>
  );
}

/**
 * A checkbox. Contributes a BOOLEAN to {@link FormValues}.
 *
 * Accepts every `<input>` attribute except `name`, `className` and `type`,
 * plus the shared {@link FieldShell} props. The label renders beside the box
 * rather than above it, so `hint` is the place for guidance.
 *
 * @param props - {@link FieldShell} props plus `<input>` attributes.
 *
 * @public
 */
export function CheckboxField({
  name,
  label,
  hint,
  className,
  ...rest
}: FieldShell & Omit<InputHTMLAttributes<HTMLInputElement>, "name" | "className" | "type">) {
  const id = useId();
  const theme = useTheme();
  return (
    <Field hint={hint} className={className}>
      <label htmlFor={id} className="flex items-center gap-2 text-sm" style={{ color: theme.text }}>
        <input
          id={id}
          name={name}
          type="checkbox"
          style={{ accentColor: theme.primary }}
          {...rest}
        />
        {label}
      </label>
    </Field>
  );
}

/**
 * A file picker. Contributes a {@link FileValue} (or an array, with `multiple`)
 * to {@link FormValues} — or nothing when no file was chosen.
 *
 * **`upload` is what a workflow input wants.** A run's input is serialized into
 * the run record and replayed from it on every resume, so a file's BYTES cannot
 * travel in it. With `upload` the field contributes the `File` itself,
 * `useWorkflowSubmit` stores it through `POST /workflows/uploads` before
 * starting the run, and the input carries the upload id — which a step reads
 * windows of with `readUpload`. Declaring the property in the workflow's
 * `uploads` list makes `<WorkflowFields>` render exactly this, so a declared
 * form needs no file markup at all.
 *
 * **Without it the field describes the file and does not read it.** `read`
 * exists for the cases where the bytes really are small and really are the
 * input — a CSV of ids, a config — and the size is the author's to check. See
 * {@link FileRead} for the four values; `upload` is shorthand for
 * `read="upload"`.
 *
 * Otherwise accepts every `<input>` attribute except `name`, `className` and
 * `type`, plus the shared {@link FieldShell} props — so `accept` and
 * `multiple` are passed straight through.
 *
 * @param props - {@link FieldShell} props, `read`/`upload`, and `<input>`
 * attributes.
 *
 * @public
 */
export function FileField({
  name,
  label,
  hint,
  className,
  read = "none",
  upload = false,
  ...rest
}: FieldShell & {
  read?: FileRead;
  /** Shorthand for `read="upload"` — see above. */
  upload?: boolean;
} & Omit<InputHTMLAttributes<HTMLInputElement>, "name" | "className" | "type">) {
  const id = useId();
  const control = useFileControlProps();
  return (
    <Field label={label} hint={hint} htmlFor={id} className={className}>
      <input
        id={id}
        name={name}
        type="file"
        // Read back by `collectValues` — the one channel a plain DOM read has
        // for a per-field option, and why this stays a `data-` attribute rather
        // than component state.
        data-aai-read={upload ? "upload" : read}
        {...control}
        {...rest}
      />
    </Field>
  );
}
