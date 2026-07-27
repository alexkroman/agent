---
"@alexkroman1/aai": patch
---

Cut per-frame work on the realtime audio path: the capture worklet batches PCM16 into ~100ms chunks (one allocation and postMessage per chunk instead of per 128-sample render quantum) and writes via Int16Array instead of per-sample DataView; the playback worklet decodes with an aligned Int16Array view and increment-and-wrap ring indexing instead of a modulo and DataView call per sample. STT partial word checks now scan without allocating and stop at the barge-in threshold. MessageList memoizes the interleaved backlog and memoizes MessageBubble/ToolCallBlock so live captions no longer re-render every message.
