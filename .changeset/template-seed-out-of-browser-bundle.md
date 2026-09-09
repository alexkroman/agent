---
"aai-templates": patch
"@alexkroman1/aai-cli": patch
---

Keep two templates' seed data out of their browser bundles.

`hotel-reception-agent` and `technical-support-agent` each shipped their seeded
data to the page. Measured on the built client bundle before this change: all 43
of `hotel-reception-agent/seed.ts`'s guest phone numbers were present, and so was
the full text of every one of `technical-support-agent`'s ten knowledge-base
articles. Both are the failure `retail-orders-agent` already documents and
avoids, and the one `template-layout-gate.test.ts` names as the reason for its
single exemption — `shared.ts` is the module `client.tsx` imports for its view,
so anything it reaches is in the page.

The two reach it by different routes, which is why neither was caught by the
other's precaution. A slot holds its factory as a LIVE reference, so nothing
tree-shakes it: `hotelSlot` sat in `shared.ts` and its `createHotelState` called
`seedHotel`, dragging an 18.5 KB `seed.ts` and `records.ts` behind it. The
factory, the slot and `deskProjection` move to a new `session.ts`; `shared.ts`
gains a seed-free `emptyHotelState()` and `client.tsx` derives its pre-first-call
frame with `deskView(emptyHotelState())`, the `useAgentState` overload
`retail-orders-agent` uses for the same reason. `technical-support-agent`'s index
is instead built at MODULE SCOPE — `for (const doc of DOCS)` runs on import — so
touching that file at all pulled every article; the knowledge base and its
retriever move to a new `knowledge.ts`, and `PRODUCT` stays behind as a NAMED
import off the same JSON so the page still derives its tab title without taking
`docs` with it.

`applicant-screening-agent` was checked and is NOT affected: its `emptyHiring`
factory never reaches `LEADS`, and 0 of 24 `leads.json` strings appear in its
bundle. Verified by rebuilding both clients — 0/43 phone numbers and 0/20 article
fragments, with the intended product string retained, and bundles 12.6 KB and
4.9 KB smaller.

`SLOT_ELSEWHERE` in the layout gate gains its second entry, which is what that
deny-list's own failure message asks for; the prose in both templates and the
package guide that named the moved symbols moves with them.
