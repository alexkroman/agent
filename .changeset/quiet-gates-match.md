---
"@alexkroman1/aai": minor
"aai-templates": minor
---

Publish `dialogRefusalPattern` and `expectDialogRefused` from `@alexkroman1/aai/testing`. A `dialog()` gate refuses an out-of-state call with one sentence, and seven templates' specs had pinned that sentence by hand — two of them re-deriving the JSON escaping an eval reads it through — so rewording the model-facing half of the gate would have broken eight suites that never imported it. The sentence is built in one module now, the pattern is derived from it, and `expectDialogRefused` is the mirror of `expectDialogOk`: it throws when the gate did NOT hold, naming where the dialog landed, where the `isToolFailure` + `if` shape it replaces let a success through with every assertion after the guard skipped.

The templates also stop re-deriving five helpers the SDK already exports: `formatMoney` (travel-concierge's page), `spokenDigits` (retail's zip lookup), `plural` (dispatch-center's "protocol(s)"), `countWords` (pipeline-simple's eval) and `toolNames` (personal-finance's eval).
