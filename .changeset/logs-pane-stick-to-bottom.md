---
"aai-studio-client": patch
---

Studio Logs pane: follow-the-bottom now runs on `use-stick-to-bottom` — already a dependency of this package, and the component the chat transcript mounts — instead of a hand-rolled scroll handler. The old version re-pinned only when a line arrived, so a line that wrapped, or a monospace font that finished loading, grew the content under a pane that thought it was already at the bottom.
