---
"@alexkroman1/aai-ui": major
---

The workflow hooks take the workflow DEFINITION as their type parameter, not its output type — which types `submit(input)` as well. Migration is one token per call site: `useWorkflowSubmit<Digest>("digest")` becomes `useWorkflowSubmit<typeof digest>("digest")`. `submitForm` is the door for a `<Form>`'s DOM-scraped values.
