---
"@alexkroman1/aai-ui": patch
---

Add `isFileValue(value)`, the guard a page narrows a `<FileField>`'s entry in
`FormValues` with instead of casting it to `FileValue`. Tag `ControlsProps`,
`MarkdownProps` and `MessageListProps` `@input`.
