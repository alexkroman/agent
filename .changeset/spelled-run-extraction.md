---
"@alexkroman1/aai": patch
"@alexkroman1/aai-runtime": patch
---

Fix the two defects a graded run found in the spelled-run extractor.

The recognizer-joined fix is live and producing annotations — 7 on one
tau2-bench retail arm against a baseline of 0 — and **one of the seven was
right**. All seven utterances are now fixtures in `utils.test.ts`, verbatim off
the wire, because two of the six failures were in shapes nobody would have
invented.

- **A run that ENDED A SENTENCE never exploded.** The trailing-punctuation
  strip ran inside the walk, on a word `explodeSpelledWord` had already
  declined to split, so `"…M-E-I and last name A-H-M-E-D."` yielded `mei`
  alone and `"E-X-A-M-P-L-E dot C-O-M."` yielded `example.` — the surname and
  the TLD, which are exactly the halves a lookup fails on. The strip happens
  before the split now. Note what it was NOT: `and`, `last name` and `dot` all
  worked, and the same two utterances without the full stop were always
  correct, so the diagnosis "the separators are wrong" would have fixed
  nothing.
- **A run spanning two names asserted a word that does not exist.**
  `"My name Sophia Liz, S-O-F-I-A-L-I"` assembles `sofiali`, which matches no
  name — and a nonsense token asserted alone reads as authoritative, so the
  model dropped it and sent the misheard "Sophia". The boundary is not in the
  letters and no threshold recovers it (`example` is as long as `sofiali`), so
  `spelledAloudNote` now reports the LETTERS beside the token for a single run
  of pure letters — `S-O-F-I-A-L-I = sofiali (may be more than one word)` — and
  leaves the split to the model, which has "Sophia Liz" in the same utterance.
  Several runs keep the old form (`yusuf, rossi`): the caller's own pauses gave
  the boundaries, and that is the string measured to produce the right tool
  call. A run carrying a separator or a digit is an identifier and keeps it too.
- `assembleSpelledRuns` returns `readonly SpelledRun[]` rather than strings, and
  the annotation's WORDING moved to `spelledAloudNote` beside it — what the note
  may claim is a property of the run, not of the call site.

Deliberately NOT fixed here: a seventh annotation faithfully read `fofia` from
a spelling the recognizer itself misheard as `F-O-F-I-A`. That is the extractor
working correctly on bad input, and a plausibility filter inside it would be an
extractor second-guessing its own input; the guard belongs where the "the
letters REPLACE what you heard" instruction lives.
