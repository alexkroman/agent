---
"@alexkroman1/aai": patch
---

Add an always-on `invariant()` oracle, and classify seven environmental errors that answered 500.

`@alexkroman1/aai/internal` now publishes `invariant(condition, name, detail?)`. It throws a
named `InvariantViolation` rather than logging, and its `detail` thunk runs only on the failing
path, so a violation reports the actual numbers for free. Two properties are stated against it:
a session event page cannot contain events its own `tail` says do not exist, and the terms a
boot capacity line names must compose the total it prints.

The workflow API's error classification is now swept rather than extended one incident at a
time: every environmental code a Node service can meet must be mapped to a status or declared,
with a reason, as one a 500 is right for. That found eight unclassified codes. `ENETDOWN`,
`ENOTCONN` and `EAGAIN` are ordinary transport failures and now answer 503. `EMFILE`, `ENFILE`,
`ENOBUFS` and `ENOMEM` are a fourth condition the table had no entry for — this process out of a
local resource, neither the database being full nor the network being unreachable — and answer
503 with their own message, checked before the transport entry because a descriptor limit
surfaces on a socket operation.

Also fixes a boot line that overstated the platform's own database claim by the size of the
unpooled admin pool: it said `platform budget=42 (plus 12 …)` where the 12 was already inside
the 42, on the configuration production runs.
