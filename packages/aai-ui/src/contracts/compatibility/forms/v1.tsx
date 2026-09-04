// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai-ui:forms` epoch 1.
 *
 * The MIXED form as it was authored at epoch 1 — `<WorkflowFields>` for the
 * scalars the workflow's own input schema declares, plus the controls the
 * schema renders nothing for, written by hand inside the same `<Form>` and
 * mapped on submit. It must keep compiling for as long as epoch 1 is advertised
 * as supported.
 *
 * Both halves of that split are here, because each freezes a different promise:
 * {@link DeclaredEditor} is the declared form with one hand-written field beside
 * it, and {@link Editor} is the same page written out control by control — what
 * an author reaches for before the schema exists, and the only one of the two
 * that names every field component.
 *
 * ## What moved, and why epoch 1 survives it
 *
 * `WorkflowSubmission` gained `startedHere`, and this capability's hash moved
 * with it because `<Form onSubmit>` is what a page wires a submission into.
 *
 * The addition is safe here for the same reason it is safe everywhere a form
 * uses it: a page RECEIVES a `WorkflowSubmission` and reads fields off it. A
 * type gaining a field cannot break a reader, and {@link Editor} below reads
 * `submitForm`, `pending` and `error` and no more. What a field addition WOULD
 * break is code constructing the object — nothing in this capability does, and
 * epoch 1 published no way to (the hooks are `aai-ui:workflow`'s surface, and
 * that epoch's own example carries the argument).
 *
 * Nothing here names `startedHere`.
 *
 * ## The three shapes a form freezes, beyond its controls
 *
 * A file that only rendered fields would freeze their props and nothing else,
 * so three things are named where a narrowing would break a real page:
 *
 * - **`FormProps`**, as the source of the two props a page passes DOWN. A
 *   component that re-declares `onSubmit` by hand agrees with `<Form>` today
 *   and is not held to it; taking the type from `<Form>`'s own props is what
 *   makes a change to its callback signature an error at this boundary rather
 *   than an inference somewhere inside a template.
 * - **`FieldShell` and `Field`**, as a caller's OWN control. The shell is
 *   published precisely so a control this package does not ship gets the same
 *   label/hint/wrapper layout instead of an approximation, and
 *   {@link ColorField} is what exercising that promise looks like — it is the
 *   one component here that could stop compiling without any field component
 *   changing.
 * - **`FileValue` and `FileRead`**, read rather than merely passed.
 *   {@link describeFile} reads four fields off a chosen file, so the shape a
 *   picker CONTRIBUTES is frozen — which matters more than the picker's props,
 *   because `read="upload"` makes the field contribute the `File` itself and a
 *   page that got that wrong compiles right up until a run rejects the input.
 */

import type { FieldShell, FileRead, FileValue, FormProps, FormValues } from "../../../index.ts";
import {
  CheckboxField,
  Field,
  FileField,
  Form,
  NumberField,
  SelectField,
  SubmitButton,
  TextAreaField,
  TextField,
  WorkflowFields,
} from "../../../index.ts";

/**
 * The one field the schema cannot render: an ARRAY.
 *
 * `<WorkflowFields>` deliberately renders nothing for a non-scalar property, so
 * a page that wants one writes it in the same `<Form>` and maps it at submit.
 * That split is the whole reason this example is the mixed shape.
 */
export function toMustCover(values: FormValues): readonly string[] {
  const raw = values.mustCover;
  return typeof raw === "string"
    ? raw
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "")
    : [];
}

/**
 * How much of the chosen draft the picker reads back.
 *
 * Named rather than written inline at the prop, because the four values mean
 * four different things to the run that follows: `"upload"` stores the file and
 * puts an id in the input, where `"text"` and `"dataUrl"` put the BYTES in it —
 * which a run's input cannot carry past a few kilobytes. A page choosing the
 * wrong one here still compiles.
 */
const DRAFT_READ: FileRead = "upload";

/**
 * What the page prints beside the picker once a file is chosen.
 *
 * Takes the contributed value rather than digging it out of {@link FormValues},
 * which is `unknown`-valued by design: the cast a page would write there proves
 * nothing, where a parameter of this type is checked.
 */
export function describeFile(file: FileValue): string {
  const read = file.content === undefined ? "not read" : `${file.content.length} chars read`;
  return `${file.name} — ${file.size} bytes of ${file.type || "unknown type"} (${read})`;
}

/**
 * A control this package does not ship, given the shell every field shares.
 *
 * `Field` is the layout and `FieldShell` is the prop set — taking the whole
 * shell rather than picking two props off it is what keeps a caller's control
 * indistinguishable from a built-in one when the shell grows a prop.
 */
function ColorField({ name, label, hint, className }: FieldShell) {
  const id = `${name}-color`;
  return (
    <Field label={label} hint={hint} htmlFor={id} className={className}>
      <input id={id} name={name} type="color" />
    </Field>
  );
}

/**
 * The wiring a page hands its form, taken from `<Form>`'s own props.
 *
 * `pending` is not among them: it belongs to the submit BUTTON, and a page that
 * folded it into this pair would be describing a form that disables itself,
 * which `<Form>` already does for the duration of an async `onSubmit`.
 */
type EditorProps = Pick<FormProps, "onSubmit" | "error"> & { pending: boolean };

/** The declared half: the schema's scalars, plus the array field it skips. */
export function DeclaredEditor({ onSubmit, pending, error }: EditorProps) {
  return (
    <Form onSubmit={onSubmit} error={error}>
      <WorkflowFields workflow="redline" />
      <TextAreaField name="mustCover" label="Points it must cover (one per line)" rows={4} />
      <SubmitButton pending={pending}>Write it</SubmitButton>
    </Form>
  );
}

/** A page's form, epoch 1: every control written out, plus one of its own. */
export function Editor({ onSubmit, pending, error }: EditorProps) {
  return (
    <Form onSubmit={onSubmit} error={error}>
      <TextField name="topic" label="Topic" required />
      <NumberField name="rounds" label="Revision rounds" min={1} max={5} />
      <SelectField
        name="tone"
        label="Tone"
        options={[
          { value: "plain", label: "Plain" },
          { value: "formal", label: "Formal" },
        ]}
      />
      <TextAreaField name="mustCover" label="Points it must cover (one per line)" rows={4} />
      <FileField name="draft" label="Existing draft" hint="Optional." read={DRAFT_READ} />
      <ColorField name="accent" label="Accent" hint="Any CSS color." />
      <CheckboxField name="cite" label="Cite sources" />
      <SubmitButton pending={pending}>Write it</SubmitButton>
    </Form>
  );
}
