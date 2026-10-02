---
"@alexkroman1/aai-runtime": patch
---

Fix three cancel races found by new property tests. A client `reset` no longer
lets an aborted tool call's result settle into the fresh conversation (its
history and the `tool.completed` log). In the AssemblyAI TTS adapter, a barge-in
after a reply had finished no longer drops the is_final/FlushDone pairing, which
let the old turn's trailing FlushDone end the next reply before its last segment
played; and a turn begun under an unanswered `Cancel` now ends when the
acknowledgement deadline drops the socket, instead of never emitting `done`.
