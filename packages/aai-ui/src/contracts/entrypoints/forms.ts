// Copyright 2026 the AAI authors. MIT license.
/**
 * Capability contract: `forms`.
 *
 * A workflow app's front door: the form whose values come off the DOM already
 * typed, its field components, the one that renders itself from a workflow's
 * own input schema, and the RULE that last one applies — `fieldKindFor`, which
 * says which of these controls a schema property becomes. The rule is here
 * rather than under `components` because what it names is a FIELD: adding a
 * control to `<WorkflowFields>` widens `WorkflowFieldKind`, so the two move
 * together and one epoch covers both halves of the same change.
 *
 * Re-exported from `@alexkroman1/aai-ui`. This file is not shipped and nothing
 * imports it — it exists so `pnpm check:api-contracts` can extract a report
 * for this capability alone, hash it, and hold it to a committed epoch. See
 * `scripts/api-contracts.mjs`.
 */

export {
  CheckboxField,
  Field,
  type FieldShell,
  FileField,
  type FileReadMode,
  type FileValue,
  Form,
  type FormProps,
  type FormValues,
  fieldKindFor,
  NumberField,
  SelectField,
  SubmitButton,
  TextAreaField,
  TextField,
  type WorkflowFieldKind,
  WorkflowFields,
} from "../../index.ts";
