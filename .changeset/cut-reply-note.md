---
"@alexkroman1/aai-runtime": patch
---

When the caller's speech cuts a reply and then commits a turn, the model's copy
of that turn now says where the reply stopped being heard and asks it to finish
what was cut unless the caller's words answer, redirect or stop it. Previously
such a turn held only `… [interrupted]`, and an acknowledgement ("uh-huh") — 17%
of barge-ins on a tau2 retail run — lost the rest of the reply, including any
question in it. The model decides; nothing reads the caller's words in code. The
client transcript and the conversation record are unchanged.
