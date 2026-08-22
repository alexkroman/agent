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
import type { ButtonHTMLAttributes, FormHTMLAttributes, ReactNode } from "react";
import { useCallback, useState } from "react";
import { useTheme } from "../context.ts";
import { FormReadinessProvider, useFormReadiness } from "./_form-readiness.ts";
import { collectValues } from "./_form-values.ts";
import { Button, type ButtonSize, type ButtonVariant } from "./button.tsx";
import type { FormValues } from "./form-types.ts";

// The shell and the six controls. Their own module because this file crossed
// the source-file line cap; nothing a caller writes changed.
export {
  CheckboxField,
  Field,
  FileField,
  NumberField,
  SelectField,
  TextAreaField,
  TextField,
} from "./form-fields.tsx";
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
 * @param props - See {@link FormProps}. Every `<form>` attribute except
 * `onSubmit` and `className` is passed through.
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
 * The form's submit button, disabled and relabelled while a submit is in
 * flight.
 *
 * Accepts all standard `<button>` HTML attributes except `type` and `disabled`,
 * in addition to the props below — so `aria-label` on an icon-only submit,
 * `form`, `id`, `title` and `onClick` all work here exactly as they do on
 * {@link Button}. `type` and `disabled` stay owned: this component sets both
 * from `pending`, and letting a caller set either is how a form gets a submit
 * button that does not submit.
 *
 * @example
 * ```tsx
 * import { Form, SubmitButton, TextField } from "@alexkroman1/aai-ui";
 *
 * function Digest({ pending }: { pending: boolean }) {
 *   return (
 *     <Form onSubmit={() => undefined}>
 *       <TextField name="url" label="Link" required />
 *       <SubmitButton pending={pending} variant="secondary" size="lg">
 *         Summarize
 *       </SubmitButton>
 *     </Form>
 *   );
 * }
 * ```
 *
 * @param props - Button props.
 *
 * @public
 */
export function SubmitButton({
  children,
  pending = false,
  pendingLabel = "Working…",
  size,
  variant,
  className,
  ...rest
}: {
  /** Button label. Replaced by `pendingLabel` while `pending`. */
  children?: ReactNode;
  /**
   * Whether the WORK this form started is still going. Separate from the
   * submit itself, which {@link Form} disables on its own: a workflow run
   * outlives its `POST`, and the button should stay busy until the run is done.
   */
  pending?: boolean;
  /** Label shown in place of `children` while `pending`. Defaults to `"Working…"`. */
  pendingLabel?: string;
  /** Size preset, passed through to {@link Button}. */
  size?: ButtonSize | undefined;
  /** Visual style, passed through to {@link Button}. Defaults to `"default"`. */
  variant?: ButtonVariant | undefined;
  /** Additional CSS class names, appended to {@link Button}'s own. */
  className?: string | undefined;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type" | "disabled" | "className">) {
  return (
    <Button
      type="submit"
      disabled={pending}
      // Spread rather than passed: `Button` declares these as plain optionals,
      // so a present-and-`undefined` prop is an error under
      // `exactOptionalPropertyTypes`.
      {...omitUndefined({ size, variant, className })}
      {...rest}
    >
      {pending ? pendingLabel : children}
    </Button>
  );
}
