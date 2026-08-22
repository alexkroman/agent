// Copyright 2026 the AAI authors. MIT license.

/** @jsxImportSource react */

/**
 * Frozen authoring example: `aai-ui:forms` epoch 4.
 *
 * See `../client/v1.tsx` for what "frozen" obliges and why the imports are
 * relative.
 *
 * Epoch 4 WIDENED `<SubmitButton>`: it takes `variant` and every `<button>`
 * attribute except `type` and `disabled`, which the component owns because it
 * sets both from `pending`. It was the only control here accepting neither,
 * so `aria-label` on an icon-only submit was a type error on the one button a
 * workflow-app form has. Pure widening, so epoch 3 is retained and
 * `./v3.tsx` compiles unchanged; this file covers only what is new.
 */

import {
  Form,
  type FormValues,
  SubmitButton,
  TextField,
  useWorkflowSubmit,
} from "../../../index.ts";

export function DigestForm() {
  const { submit, pending } = useWorkflowSubmit("digest");
  return (
    <Form onSubmit={(values: FormValues) => submit(values)}>
      <TextField name="url" label="Link" required />
      {/* `variant`, and native attributes, on the form's own submit. */}
      <SubmitButton
        pending={pending}
        variant="secondary"
        size="lg"
        aria-label="Summarize the link"
        id="digest-submit"
        title="Summarize"
        onClick={() => undefined}
      >
        Summarize
      </SubmitButton>
    </Form>
  );
}
