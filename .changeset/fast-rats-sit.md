---
"@alexkroman1/aai": patch
---

Finish the direct upload path on a RESUME, instead of silently falling back to sending bytes to the agent.

A resume re-declares an id the store already holds, which is answered 409 — and a 409 carries no body, so the client had nowhere to read `directParts` from and read nothing. Every resumed upload therefore abandoned the direct path and sent each remaining window's bytes THROUGH the agent: it works, it is the topology the direct path exists to avoid, and it is the one the platform's forward measures to decide whether a guest has stalled. `GET …/uploads/:id/info` now answers the same two capability fields the claim does, which the resume already fetches, so this costs no extra round trip.

Also: the sweep script writes its minted upload ids unconditionally rather than only under `--json`. Those uploads are permanent and nothing reclaims them, so the ids are the only handle a cleanup could have.
