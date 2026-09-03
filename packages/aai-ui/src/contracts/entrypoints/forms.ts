// Copyright 2026 the AAI authors. MIT license.
/**
 * Capability contract: `forms`.
 *
 * A workflow app's front door: the form whose values come off the DOM already
 * typed, its field components, and the one that renders itself from a
 * workflow's own input schema.
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
} from "../../index.ts";
