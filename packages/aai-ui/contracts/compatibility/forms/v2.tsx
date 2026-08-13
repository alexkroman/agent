// Copyright 2026 the AAI authors. MIT license.

/** @jsxImportSource react */

/**
 * Frozen authoring example: `aai-ui:forms` epoch 2.
 *
 * Epoch 2 adds the UPLOAD half of `<FileField>`: with `upload` the field
 * contributes the `File` itself, and `useWorkflowSubmit` stores it before the
 * run starts — which is what makes a form able to take a file at all, since a
 * run's input is journaled and replayed and bytes may not travel in one.
 * Epoch 1 is unchanged and `./v1.tsx` is retained, so this file demonstrates
 * only what is new.
 *
 * See `../client/v1.tsx` for what "frozen" obliges and why the imports are
 * relative.
 */

import {
  FileField,
  type FileRead,
  Form,
  type FormValues,
  SubmitButton,
  useWorkflowSubmit,
  WorkflowFields,
} from "../../../index.ts";

/** The read mode the shorthand sets, still nameable on its own. */
const upload: FileRead = "upload";

/** An upload field contributes the `File`, unread. */
function handle(values: FormValues): File | undefined {
  return values.recording instanceof File ? values.recording : undefined;
}

/** The hand-written form: one file field, and the hook that stores it. */
export function UploadForm() {
  const { submit, pending, error } = useWorkflowSubmit("transcribe");
  return (
    <Form
      onSubmit={(values) => {
        handle(values);
        return submit(values);
      }}
      error={error}
    >
      <FileField name="recording" label="Recording" accept="audio/wav" required upload />
      <FileField name="notes" label="Notes" read={upload} />
      <SubmitButton pending={pending}>Transcribe</SubmitButton>
    </Form>
  );
}

/** The declared form: the picker exists because the workflow declares `uploads`. */
export function DeclaredUploadForm() {
  const { submit, pending } = useWorkflowSubmit("transcribe");
  return (
    <Form onSubmit={(values) => submit(values)}>
      <WorkflowFields workflow="transcribe" />
      <SubmitButton pending={pending}>Transcribe</SubmitButton>
    </Form>
  );
}
