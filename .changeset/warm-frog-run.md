---
"@alexkroman1/aai": patch
---

Order `reply_done` behind the audio pacer's queue, like `audio_done`. The pacer holds a reply's audio back to a bounded lead, so a reply that finished host-side still has seconds of speech queued — and `reply_done` overtook it, telling the client the turn was over mid-reply. A client that closes the turn's books on that boundary attributes the rest of the audio to the next reply: in the tau2 voice harness every agent turn reached the simulated caller as speech carrying no transcript, and the caller hung up on what sounded like dead air.
