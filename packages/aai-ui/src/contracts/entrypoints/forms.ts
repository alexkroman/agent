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

// Added with the typed-form wave: what `<FileField as="namedText">` and
// `<TextAreaField split>` contribute (`NamedTextValue`, `FileValueShape`,
// `TextSplitMode`), `<WorkflowFields>`'s props and render map, and the app-def
// helpers its `name` prop is typed by (`WorkflowAppLike`, `WorkflowsOf`,
// `WorkflowNameOf`) — shared with the workflow hooks, owned here beside the
// component that renders the form so `workflow` stays under its export budget.
export {
  CheckboxField,
  Field,
  type FieldShell,
  FileField,
  type FileReadMode,
  type FileValue,
  type FileValueShape,
  Form,
  type FormProps,
  type FormValues,
  fieldKindFor,
  isFileValue,
  type NamedTextValue,
  NumberField,
  SelectField,
  SubmitButton,
  TextAreaField,
  TextField,
  type TextSplitMode,
  type WorkflowAppLike,
  type WorkflowFieldKind,
  type WorkflowFieldRender,
  WorkflowFields,
  type WorkflowFieldsProps,
  type WorkflowNameOf,
  type WorkflowsOf,
} from "../../index.ts";
