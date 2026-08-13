// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai-ui:forms` epoch 1.
 *
 * See `../client/v1.tsx` for what "frozen" obliges and why the imports are
 * relative.
 *
 * A workflow app's front door, half declared and half written: `WorkflowFields`
 * renders one control per scalar property of the workflow's own input schema,
 * and everything it skips is a plain named control in the same `<Form>`.
 */

import {
  CheckboxField,
  Field,
  type FieldShell,
  FileField,
  type FileRead,
  type FileValue,
  Form,
  type FormProps,
  type FormValues,
  NumberField,
  SelectField,
  SubmitButton,
  TextAreaField,
  TextField,
  WorkflowFields,
} from "../../../index.ts";

const read: FileRead = "text";

/** Every field takes the same shell, so a caller can wrap one. */
const shell: FieldShell = { name: "title", label: "Title", hint: "Shown to the caller" };

/** Values come off the DOM already typed: a number is a number. */
function handle(values: FormValues): void {
  const upload = values.upload as FileValue | undefined;
  console.debug(values.title, values.segments, values.redact, upload?.size);
}

const onSubmit: FormProps["onSubmit"] = handle;

export function SubmitForm({ error }: { error?: string }) {
  return (
    <Form onSubmit={onSubmit} error={error} className="flex flex-col gap-4" autoComplete="off">
      {/* The declared half — one control per scalar the workflow's schema names. */}
      <WorkflowFields workflow="transcribe" />

      {/* The written half, in the same form and with no mapping between them. */}
      <TextField {...shell} required placeholder="Quarterly review" />
      <NumberField name="segments" label="Segments" min={1} max={20} defaultValue={4} />
      <TextAreaField name="notes" label="Notes" rows={4} />
      <SelectField
        name="voice"
        label="Voice"
        options={["jane", { value: "michael", label: "Michael" }]}
      />
      <CheckboxField name="redact" label="Redact names" defaultChecked />
      <FileField name="upload" label="Recording" read={read} accept="audio/*" />
      <Field label="Anything else" hint="A bare named control works identically" htmlFor="extra">
        <input id="extra" name="extra" />
      </Field>
      <SubmitButton pending={false} pendingLabel="Submitting…" size="lg">
        Transcribe
      </SubmitButton>
    </Form>
  );
}
