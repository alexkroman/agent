---
"@alexkroman1/aai": patch
---

Reference and doc fixes across `/protocol`, `/manifest`, `/runtime`, `/step`,
`/step-errors` and `/workflow-api`.

- `/protocol`: `ServerMessage`/`ServerMessageSchema` and
  `ClientMessage`/`ClientMessageSchema` are now re-export aliases of
  `SessionEvent*`/`SessionCommand*` rather than separate declarations. The names
  and their runtime values are unchanged; the reference no longer documents the
  same two unions twice under two names each.
- `/manifest`: `assertProviderTriple` is no longer exported. One overload
  carried `@internal` and the rest did not, so it was listed as a published
  export while the reference denied it existed; every caller is inside the SDK.
- `/runtime`: `SessionWebSocket`, `TransportEventBody`, `UploadReader`,
  `SessionStateBackend` and `SessionCore` are documented rather than hidden —
  each is already named by a public runtime signature, so the reference could
  not be used to satisfy one. `WorkflowApiOptions` is now `@internal`, matching
  the `createWorkflowApi` it configures.
- `/step`: the doc comments that pointed at unpublished module prose now carry
  it, and `stepSpeak`, `readUpload`, `stepTranscribeSync` and the async
  transcribe trio gained examples. `/step-errors`' "why its own subpath"
  rationale is restated against `/step`, the sibling it actually has.
- `SessionErrorCode` documents its eight values and how `fatal` relates to them.
