---
"@alexkroman1/aai": patch
---

The default voice prompt now covers three written forms the TTS voice misreads
in real calls: a ZIP inside an address is hyphenated like any other identifier
and the state is written as a word ("Chicago, Illinois, 6-0-6-1-2", never "IL
60612"); a unit glued to a number is written as its word ("24 megapixels", not
"24MP", which is read "twenty-four M P"); and an acronym said as separate
letters is hyphenated ("R-M-A", which written whole is read "room A").
