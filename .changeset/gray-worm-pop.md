---
"@alexkroman1/aai-ui": patch
---

Fix the sync-mode microphone going permanently deaf on its first flush: the capture worklet sized its next batch buffer from a view whose ArrayBuffer had just been transferred (and so detached to length 0), which wedged the audio render thread in an infinite loop posting empty chunks. No utterance was ever endpointed, so a sync agent never sent a turn. Also bound the sync session's replayed history to the server's own window and release the microphone when the view unmounts mid-startup.
