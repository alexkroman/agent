---
"@alexkroman1/aai": patch
---

Tag `PlaceCallOptions` `@input`: an author builds it and the SDK only reads it,
so the API contract gate now treats a member becoming optional, or a union in it
widening, as compatible. No signature changes.
