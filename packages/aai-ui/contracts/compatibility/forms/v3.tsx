// Copyright 2026 the AAI authors. MIT license.

/** @jsxImportSource react */

/**
 * Frozen authoring example: `aai-ui:forms` epoch 3.
 *
 * **Nothing an author writes changed**, which is why epoch 2 is RETAINED and
 * `./v2.tsx` compiles unchanged beside this file. The epoch moved because the
 * SDK's run vocabulary — `WorkflowSummary`, which `<WorkflowFields>` renders a
 * form from — moved off `@alexkroman1/aai`'s root barrel to
 * `@alexkroman1/aai/workflow-api`, and that shows in this package's rolled-up
 * `.d.ts` as a changed import specifier.
 *
 * The reason to freeze it anyway is the property that makes the move invisible
 * here: a `client.tsx` imports from `@alexkroman1/aai-ui` and never from the SDK
 * directly, so the re-export absorbs the change. This file is what proves that
 * — every name below is reached through this package.
 *
 * See `../client/v1.tsx` for what "frozen" obliges and why the imports are
 * relative.
 */

import {
  FileField,
  Form,
  type FormValues,
  SubmitButton,
  useWorkflowSubmit,
  WorkflowFields,
  type WorkflowSummary,
} from "../../../index.ts";

/** The listing a form renders itself from, named through THIS package. */
export function title(summary: WorkflowSummary): string {
  return summary.description ?? summary.name;
}

export function TranscribeForm() {
  const { submit, pending } = useWorkflowSubmit("transcribe");
  return (
    <Form onSubmit={(values: FormValues) => submit(values)}>
      <WorkflowFields workflow="transcribe" />
      <FileField name="recording" label="Recording" upload />
      <SubmitButton pending={pending}>Transcribe</SubmitButton>
    </Form>
  );
}
