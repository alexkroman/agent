---
"@alexkroman1/aai": minor
---

Tell a recovery phrase apart from a reply on the wire, so it stays out of history. `agent-transcript.committed` carries an optional `recovery` (`"turn-failed"` | `"session-failed"`), set on the two phrases the pipeline transport speaks when the model cannot. Both are still spoken and still captioned — the caller heard them — and they no longer enter the conversation: they used to reach `ctx.messages` on the same call and the model's context again on every reconnect, which is how an agent learns that its own replies open with apologies. An event with no `recovery` is an ordinary reply, so an older reader and an older log are unaffected.
