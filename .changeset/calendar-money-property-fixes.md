---
"@alexkroman1/aai": patch
---

Four fixes the new property tests found, all in code that shipped an hour ago.

- **`addDays`, `daysBetween` and `spokenDate` answered in the 1900s for any year
  under 100.** `Date.UTC(1, 0, 1)` is 1901 — legacy two-digit-year behaviour —
  and the correction had landed in `isoDateParts` alone, so `isIsoDate` accepted
  `0001-01-01` while every function that did arithmetic on it built its own
  uncorrected `Date.UTC`. All four now share one `utcDate(y, m, d)`, which also
  fixes the ordering trap in the first version of that helper: correcting the
  year AFTER a day overflow has rolled it turns `utcDate(99, 12, 32)` into
  `0099-01-01`, a full year wrong.
- **`addDays` returned a non-date past year 9999.** `toISOString` switches to
  the expanded form (`+010000-01-01T…`) there, so a 10-character slice answered
  `"+010000-01"`. It throws a `RangeError` naming the range instead.
- **`roundMoney` was not idempotent on `-0`.** `(-5e-324).toFixed(2)` is
  `"-0.00"` while `(-0).toFixed(2)` is `"0.00"`, so rounding twice differed from
  rounding once — the property a caller relies on when rounding at every step of
  a total. It normalizes `-0` to `0`.

`resolveOne` also gains a template adopter: `briefing-desk`'s `findByAngle` took
the FIRST board angle whose text overlapped the caller's phrase in either
direction, so "lead times" picked between "install lead times" and "battery lead
times" by board order and answered `undefined` for both "nothing matches" and
"several do". It lists the candidates now.
