---
"aai-studio-client": patch
"aai-studio-server": patch
---

The studio's Workflows card reads the SDK's `WorkflowRunSnapshot`, `WorkflowSummary` and `isTerminal` instead of a local restatement, so a field added to a run snapshot reaches the card and a new run status cannot be silently classified as live. `errorText` unwraps message-bearing non-`Error` rejections through the SDK's `errorMessage`. (aai-studio-server is named so the client's `dist/` actually ships — it has no release of its own.)
