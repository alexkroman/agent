---
"@alexkroman1/aai": minor
---

Add `responseErrorMessage(res, label?)` to `@alexkroman1/aai/utils`: read a failed `Response`'s `{ error }` sentence — the shape every route this SDK serves answers with — falling back to the status plus a capped preview of any other body. Four callers had hand-written it, and none of the four agreed: two never unwrapped `{ error }` at all, and one dropped the body whenever it was valid JSON that was not that shape.
