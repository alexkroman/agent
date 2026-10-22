---
"@alexkroman1/aai-runtime": patch
---

Transcript logging is off in production. A contained guest
(`AAI_SANDBOX_CONTAINED=1`) or a process under `NODE_ENV=production` no longer
writes what was said to its log, whatever `AAI_DEBUG` says: the STT turn trace,
the committed-turn trace, the quiet-final and barge-in-veto lines, a tool's
spoken line and the S2S `tool.call` payload carry a character count
(`textChars`, `transcriptChars`) in place of the text. Under `aai dev` and in
tests the verbatim trace is unchanged.
