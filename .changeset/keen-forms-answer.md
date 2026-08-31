---
"aai-studio-server": patch
---

Studio API pane: map every form control to the JSON that sets it, and drop the
`/workflows/*` route table.

A workflow app's front door is a form, and the pane documented the form's
destination while leaving the correspondence to inference. The new "Every form
field, over HTTP" card lists each control (`<TextField>`, `<TextAreaField>`,
`<NumberField>`, `<SelectField>`, `<CheckboxField>`, `<FileField upload>`, plus
the nested shapes that get no generated control), the JSON each contributes to
the run input, and the one that needs a second call first — with each row
carrying this agent's own property and sampled value where it declares one. The
annotated SDK/`curl` pair beside it expands the same run body one property per
line, labelled by the control it is.

The route table now renders only on the public API page, whose reader has a slug
and an integration to write. The studio pane has a Workflows tab beside it, so
the openness sentence moves into the run card rather than going with the rows.
