---
"@alexkroman1/aai": minor
---

Type the dialog and slot authoring surface honestly, and let a dialog be declared as a plain state map.

- `DialogToolDef.sendFrom` takes `Exclude<NoInfer<R>, ToolFailure>`. `R` was inferred from two positions, so whether the parameter meant anything depended on whether `sendFrom` was written above or below `execute` — above it, `R` was `unknown` and the narrowing silently stopped checking anything.
- `dialog.tool`, `slot.tool` and `slot.updateTool` return the result type their bodies actually produce (`ToolDef<P, Promise<DialogToolResult<R> | ToolFailure>>` and `ToolDef<P, R>`) instead of erasing it to `unknown`, so `InferToolOutput` works for the tools an agent most often writes.
- `dialog(key, spec)` accepts a plain `{ initial, states }` map with `instruction`, `on`, `final`, `initial` and nested `states`. It builds the same XState machine, so a persisted dialog resumes across the change; the event union is synthesized from the `on` keys, and `instruction` is a typed field rather than an untyped `meta` lookup that failed silently when misspelled.
