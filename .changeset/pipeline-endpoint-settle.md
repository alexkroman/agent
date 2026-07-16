---
"@alexkroman1/aai": patch
---

Pipeline mode turn-taking overhaul so the agent stops cutting itself off and stops dropping the caller mid-sentence (root causes of a "the agent went silent" failure in tau2 voice runs):

- **Endpoint settle window** (`endpointSettleMs`, default 700ms): disfluent, in-the-wild speech now commits as one turn. Previously every STT `final` started a turn immediately, so a mid-utterance pause, self-correction, or false start ("find a two-bedroom in Austin… actually make it Dallas") fired a turn on the pre-correction fragment — and a second `final` then barged in on that turn, producing wrong tool calls, duplicate calls, and responses that began before the speaker finished. Follow-on finals/partials inside the window are aggregated into a single utterance. A clearly-complete final (terminal punctuation, no trailing continuation cue) commits immediately, so clean requests pay no added latency. Set `endpointSettleMs: 0` to disable.
- **Sub-threshold finals are no longer dropped.** A short final spoken while the agent is talking used to be discarded as a "backchannel," silently losing real short answers (a "yes", a ZIP). It is now transcribed and answered as a deferred turn once the current reply finishes.
- **`DEFAULT_MIN_BARGE_IN_WORDS` raised from 1 to 2** so a single word — a backchannel, a cough transcribed as one token, or the leading fragment of the caller's own turn — no longer cuts the agent off mid-sentence. (Combined with the previous change, sub-threshold speech is deferred, not lost.)
- **Voice output rule** added: when the caller spells a name/email/ID or reads out digits, the agent confirms briefly instead of reading the whole thing back letter by letter — long readbacks were slow and invited interruptions.
