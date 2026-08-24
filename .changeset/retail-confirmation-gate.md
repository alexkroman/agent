---
"aai-templates": patch
---

Retail template: the "confirm every change out loud" policy is a dialog gate now, not prose. The seven changing tools stage a validated, priced change and return the sentence to read back; `confirm_change` — gated on a new `serving.awaitingConfirmation` state and the only tool that writes to the store — applies it, and `cancel_change` drops it. Departing from tau2's fifteen-tool set also lets an exchange record the pairing it priced rather than two independently sorted lists.
