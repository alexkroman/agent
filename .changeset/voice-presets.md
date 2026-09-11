---
"@alexkroman1/aai": minor
---

Four opt-in prompt presets an agent turns on by name: `agent({ voicePresets: [...] })`.

Each is one section of prompt text, composed after the framework's own voice
sections and before the author's instructions, and each is paid for on EVERY
model request — which is why this is a list of four names rather than one
switch. Measured with `tiktoken` (o200k, within 5 tokens on cl100k) and banded
in `voice-presets.test.ts`:

- `echoVerification` (~190 tokens) — critical values are read back and
  confirmed before they are acted on, grouped into one read-back, with an
  uncommon name spelled out.
- `smartMatching` (~200) — the caller is believed through a transcription
  error, in all three places it matters: a CONFIRMATION ("Are you Brandon?"
  answered "Yes, this is Brendon" is a yes), a SPELLING (the letters REPLACE
  what was heard, and every later lookup uses the spelled form), and a NAME
  LOOKUP that misses (a transcription to doubt, not a missing record — retry
  the phonetic neighbours before re-asking or handing off). ~200 rather than
  the ~110 the toggle it ports costs, because a measured tau2-bench retail
  baseline showed the conversational half alone does not reach the failure: a
  mis-transcribed name went into a lookup, the miss was treated as
  authoritative, and the agent escalated to a human. Its illustrative names
  are deliberately ones the benchmark corpus does not contain — an example
  that names a benchmark entity stops that case from measuring anything.
- `speechNormalization` (~920) — numbers, money, dates, times, phone numbers,
  emails and addresses written as spoken words. The expensive one, and the
  PROMPT layer only: `spokenMoney`/`spokenDate`/`spokenTime` already do this
  in code for the agent's own data.
- `natoAlphabet` (~190) — spelling with "That's B as in Bravo, 7, K as in
  Kilo, 2 — correct?", all 26 words listed rather than named.

Two of them deliberately contradict the measured defaults in `## LISTENING`
and `## SPEAKING`, which is why they are opt-in and why the emitted block
carries one precedence line above it. Order is canonical, a repeat is emitted
once, and an agent that declares none sends the byte-identical prompt it sent
before the field existed. A `workflowApp()` refuses the field by name — it
makes no model request.

`VOICE_PRESETS` (root export) is the shipped text, for reading and asserting
on. `aai:agent` is epoch 4 and `aai:testing` epoch 4 (collateral), both with
epoch 3 retained.
