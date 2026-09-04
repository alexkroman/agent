---
"@alexkroman1/aai-ui": minor
"aai-studio-client": patch
"aai-studio-server": patch
---

aai-ui: publish the three behaviour rules the studio front-end had duplicated. `useFlash` and `useCopy` replace three hand-rolled flashes — including the one inside the URL chips, which swallowed a refused clipboard write so the button did nothing visible; a refusal now reports `Failed`. `fieldKindFor` is `<WorkflowFields>`'s own control-selection rule, extracted out of `SchemaField` so there is one decision and published so a reader documenting the form-to-JSON correspondence asks it rather than mirroring the switch. The studio's chat transcript and Logs pane also drop `use-stick-to-bottom` for `<AutoScroll>`, this package's one owner of that effect.
