---
"@alexkroman1/aai": patch
---

The default voice prompt's mis-hearing ladder now tries a SPOKEN name's other
common spellings (first name and surname alike) once the exact spelling has
failed. Letter confusions never turn one common spelling of a name into
another, so a lookup on the heard spelling failed on every retry and the call
never reached the account.
