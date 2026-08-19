// Copyright 2026 the AAI authors. MIT license.

/** @jsxImportSource react */

/**
 * Simple forms, for the pages that are not conversations.
 *
 * A workflow app's front door is a form: name a recording, upload a file, press
 * submit. Nothing here knew how to render one — the components in this package
 * are all about a live session (a transcript, a mic button, a tool-call row) —
 * so every such page started by hand-rolling labels, inputs, a submit button and
 * the value collection between them, and did it differently each time.
 *
 * ## Values come off the DOM, not out of React state
 *
 * {@link Form} reads its own `<form>` element on submit and builds one plain
 * object from the named controls. That is what makes a field here nothing more
 * than a styled `<input>`: no registration, no controlled-component ceremony,
 * and a plain `<input name="x">` a caller writes themselves works exactly like
 * the ones below.
 *
 * It also means the values are TYPED rather than all-strings, which a
 * `new FormData(form)` cannot give: a number field yields a number, a checkbox a
 * boolean, an empty optional field nothing at all. That matters because these
 * values go straight into a workflow's input, where a zod schema is waiting —
 * `"3"` against `z.number()` is a rejected run, and the browser is the only
 * place that still knows the field was `type="number"`.
 *
 * ## A file field either describes a file or uploads it
 *
 * See {@link FileField}. A workflow input is journaled and replayed on every
 * resume, so file BYTES do not belong in it — `upload` is the field that sends
 * them somewhere a step can read them and contributes the handle instead.
 */

import { omitUndefined } from "@alexkroman1/aai/utils";
import clsx from "clsx";
import type {
  FormHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from "react";
import { useCallback, useId, useState } from "react";
import { useTheme } from "../context.ts";
import { FormReadinessProvider, useFormReadiness } from "./_form-readiness.ts";
import { collectValues } from "./_form-values.ts";
import { Button, type ButtonSize } from "./button.tsx";
import type { FieldShell, FileRead, FileValue, FormValues } from "./form-types.ts";

// Re-exported so `form.tsx` stays the one import path for everything a form
// needs, definitions and components alike.
export type { FieldShell, FileRead, FileValue, FormValues } from "./form-types.ts";

/** Props of {@link Form}. */
export type FormProps = {
  /**
   * Called with the collected values. May be async — the form stays disabled
   * for the duration, so a double-click cannot submit twice.
   */
  onSubmit: (values: FormValues) => void | Promise<void>;
  /**
   * A failure to show above the fields. The caller owns it, because the
   * interesting failures are the server's (`useWorkflowSubmit`'s `error`) and
   * this component never sees them.
   */
  error?: string | undefined;
  children?: ReactNode;
  className?: string | undefined;
} & Omit<FormHTMLAttributes<HTMLFormElement>, "onSubmit" | "className">;

/**
 * A form that hands its values to `onSubmit` as one object.
 *
 * Native validation still applies — a `required` field blocks the submit and the
 * browser says so, which is better than anything this could render.
 *
 * @example
 * ```tsx
 * import { Form, SubmitButton, TextField } from "@alexkroman1/aai-ui";
 *
 * function NameForm() {
 *   return (
 *     <Form onSubmit={(values) => console.log(values.topic)}>
 *       <TextField name="topic" label="Topic" required />
 *       <SubmitButton>Start</SubmitButton>
 *     </Form>
 *   );
 * }
 * ```
 *
 * @public
 */
export function Form({ onSubmit, error, children, className, ...rest }: FormProps) {
  const theme = useTheme();
  const [busy, setBusy] = useState(false);
  // Whether any child is still waiting for its own field declaration — see
  // `_form-readiness.ts` for why native validation cannot cover that on its own.
  const { pending: fieldsPending, declare } = useFormReadiness();

  const handle = useCallback(
    (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      // `fieldsPending` as well as `busy`, and it guards the SUBMIT rather than only
      // the button: the fieldset below disables a click, and Enter in a text field
      // submits a form without one. Nothing to report — the fields are about to
      // appear, and the person has not been shown anything to be wrong about yet.
      if (busy || fieldsPending) return;
      const form = event.currentTarget;
      setBusy(true);
      void (async () => {
        try {
          await onSubmit(await collectValues(form));
        } finally {
          setBusy(false);
        }
      })();
    },
    [busy, fieldsPending, onSubmit],
  );

  return (
    <form
      onSubmit={handle}
      // Native validation is the whole reason this is a real `<form>`; turning
      // it off would leave every field's `required` decorative.
      className={clsx("flex flex-col gap-5 font-aai", className)}
      // `fieldset` rather than per-control disabling: it covers controls a
      // caller wrote themselves, which is the point of reading the DOM.
      {...rest}
    >
      {/* `busy` OR fields still loading, so the submit button — which lives in
          here — is visibly unavailable rather than silently inert. */}
      <fieldset disabled={busy || fieldsPending} className="contents">
        <FormReadinessProvider value={declare}>{children}</FormReadinessProvider>
      </fieldset>
      {error !== undefined && error !== "" && (
        <p role="alert" className="text-sm" style={{ color: theme.primary }}>
          {error}
        </p>
      )}
    </form>
  );
}

/**
 * Label + control + hint, in the layout every field here uses.
 *
 * Exported so a caller's own control gets the same shell rather than an
 * approximation of it.
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
  label?: string | undefined;
  hint?: string | undefined;
  /** Id of the control this labels. */
  htmlFor?: string | undefined;
  className?: string | undefined;
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
 * A dropdown. Pass `options`, or `children` for full control over the
 * `<option>` elements.
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
 * input — a CSV of ids, a config — and the size is the author's to check.
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

/**
 * The form's submit button, disabled and relabelled while a submit is in
 * flight.
 *
 * @public
 */
export function SubmitButton({
  children,
  pending = false,
  pendingLabel = "Working…",
  size,
  className,
}: {
  children?: ReactNode;
  /**
   * Whether the WORK this form started is still going. Separate from the
   * submit itself, which {@link Form} disables on its own: a workflow run
   * outlives its `POST`, and the button should stay busy until the run is done.
   */
  pending?: boolean;
  pendingLabel?: string;
  size?: ButtonSize | undefined;
  className?: string | undefined;
}) {
  return (
    <Button
      type="submit"
      disabled={pending}
      // Spread rather than passed: `Button` declares these as plain optionals,
      // so a present-and-`undefined` prop is an error under
      // `exactOptionalPropertyTypes`.
      {...omitUndefined({ size, className })}
    >
      {pending ? pendingLabel : children}
    </Button>
  );
}
