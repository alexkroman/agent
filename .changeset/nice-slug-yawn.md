---
"@alexkroman1/aai-ui": patch
---

Stop a workflow form submitting before the fields it validates exist.

`<Form>` leans entirely on native validation — a `required` field is what blocks an empty submit — and `<WorkflowFields>` renders nothing until the workflow listing lands, so a click in that window submitted a form holding only its button. The browser had nothing to check, the payload was `{}`, and the agent answered with a schema complaint about a field the person had not been shown yet: `Invalid input for workflow "transcribeStream": recording: Invalid input`.

A field set that fetches its own declaration now tells the enclosing form so, and the form disables the fieldset its submit button sits in until the fields arrive — the same fieldset that already covers an in-flight submit. The submit handler is guarded too, since Enter in a text field submits without a click. A hand-written form, and any `<Form>` used outside this package, is unaffected: no such child means nothing pending.
