---
"@alexkroman1/aai-ui": minor
---

Name what `submit()` takes. `SubmitInputOf<D>` and `WorkflowInputOf` are on the barrel: the first is in both submit hooks' return type and had nowhere to click, the second was the missing half of a pair whose `WorkflowOutputOf` was already re-exported here — so a page typing a form value reached past this package for one name. `SubmitOutputOf` came off in the same change; it was `WorkflowOutputOf` spelled a second way.
